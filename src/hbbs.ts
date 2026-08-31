import { DurableObject } from 'cloudflare:workers'
import * as rendezvous from './hbbs-rendezvous'
import type { WorkerEnv } from './env'
import {
	bytesToBase64,
	isValidPeerId,
	MAX_ONLINE_QUERY_PEERS,
	messageByteLength,
	normalizeRelayBaseUrl,
	packOnlineStates,
	readLocationHint,
	readPositiveInteger,
	timingSafeSecretEqual,
} from './protocol-utils'
import {
	closeSocket,
	isOpen,
	isWebSocketUpgrade,
	upgradeRequiredResponse,
} from './websocket'

type RelayMessage = string | ArrayBuffer

type RendezvousPayload =
	| { registerPkResponse: rendezvous.RegisterPkResponse }
	| { punchHoleResponse: rendezvous.PunchHoleResponse }
	| { requestRelay: rendezvous.RequestRelay }
	| { relayResponse: rendezvous.RelayResponse }
	| { onlineResponse: rendezvous.OnlineResponse }

type RelayRole = 'pending' | 'initiator' | 'acceptor'

interface RelaySocketAttachment {
	role: RelayRole
	connectedAt: number
}

interface BufferedWebSocket extends WebSocket {
	readonly bufferedAmount?: number
}

interface HbbsSession {
	ip: string
	id: string
	uuid: string
	pk: string
	registeredAt: number
	socket: WebSocket
}

interface PendingSocketAttachment {
	kind: 'pending'
	connectedAt: number
}

interface SessionSocketAttachment {
	kind: 'session'
	ip: string
	id: string
	uuid: string
	pk: string
	registeredAt: number
}

type HbbsSocketAttachment = PendingSocketAttachment | SessionSocketAttachment

const MAX_RENDEZVOUS_MESSAGE_BYTES = 64 * 1024
const DEFAULT_RELAY_QUEUE_MESSAGES = 64
const DEFAULT_RELAY_QUEUE_BYTES = 4 * 1024 * 1024
// Keep the per-relay send buffer bounded so one slow viewer cannot consume
// memory that should remain available for other concurrent relay sessions.
const DEFAULT_RELAY_BUFFERED_BYTES = 2 * 1024 * 1024
const DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_PENDING_CONNECTIONS = 256
const PENDING_CONNECTION_TIMEOUT_MS = 30_000
const ORIGIN_STORAGE_KEY = 'hbbs.origin'

function logEvent(message: string, fields: Record<string, string | number | boolean> = {}): void {
	console.log(JSON.stringify({ message, ...fields }))
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null
		? value as Record<string, unknown>
		: null
}

function readRelayAttachment(socket: WebSocket): RelaySocketAttachment | null {
	const record = asRecord(socket.deserializeAttachment() as unknown)
	if (!record) {
		return null
	}

	const role = record.role
	const connectedAt = record.connectedAt
	if ((role !== 'pending' && role !== 'initiator' && role !== 'acceptor')
		|| typeof connectedAt !== 'number'
		|| !Number.isFinite(connectedAt)) {
		return null
	}

	return { role, connectedAt }
}

function readHbbsAttachment(socket: WebSocket): HbbsSocketAttachment | null {
	const record = asRecord(socket.deserializeAttachment() as unknown)
	if (!record) {
		return null
	}

	if (record.kind === 'pending'
		&& typeof record.connectedAt === 'number'
		&& Number.isFinite(record.connectedAt)) {
		return {
			kind: 'pending',
			connectedAt: record.connectedAt,
		}
	}

	if (record.kind === 'session'
		&& typeof record.ip === 'string'
		&& typeof record.id === 'string'
		&& typeof record.uuid === 'string'
		&& typeof record.pk === 'string'
		&& typeof record.registeredAt === 'number') {
		return {
			kind: 'session',
			ip: record.ip,
			id: record.id,
			uuid: record.uuid,
			pk: record.pk,
			registeredAt: Number.isFinite(record.registeredAt)
				? record.registeredAt
				: 0,
		}
	}

	// Read attachments written by versions before the explicit `kind` field.
	if (typeof record.id === 'string' && typeof record.uuid === 'string') {
		return {
			kind: 'session',
			ip: typeof record.ip === 'string' ? record.ip : '',
			id: record.id,
			uuid: record.uuid,
			pk: typeof record.pk === 'string' ? record.pk : '',
			registeredAt: typeof record.registeredAt === 'number'
				&& Number.isFinite(record.registeredAt)
				? record.registeredAt
				: 0,
		}
	}

	return null
}

