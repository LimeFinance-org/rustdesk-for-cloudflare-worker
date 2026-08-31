import { env } from 'cloudflare:workers'
import { runInDurableObject, reset } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

function upgradeRequest(): Request {
	return new Request('https://relay.example.test/ws/relay/test', {
		headers: {
			Connection: 'Upgrade',
			Upgrade: 'websocket',
			'Sec-WebSocket-Version': '13',
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
		},
	})
}

async function openRelay(stub: DurableObjectStub): Promise<WebSocket> {
	const response = await stub.fetch(upgradeRequest())
	expect(response.status).toBe(101)
	expect(response.webSocket).not.toBeNull()
	return response.webSocket as WebSocket
}

afterEach(async () => {
	await reset()
})

describe('independent relay sessions', () => {
	it('keeps concurrent sessions isolated at one HBBR per session', async () => {
		const firstId = env.HBBR.newUniqueId()
		const secondId = env.HBBR.newUniqueId()
		const first = env.HBBR.get(firstId)
		const second = env.HBBR.get(secondId)

		await Promise.all([
			openRelay(first),
			openRelay(first),
			openRelay(second),
			openRelay(second),
		])

		const counts = await Promise.all([
			runInDurableObject(first, (_instance, state) => state.getWebSockets().length),
			runInDurableObject(second, (_instance, state) => state.getWebSockets().length),
		])

		expect(counts).toEqual([2, 2])
		expect((await first.fetch(upgradeRequest())).status).toBe(503)
	})
})
