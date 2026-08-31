import { describe, expect, it } from 'vitest'
import {
	isValidPeerId,
	normalizeRelayBaseUrl,
	packOnlineStates,
	readLocationHint,
	timingSafeSecretEqual,
} from '../src/protocol-utils'

describe('protocol utilities', () => {
	it('packs online states using integer byte indexes', () => {
		const peers = Array.from({ length: 10 }, (_, index) => `peer-${index}`)
		const states = packOnlineStates(
			peers,
			(peerId) => ['peer-0', 'peer-1', 'peer-7', 'peer-8', 'peer-9'].includes(peerId),
		)

		expect([...states]).toEqual([0xc1, 0xc0])
	})

	it('validates peer ids without accepting path-like input', () => {
		expect(isValidPeerId('desktop-01')).toBe(true)
		expect(isValidPeerId('a')).toBe(false)
		expect(isValidPeerId('desktop/01')).toBe(false)
		expect(isValidPeerId('x'.repeat(65))).toBe(false)
	})

	it('defaults placement to APAC and normalizes relay URLs', () => {
		expect(readLocationHint(undefined)).toBe('apac')
		expect(readLocationHint('apac-ne')).toBe('apac-ne')
		expect(readLocationHint('unknown')).toBe('apac')
		expect(normalizeRelayBaseUrl('https://relay.example.test/', '')).toBe('wss://relay.example.test')
	})

	it('compares relay secrets correctly', async () => {
		expect(await timingSafeSecretEqual('same-secret', 'same-secret')).toBe(true)
		expect(await timingSafeSecretEqual('same-secret', 'different-secret')).toBe(false)
	})
})