function identityMatches(session: HbbsSession, uuid: string): boolean {
	if (session.uuid && uuid && session.uuid !== uuid) {
		return false
	}
	return true
}

function safeCloseCode(code: number): number {
	return code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005
		&& code !== 1006 && code !== 1015
		? code
		: 1000
}

export class Hbbr extends DurableObject<WorkerEnv> {
	private initiator: WebSocket | undefined
	private acceptor: WebSocket | undefined
	private pendingFromInitiator: RelayMessage[] = []
	private pendingFromAcceptor: RelayMessage[] = []
	private pendingFromInitiatorBytes = 0
	private pendingFromAcceptorBytes = 0
	private relayHandshakeQueue: Promise<void> = Promise.resolve()

	constructor(ctx: DurableObjectState, env: WorkerEnv) {
		super(ctx, env)

		for (const socket of ctx.getWebSockets()) {
			const attachment = readRelayAttachment(socket)
			if (!attachment) {
				closeSocket(socket, 4002, 'invalid relay state')
				continue
			}

			if (attachment.role === 'initiator' && !this.initiator) {
				this.initiator = socket
				continue
			}
			if (attachment.role === 'acceptor' && !this.acceptor) {
				this.acceptor = socket
				continue
			}

			// More than one socket with the same role, or a third socket, is not a
			// valid relay session.
			if (attachment.role !== 'pending') {
				closeSocket(socket, 4002, 'relay session is full')
			}
		}
	}

	async warmup(): Promise<void> {
		// Calling this RPC instantiates the DO before the clients dial its WebSocket.
	}

	async fetch(req: Request): Promise<Response> {
		if (!isWebSocketUpgrade(req)) {
			return upgradeRequiredResponse()
		}

		this.pruneClosedSockets()
		const activeSockets = this.ctx.getWebSockets().filter((socket) => socket.readyState < 2)
		if (activeSockets.length >= 2) {
			return new Response('Relay session is full', { status: 503 })
		}

		const webSocketPair = new WebSocketPair()
		const [client, server] = Object.values(webSocketPair)
		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({
			role: 'pending',
			connectedAt: Date.now(),
		} satisfies RelaySocketAttachment)
		this.ctx.waitUntil(this.reconcileHandshakeAlarm().catch((error) => {
			logEvent('failed to schedule relay handshake cleanup', {
				error: error instanceof Error ? error.message : String(error),
			})
		}))

		return new Response(null, {
			status: 101,
			webSocket: client,
		})
	}

	async webSocketMessage(socket: WebSocket, message: RelayMessage): Promise<void> {
		if (this.initiator === socket) {
			this.forwardMessage(
				message,
				this.acceptor,
				this.pendingFromInitiator,
				'initiator',
			)
			return
		}
		if (this.acceptor === socket) {
			this.forwardMessage(
				message,
				this.initiator,
				this.pendingFromAcceptor,
				'acceptor',
			)
			return
		}

		if (!(message instanceof ArrayBuffer)) {
			closeSocket(socket, 1003, 'binary relay handshake required')
			return
		}
		if (message.byteLength > MAX_RENDEZVOUS_MESSAGE_BYTES) {
			closeSocket(socket, 1009, 'relay handshake is too large')
			return
		}

		let msg: rendezvous.RendezvousMessage
		try {
			msg = rendezvous.RendezvousMessage.fromBinary(new Uint8Array(message))
		} catch (error) {
			logEvent('invalid relay handshake', {
				error: error instanceof Error ? error.message : String(error),
			})
			closeSocket(socket, 1003, 'invalid relay handshake')
			return
		}

		if (msg.union?.oneofKind !== 'requestRelay') {
			closeSocket(socket, 1003, 'unsupported relay handshake')
			return
		}
		const requestRelay = msg.union.requestRelay

		// Serialize the two role assignments so both clients cannot become the
		// initiator while the async secret comparison is in progress.
		const next = this.relayHandshakeQueue.then(() =>
			this.handleRequestRelay(requestRelay, socket))
		this.relayHandshakeQueue = next.catch(() => undefined)
		try {
			await next
		} catch (error) {
			logEvent('relay handshake failed unexpectedly', {
				error: error instanceof Error ? error.message : String(error),
			})
			this.closeRelay(1011, 'relay handshake failed')
		}
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		if (ws === this.initiator || ws === this.acceptor) {
			this.closeRelay(safeCloseCode(code), 'peer closed')
			return
		}

		await this.reconcileHandshakeAlarm()
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		logEvent('relay websocket error', {
			role: readRelayAttachment(ws)?.role ?? 'pending',
			error: error instanceof Error ? error.message : String(error),
		})
		if (ws === this.initiator || ws === this.acceptor) {
			this.closeRelay(1011, 'relay socket error')
			return
		}
		closeSocket(ws, 1011, 'relay socket error')
		await this.reconcileHandshakeAlarm()
	}

