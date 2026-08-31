export const MAX_PEER_ID_LENGTH = 64
export const MAX_ONLINE_QUERY_PEERS = 4096
export type LocationHint =
	| 'wnam'
	| 'enam'
	| 'sam'
	| 'weur'
	| 'eeur'
	| 'apac'
	| 'apac-ne'
	| 'apac-se'
	| 'oc'
	| 'afr'
	| 'me'

const textEncoder = new TextEncoder()
const LOCATION_HINTS = new Set<LocationHint>([
	'wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me',
])

export function readLocationHint(value: string | undefined): LocationHint {
	const candidate = value?.trim().toLowerCase() as LocationHint | undefined
	return candidate && LOCATION_HINTS.has(candidate) ? candidate : 'apac'
}

export function isValidPeerId(peerId: string): boolean {
	return peerId.length >= 2
		&& peerId.length <= MAX_PEER_ID_LENGTH
		&& /^[A-Za-z0-9_-]+$/.test(peerId)
}

export function packOnlineStates(
	peers: readonly string[],
	isOnline: (peerId: string) => boolean,
): Uint8Array {
	const states = new Uint8Array(Math.ceil(peers.length / 8))
	for (let i = 0; i < peers.length; i++) {
		if (!isOnline(peers[i])) {
			continue
		}

		const byteIndex = Math.floor(i / 8)
		states[byteIndex] |= 0x01 << (7 - (i % 8))
	}
	return states
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = ''
	const chunkSize = 0x8000
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
	}
	return btoa(binary)
}

export function messageByteLength(message: string | ArrayBuffer): number {
	return typeof message === 'string'
		? textEncoder.encode(message).byteLength
		: message.byteLength
}

export function readPositiveInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
		? parsed
		: fallback
}

export function normalizeRelayBaseUrl(
	configuredUrl: string | undefined,
	fallbackOrigin: string,
): string | null {
	const rawUrl = configuredUrl?.trim() || fallbackOrigin.trim()
	if (!rawUrl) {
		return null
	}

	try {
		const url = new URL(rawUrl)
		if (url.protocol === 'https:') {
			url.protocol = 'wss:'
		} else if (url.protocol === 'http:') {
			url.protocol = 'ws:'
		}
		if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
			return null
		}
		url.pathname = url.pathname.replace(/\/+$/, '')
		return url.toString().replace(/\/$/, '')
	} catch {
		return null
	}
}

/**
 * Compare secrets without returning early on the first different byte.
 * Hashing first also prevents the secret length from being observable.
 */
export async function timingSafeSecretEqual(
	provided: string,
	expected: string,
): Promise<boolean> {
	const encoder = new TextEncoder()
	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(provided)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	])
	const left = new Uint8Array(providedHash)
	const right = new Uint8Array(expectedHash)
	let difference = 0
	for (let i = 0; i < left.length; i++) {
		difference |= left[i] ^ right[i]
	}
	return difference === 0
}
