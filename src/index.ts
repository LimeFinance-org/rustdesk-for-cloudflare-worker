import { Hono } from 'hono'
import { Hbbs as Hbbs_, Hbbr as Hbbr_ } from './hbbs'
import type { WorkerEnv } from './env'
import { readLocationHint } from './protocol-utils'
import { isWebSocketUpgrade, upgradeRequiredResponse } from './websocket'

export class Hbbs extends Hbbs_ { }
export class Hbbr extends Hbbr_ { }

const app = new Hono<{ Bindings: WorkerEnv }>()

const REPO_URL = 'https://github.com/LimeFinance-org/rustdesk-for-cloudflare-worker'

// Humans hitting the domain get redirected to the project page.
app.get('/', (c) => c.redirect(REPO_URL, 302))

app.get('/healthz', (c) => c.json({ ok: true, service: 'rustdesk-relay' }))

app.get('/ws/id', async (c) => {
	if (!isWebSocketUpgrade(c.req.raw)) {
		return upgradeRequiredResponse()
	}

	const hbbsId = c.env.HBBS.idFromName('hbbs')
	const hbbsObj = c.env.HBBS.get(hbbsId, {
		locationHint: readLocationHint(c.env.DO_LOCATION_HINT),
	})
	return hbbsObj.fetch(c.req.raw)
})

app.get('/ws/relay/:session', async (c) => {
	if (!isWebSocketUpgrade(c.req.raw)) {
		return upgradeRequiredResponse()
	}

	const session = c.req.param('session')
	if (!session || session.length > 256) {
		return c.text('invalid request', 400)
	}

	let hbbrId: DurableObjectId
	try {
		hbbrId = c.env.HBBR.idFromString(session)
	} catch {
		return c.text('invalid session', 400)
	}

	const hbbrObj = c.env.HBBR.get(hbbrId)
	return hbbrObj.fetch(c.req.raw)
})

app.all('/api/*', (c) => {
	// The WebSocket-only worker intentionally does not implement RustDesk Pro APIs.
	return c.json({ error: 'API endpoint not implemented' }, 404)
})

// Any other unmatched path also goes to the project page.
app.notFound((c) => c.redirect(REPO_URL, 302))

export default app