	async alarm(): Promise<void> {
		if (isOpen(this.initiator) && isOpen(this.acceptor)) {
			await this.ctx.storage.deleteAlarm()
			return
		}

		this.closeRelay(4008, 'relay handshake timeout')
	}

	private get maxQueueMessages(): number {
		return readPositiveInteger(
			this.env.MAX_RELAY_QUEUE_MESSAGES,
			DEFAULT_RELAY_QUEUE_MESSAGES,
			1,
			1024,
		)
	}

	private get maxQueueBytes(): number {
		return readPositiveInteger(
			this.env.MAX_RELAY_QUEUE_BYTES,
			DEFAULT_RELAY_QUEUE_BYTES,
			64 * 1024,
			64 * 1024 * 1024,
		)
	}

	private get maxBufferedBytes(): number {
		return readPositiveInteger(
			this.env.MAX_RELAY_BUFFERED_BYTES,
			DEFAULT_RELAY_BUFFERED_BYTES,
			64 * 1024,
			64 * 1024 * 1024,
		)
	}

	private get handshakeTimeoutMs(): number {
		return readPositiveInteger(
			this.env.RELAY_HANDSHAKE_TIMEOUT_MS,
			DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS,
			5_000,
			5 * 60 * 1_000,
		)
	}

	private async handleRequestRelay(
		req: rendezvous.RequestRelay,
		socket: WebSocket,
	): Promise<void> {
		if (this.initiator === socket || this.acceptor === socket) {
			return
		}

		const relayKey = this.env.RELAY_KEY?.trim()
		if (!relayKey) {
			logEvent('relay rejected because RELAY_KEY is not configured')
			closeSocket(socket, 1011, 'relay is not configured')
			return
		}
		if (!(await timingSafeSecretEqual(req.licenceKey, relayKey))) {
			logEvent('relay authentication failed')
			closeSocket(socket, 4001, 'unauthorized')
			return
		}

		this.pruneClosedSockets()
		let role: Exclude<RelayRole, 'pending'>
		if (!this.initiator) {
			role = 'initiator'
			this.initiator = socket
		} else if (!this.acceptor) {
			role = 'acceptor'
			this.acceptor = socket
		} else {
			closeSocket(socket, 4002, 'relay session is full')
			return
		}

		socket.serializeAttachment({
			role,
			connectedAt: Date.now(),
		} satisfies RelaySocketAttachment)
		logEvent('relay socket assigned', {
			role,
			relayId: this.ctx.id.toString(),
		})

		if (role === 'initiator') {
			this.flushQueue(this.initiator, this.pendingFromAcceptor, 'acceptor')
		} else {
			this.flushQueue(this.acceptor, this.pendingFromInitiator, 'initiator')
		}

		if (this.initiator && this.acceptor) {
			await this.ctx.storage.deleteAlarm()
		} else {
			await this.ctx.storage.setAlarm(Date.now() + this.handshakeTimeoutMs)
		}
	}

	private pruneClosedSockets(): void {
		if (this.initiator && this.initiator.readyState >= 2) {
			this.initiator = undefined
		}
		if (this.acceptor && this.acceptor.readyState >= 2) {
			this.acceptor = undefined
		}
	}

