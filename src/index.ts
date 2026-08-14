import { Hono } from 'hono'
import { Hbbs as Hbbs_, Hbbr as Hbbr_ } from './hbbs'

export class Hbbs extends Hbbs_ { }
export class Hbbr extends Hbbr_ { }

type Bindings = {
  HBBS: DurableObjectNamespace<Hbbs>
  HBBR: DurableObjectNamespace<Hbbr>
}

const app = new Hono<{ Bindings: Bindings }>()

const REPO_URL = 'https://github.com/LimeFinance-org/rustdesk-for-cloudflare-worker'

// Humans hitting the domain get redirected to the project page.
app.get('/', (c) => c.redirect(REPO_URL, 302))

app.get('/ws/id', async (c) => {
  const hbbsId = c.env.HBBS.idFromName('hbbs')
  const hbbsObj = c.env.HBBS.get(hbbsId)
  return hbbsObj.fetch(c.req.raw)
})

app.get('/ws/relay/:session', async (c) => {
  const session = c.req.param('session')
  if (!session?.length) {
    return c.text('invalid request', 400)
  }
  const hbbrId = c.env.HBBR.idFromString(session)
  const hbbrObj = c.env.HBBR.get(hbbrId)
  return hbbrObj.fetch(c.req.raw)
})

app.all('/api/*', async (c) => {
  // TODO: implement some apis
  return c.json({}, 404)
})

// Any other unmatched path also goes to the project page.
app.notFound((c) => c.redirect(REPO_URL, 302))

export default app
