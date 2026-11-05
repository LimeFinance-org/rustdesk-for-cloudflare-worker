import { env } from 'cloudflare:workers'
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import * as rendezvous from '../src/hbbs-rendezvous'

const RELAY_KEY = 'test-relay-key'

interface Client {
	socket: WebSocket
	/** Resolves with the next frame (an empty Uint8Array for heartbeats). */
	next(): Promise<Uint8Array>
	closed: Promise<number>
}

function upgradeRequest(): Request {
	return new Request('https://relay.example.test/ws/id', {
		headers: {
			Connection: 'Upgrade',
			Upgrade: 'websocket',
			'Sec-WebSocket-Version': '13',
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
		},
	})
}

function hbbsStub(): DurableObjectStub {
	return env.HBBS.get(env.HBBS.idFromName('hbbs-test'))
}

async function toBytes(data: unknown): Promise<Uint8Array> {
	if (typeof data === 'string') {
		return new TextEncoder().encode(data)
	}
	if (data instanceof Blob) {
		return new Uint8Array(await data.arrayBuffer())
	}
	return new Uint8Array(data as ArrayBuffer)
}

async function connect(stub: DurableObjectStub): Promise<Client> {
	const response = await stub.fetch(upgradeRequest())
	expect(response.status).toBe(101)
	const socket = response.webSocket as WebSocket
	socket.accept()

	// Queue raw frames in arrival order; the test runtime delivers binary
	// frames as Blobs, so they are converted when read.
	const frames: Promise<Uint8Array>[] = []
	const waiters: ((frame: Promise<Uint8Array>) => void)[] = []
	socket.addEventListener('message', (event) => {
		const frame = toBytes(event.data)
		const waiter = waiters.shift()
		if (waiter) {
			waiter(frame)
		} else {
			frames.push(frame)
		}
	})
	const closed = new Promise<number>((resolve) => {
		socket.addEventListener('close', (event) => resolve(event.code))
	})

	return {
		socket,
		closed,
		next() {
			const frame = frames.shift()
			if (frame) {
				return frame
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), 2_000)
				waiters.push((value) => {
					clearTimeout(timer)
					value.then(resolve, reject)
				})
			})
		},
	}
}

function send(client: Client, union: rendezvous.RendezvousMessage['union']): void {
	client.socket.send(rendezvous.RendezvousMessage.toBinary({ union }))
}

async function receive(client: Client): Promise<rendezvous.RendezvousMessage['union']> {
	return rendezvous.RendezvousMessage.fromBinary(await client.next()).union
}

async function register(stub: DurableObjectStub, id: string): Promise<Client> {
	const client = await connect(stub)
	send(client, {
		oneofKind: 'registerPk',
		registerPk: rendezvous.RegisterPk.create({
			id,
			uuid: new TextEncoder().encode(`${id}-uuid`),
			pk: new Uint8Array(32).fill(7),
		}),
	})
	const reply = await receive(client)
	expect(reply.oneofKind).toBe('registerPkResponse')
	if (reply.oneofKind === 'registerPkResponse') {
		expect(reply.registerPkResponse.result).toBe(rendezvous.RegisterPkResponse_Result.OK)
		expect(reply.registerPkResponse.keepAlive).toBeGreaterThan(0)
	}
	return client
}

afterEach(async () => {
	await reset()
})

describe('hbbs rendezvous', () => {
	it('answers online queries sent on a separate, unregistered connection', async () => {
		const stub = hbbsStub()
		await register(stub, 'device-a')

		const query = await connect(stub)
		send(query, {
			oneofKind: 'onlineRequest',
			onlineRequest: rendezvous.OnlineRequest.create({
				id: 'viewer-b',
				peers: ['device-a', 'device-missing'],
			}),
		})
		const reply = await receive(query)
		expect(reply.oneofKind).toBe('onlineResponse')
		if (reply.oneofKind === 'onlineResponse') {
			expect([...reply.onlineResponse.states]).toEqual([0x80])
		}
	})

	it('relays punch-hole requests sent on a separate, unregistered connection', async () => {
		const stub = hbbsStub()
		const target = await register(stub, 'device-a')

		const controller = await connect(stub)
		send(controller, {
			oneofKind: 'punchHoleRequest',
			punchHoleRequest: rendezvous.PunchHoleRequest.create({
				id: 'device-a',
				licenceKey: RELAY_KEY,
			}),
		})

		const toController = await receive(controller)
		expect(toController.oneofKind).toBe('relayResponse')
		const toTarget = await receive(target)
		expect(toTarget.oneofKind).toBe('requestRelay')
		if (toController.oneofKind === 'relayResponse' && toTarget.oneofKind === 'requestRelay') {
			expect(toController.relayResponse.relayServer)
				.toBe(`wss://relay.example.test/ws/relay/${toController.relayResponse.uuid}`)
			expect(toTarget.requestRelay.uuid).toBe(toController.relayResponse.uuid)
		}
	})

	it('keeps the connection open for heartbeats and unsupported messages', async () => {
		const stub = hbbsStub()
		const client = await register(stub, 'device-a')

		client.socket.send(new ArrayBuffer(0))
		send(client, {
			oneofKind: 'testNatRequest',
			testNatRequest: rendezvous.TestNatRequest.create({ serial: 1 }),
		})
		send(client, {
			oneofKind: 'hc',
			hc: rendezvous.HealthCheck.create({ token: 'x' }),
		})
		send(client, {
			oneofKind: 'registerPeer',
			registerPeer: rendezvous.RegisterPeer.create({ id: 'device-a', serial: 1 }),
		})

		const reply = await receive(client)
		expect(reply.oneofKind).toBe('registerPeerResponse')
		if (reply.oneofKind === 'registerPeerResponse') {
			expect(reply.registerPeerResponse.requestPk).toBe(false)
		}
		expect(client.socket.readyState).toBe(WebSocket.OPEN)
	})

	it('asks unregistered peers for their public key', async () => {
		const client = await connect(hbbsStub())
		send(client, {
			oneofKind: 'registerPeer',
			registerPeer: rendezvous.RegisterPeer.create({ id: 'device-a', serial: 1 }),
		})
		const reply = await receive(client)
		expect(reply.oneofKind).toBe('registerPeerResponse')
		if (reply.oneofKind === 'registerPeerResponse') {
			expect(reply.registerPeerResponse.requestPk).toBe(true)
		}
	})

	it('sends heartbeats to registered clients from the alarm', async () => {
		const stub = hbbsStub()
		const client = await register(stub, 'device-a')

		// runDurableObjectAlarm fires immediately, so mark the heartbeat as due
		// the way it is when the scheduled alarm time is reached.
		await runInDurableObject(stub, (instance) => {
			(instance as unknown as { nextHeartbeatAt: number }).nextHeartbeatAt = 0
		})
		expect(await runDurableObjectAlarm(stub)).toBe(true)
		const frame = await client.next()
		expect(frame.byteLength).toBe(0)

		// The heartbeat alarm stays scheduled while sessions are online.
		expect(await runDurableObjectAlarm(stub)).toBe(true)
	})
})