	private forwardMessage(
		message: RelayMessage,
		target: WebSocket | undefined,
		queue: RelayMessage[],
		direction: 'initiator' | 'acceptor',
	): void {
		if (target) {
			if (isOpen(target) && this.trySend(target, message)) {
				return
			}
			this.closeRelay(1013, 'relay backpressure')
			return
		}

		const size = messageByteLength(message)
		const currentBytes = direction === 'initiator'
			? this.pendingFromInitiatorBytes
			: this.pendingFromAcceptorBytes
		if (queue.length >= this.maxQueueMessages
			|| currentBytes + size > this.maxQueueBytes) {
			logEvent('relay pending queue limit reached', { direction })
			this.closeRelay(1009, 'relay queue limit reached')
			return
		}

		queue.push(message)
		if (direction === 'initiator') {
			this.pendingFromInitiatorBytes += size
		} else {
			this.pendingFromAcceptorBytes += size
		}
	}

	private trySend(target: WebSocket, message: RelayMessage): boolean {
		const bufferedAmount = (target as BufferedWebSocket).bufferedAmount ?? 0
		if (!isOpen(target) || bufferedAmount > this.maxBufferedBytes) {
			return false
		}
		try {
			target.send(message)
			return true
		} catch (error) {
			logEvent('relay send failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			return false
		}
	}

	private flushQueue(
		target: WebSocket | undefined,
		queue: RelayMessage[],
		direction: 'initiator' | 'acceptor',
	): void {
		if (!target || queue.length === 0) {
			return
		}

		const pending = queue.splice(0)
		if (direction === 'initiator') {
			this.pendingFromInitiatorBytes = 0
		} else {
			this.pendingFromAcceptorBytes = 0
		}

		for (const message of pending) {
			if (!this.trySend(target, message)) {
				this.closeRelay(1013, 'relay delivery failed')
				return
			}
		}
	}

	private closeRelay(code: number, reason: string): void {
		// A relay may still have a third state in flight: one endpoint can have
		// authenticated while the other is pending. Close every socket so a
		// half-open connection cannot be reused by a later session.
		const sockets = this.ctx.getWebSockets()
		this.initiator = undefined
		this.acceptor = undefined
		this.pendingFromInitiator = []
		this.pendingFromAcceptor = []
		this.pendingFromInitiatorBytes = 0
		this.pendingFromAcceptorBytes = 0

		for (const socket of sockets) {
			closeSocket(socket, code, reason)
		}

		this.ctx.waitUntil(this.ctx.storage.deleteAlarm().catch((error) => {
			logEvent('failed to clear relay alarm', {
				error: error instanceof Error ? error.message : String(error),
			})
		}))
	}

	private async reconcileHandshakeAlarm(): Promise<void> {
		if (this.initiator && this.acceptor) {
			await this.ctx.storage.deleteAlarm()
			return
		}

		if (this.ctx.getWebSockets().some((socket) => socket.readyState < 2)) {
			await this.ctx.storage.setAlarm(Date.now() + this.handshakeTimeoutMs)
		} else {
			await this.ctx.storage.deleteAlarm()
		}
	}
}

export class Hbbs extends DurableObject<WorkerEnv> {
	private sessions = new Map<string, HbbsSession>()
	private origin = ''

	constructor(ctx: DurableObjectState, env: WorkerEnv) {
		super(ctx, env)

		// Production deployments provide HBBS_RELAY_URL, so the relay URL can
		// be built without waking storage on every hibernation cycle. Keep the
		// storage fallback for local/dev deployments that only know their request
		// origin.
		if (!env.HBBS_RELAY_URL?.trim()) {
			ctx.blockConcurrencyWhile(async () => {
				this.origin = await ctx.storage.get<string>(ORIGIN_STORAGE_KEY) ?? ''
			})
		}

		for (const webSocket of ctx.getWebSockets()) {
			const meta = readHbbsAttachment(webSocket)
			if (!meta) {
				// Older deployments did not attach metadata until registration.
				webSocket.serializeAttachment({
					kind: 'pending',
					connectedAt: Date.now(),
				} satisfies PendingSocketAttachment)
				continue
			}
			if (meta.kind !== 'session') {
				continue
			}

			const existing = this.sessions.get(meta.id)
			if (!existing || existing.registeredAt <= meta.registeredAt) {
				this.sessions.set(meta.id, {
					...meta,
					socket: webSocket,
				})
			} else {
				closeSocket(webSocket, 4009, 'duplicate session')
			}
		}
	}

	async fetch(req: Request): Promise<Response> {
		if (!isWebSocketUpgrade(req)) {
			return upgradeRequiredResponse()
		}
		if (this.countPendingSockets() >= this.maxPendingConnections) {
			return new Response('Too many pending connections', { status: 503 })
		}

		const requestOrigin = new URL(req.url).origin
		if (this.origin !== requestOrigin) {
			this.origin = requestOrigin
			if (!this.env.HBBS_RELAY_URL?.trim()) {
				this.ctx.waitUntil(this.ctx.storage.put(ORIGIN_STORAGE_KEY, this.origin).catch((error) => {
					logEvent('failed to persist rendezvous origin', {
						error: error instanceof Error ? error.message : String(error),
					})
				}))
			}
		}

		const webSocketPair = new WebSocketPair()
		const [client, server] = Object.values(webSocketPair)
		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({
			kind: 'pending',
			connectedAt: Date.now(),
		} satisfies PendingSocketAttachment)
		this.ctx.waitUntil(this.reconcilePendingAlarm().catch((error) => {
			logEvent('failed to schedule pending connection cleanup', {
				error: error instanceof Error ? error.message : String(error),
			})
		}))

		return new Response(null, {
			status: 101,
			webSocket: client,
		})
	}

	async webSocketMessage(ws: WebSocket, message: RelayMessage): Promise<void> {
		if (!(message instanceof ArrayBuffer)) {
			closeSocket(ws, 1003, 'binary rendezvous messages required')
			return
		}
		if (message.byteLength > MAX_RENDEZVOUS_MESSAGE_BYTES) {
			closeSocket(ws, 1009, 'rendezvous message is too large')
			return
		}

		let msg: rendezvous.RendezvousMessage
		try {
			msg = rendezvous.RendezvousMessage.fromBinary(new Uint8Array(message))
		} catch (error) {
			logEvent('invalid rendezvous message', {
				error: error instanceof Error ? error.message : String(error),
			})
			closeSocket(ws, 1003, 'invalid rendezvous message')
			return
		}

		switch (msg.union?.oneofKind) {
			case 'registerPk':
				this.handleRegisterPk(msg.union.registerPk, ws)
				break
			case 'onlineRequest':
				this.handleOnlineRequest(msg.union.onlineRequest, ws)
				break
			case 'punchHoleRequest':
				await this.handlePunchHoleRequest(msg.union.punchHoleRequest, ws)
				break
			case 'relayResponse':
				this.handleRelayResponse(msg.union.relayResponse, ws)
				break
			default:
				closeSocket(ws, 1003, 'unsupported rendezvous message')
		}
	}

	async webSocketClose(
		ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const meta = readHbbsAttachment(ws)
		if (meta?.kind === 'session') {
			const current = this.sessions.get(meta.id)
			if (current?.socket === ws) {
				this.sessions.delete(meta.id)
				logEvent('rendezvous client closed', { id: meta.id })
			}
		}

		await this.reconcilePendingAlarm()
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		logEvent('rendezvous websocket error', {
			error: error instanceof Error ? error.message : String(error),
		})
		closeSocket(ws, 1011, 'rendezvous socket error')
		await this.reconcilePendingAlarm()
	}

	async alarm(): Promise<void> {
		const now = Date.now()
		for (const socket of this.ctx.getWebSockets()) {
			const meta = readHbbsAttachment(socket)
			if (meta?.kind !== 'pending') {
				continue
			}

			if (meta.connectedAt + PENDING_CONNECTION_TIMEOUT_MS <= now) {
				closeSocket(socket, 4004, 'registration timeout')
			}
		}
		await this.reconcilePendingAlarm()
	}

	sendRendezvous(data: RendezvousPayload, socket: WebSocket | undefined): boolean {
		if (!socket || !isOpen(socket)) {
			return false
		}

		const keys = Object.keys(data)
		if (keys.length !== 1) {
			return false
		}
		const [type] = keys as [keyof RendezvousPayload]
		const msg = {
			union: {
				oneofKind: type,
				...data,
			},
		} as rendezvous.RendezvousMessage

		try {
			socket.send(rendezvous.RendezvousMessage.toBinary(msg))
			return true
		} catch (error) {
			logEvent('rendezvous send failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			closeSocket(socket, 1011, 'rendezvous send failed')
			return false
		}
	}

	handleRelayResponse(res: rendezvous.RelayResponse, socket: WebSocket): void {
		if (!this.getSessionForSocket(socket)) {
			closeSocket(socket, 4004, 'register first')
			return
		}
		logEvent('relay response received', { version: res.version })
	}

	async handlePunchHoleRequest(req: rendezvous.PunchHoleRequest, socket: WebSocket): Promise<void> {
		const requester = this.getSessionForSocket(socket)
		if (!requester) {
			closeSocket(socket, 4004, 'register first')
			return
		}

		const relayKey = this.env.RELAY_KEY?.trim()
		if (!relayKey || !(await timingSafeSecretEqual(req.licenceKey, relayKey))) {
			logEvent('rendezvous authentication failed')
			this.sendPunchFailure(
				socket,
				'license mismatch',
				rendezvous.PunchHoleResponse_Failure.LICENSE_MISMATCH,
			)
			return
		}

		const targetId = req.id.trim()
		if (!isValidPeerId(targetId) || targetId === requester.id) {
			this.sendPunchFailure(socket, 'invalid target', rendezvous.PunchHoleResponse_Failure.ID_NOT_EXIST)
			return
		}

		const onlineSession = this.sessions.get(targetId)
		if (!onlineSession || !isOpen(onlineSession.socket)) {
			this.sendPunchFailure(socket, 'target not online', rendezvous.PunchHoleResponse_Failure.OFFLINE)
			return
		}

		const relayUrl = normalizeRelayBaseUrl(this.env.HBBS_RELAY_URL, this.origin)
		if (!relayUrl) {
			this.sendPunchFailure(socket, 'relay unavailable', rendezvous.PunchHoleResponse_Failure.OFFLINE)
			return
		}

		const socketAddr = crypto.getRandomValues(new Uint8Array(16))
		const hbbrObjId = this.env.HBBR.newUniqueId()
		const locationHint = readLocationHint(this.env.DO_LOCATION_HINT)
		const hbbrStub = this.env.HBBR.get(hbbrObjId, {
			locationHint,
		})
		logEvent('relay allocated', {
			relayId: hbbrObjId.toString(),
			locationHint,
		})
		this.ctx.waitUntil(hbbrStub.warmup().catch((error) => {
			logEvent('relay warmup failed', {
				error: error instanceof Error ? error.message : String(error),
			})
		}))

		const uuid = hbbrObjId.toString()
		const relayServer = `${relayUrl}/ws/relay/${uuid}`
		const targetRequestSent = this.sendRendezvous({
			requestRelay: rendezvous.RequestRelay.create({
				socketAddr,
				id: targetId,
				uuid,
				relayServer,
			}),
		}, onlineSession.socket)

		if (!targetRequestSent) {
			this.sendPunchFailure(socket, 'target connection closed', rendezvous.PunchHoleResponse_Failure.OFFLINE)
			return
		}

		this.sendRendezvous({
			relayResponse: rendezvous.RelayResponse.create({
				socketAddr,
				uuid,
				relayServer,
				version: '1.4.3',
			}),
		}, socket)
	}

	handleRegisterPk(req: rendezvous.RegisterPk, socket: WebSocket): void {
		const peerId = req.id.trim()
		const peerUuid = new TextDecoder().decode(req.uuid)
		const peerPk = bytesToBase64(req.pk)
		if (!isValidPeerId(peerId)) {
			this.sendRegisterResponse(socket, rendezvous.RegisterPkResponse_Result.INVALID_ID_FORMAT)
			closeSocket(socket, 4004, 'invalid peer id')
			return
		}

		const currentForId = this.sessions.get(peerId)
		if (currentForId && !identityMatches(currentForId, peerUuid)) {
			this.sendRegisterResponse(socket, rendezvous.RegisterPkResponse_Result.UUID_MISMATCH)
			closeSocket(socket, 4004, 'peer identity mismatch')
			return
		}

		const maxSessions = readPositiveInteger(
			this.env.MAX_SESSIONS,
			100,
			1,
			10_000,
		)
		if (!currentForId && this.sessions.size >= maxSessions) {
			logEvent('registration rejected because session table is full', { maxSessions })
			this.sendRegisterResponse(socket, rendezvous.RegisterPkResponse_Result.SERVER_ERROR)
			closeSocket(socket, 4003, 'server full')
			return
		}

		if (currentForId && currentForId.socket !== socket) {
			closeSocket(currentForId.socket, 4009, 'replaced by reconnect')
		}

		// Remove any previous ID owned by this same WebSocket (ID changes).
		for (const [id, session] of this.sessions) {
			if (session.socket === socket && id !== peerId) {
				this.sessions.delete(id)
			}
		}

		const registeredAt = Date.now()
		const attachment: SessionSocketAttachment = {
			kind: 'session',
			ip: '',
			id: peerId,
			uuid: peerUuid,
			pk: peerPk,
			registeredAt,
		}
		socket.serializeAttachment(attachment)
		this.sessions.set(peerId, {
			...attachment,
			socket,
		})

		if (!this.sendRegisterResponse(socket, rendezvous.RegisterPkResponse_Result.OK)) {
			const current = this.sessions.get(peerId)
			if (current?.socket === socket) {
				this.sessions.delete(peerId)
			}
			closeSocket(socket, 1011, 'registration response failed')
		}
	}

	handleOnlineRequest(req: rendezvous.OnlineRequest, socket: WebSocket): void {
		const requesterId = req.id.trim()
		if (!this.getSessionForSocket(socket, requesterId)) {
			closeSocket(socket, 4004, 'register first')
			return
		}

		const peers = req.peers.slice(0, MAX_ONLINE_QUERY_PEERS)
		const states = packOnlineStates(
			peers,
			(peerId) => {
				const session = this.sessions.get(peerId)
				return Boolean(session && isOpen(session.socket))
			},
		)
		this.sendRendezvous({
			onlineResponse: rendezvous.OnlineResponse.create({ states }),
		}, socket)
	}

	private sendRegisterResponse(
		socket: WebSocket,
		result: rendezvous.RegisterPkResponse_Result,
	): boolean {
		return this.sendRendezvous({
			registerPkResponse: rendezvous.RegisterPkResponse.create({
				result,
				keepAlive: 180,
			}),
		}, socket)
	}

	private sendPunchFailure(
		socket: WebSocket,
		message: string,
		failure: rendezvous.PunchHoleResponse_Failure,
	): boolean {
		return this.sendRendezvous({
			punchHoleResponse: rendezvous.PunchHoleResponse.create({
				failure,
				otherFailure: message,
			}),
		}, socket)
	}

	private getSessionForSocket(socket: WebSocket, expectedId?: string): HbbsSession | undefined {
		const meta = readHbbsAttachment(socket)
		if (meta?.kind !== 'session') {
			return undefined
		}
		if (expectedId && meta.id !== expectedId) {
			return undefined
		}
		const session = this.sessions.get(meta.id)
		return session?.socket === socket ? session : undefined
	}

	private countPendingSockets(): number {
		let count = 0
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState < 2 && readHbbsAttachment(socket)?.kind === 'pending') {
				count++
			}
		}
		return count
	}

	private get maxPendingConnections(): number {
		return readPositiveInteger(
			this.env.MAX_PENDING_CONNECTIONS,
			DEFAULT_MAX_PENDING_CONNECTIONS,
			16,
			10_000,
		)
	}

	private async reconcilePendingAlarm(): Promise<void> {
		let earliestDeadline: number | undefined
		for (const socket of this.ctx.getWebSockets()) {
			const meta = readHbbsAttachment(socket)
			if (socket.readyState >= 2 || meta?.kind !== 'pending') {
				continue
			}
			const deadline = meta.connectedAt + PENDING_CONNECTION_TIMEOUT_MS
			if (earliestDeadline === undefined || deadline < earliestDeadline) {
				earliestDeadline = deadline
			}
		}

		if (earliestDeadline === undefined) {
			await this.ctx.storage.deleteAlarm()
		} else {
			await this.ctx.storage.setAlarm(earliestDeadline)
		}
	}
}
