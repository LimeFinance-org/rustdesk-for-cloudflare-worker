<div align="right">

**English** | [中文](README_zh-CN.md)

</div>

# rustdesk-for-cloudflare-worker

**Host RustDesk signaling & relay services for free on Cloudflare Workers + Durable Objects — no VPS required.**

Improved from [lichon/hbbs-worker](https://github.com/lichon/hbbs-worker): single-file configuration, relay key authentication, registration cap protection and beginner-friendly docs.

> Works with RustDesk client **1.4.3+** (verified on 1.4.9). How it works: the RustDesk client has a built-in
> "Use WebSocket" mode — signaling goes to `wss://your-domain/ws/id` and relay traffic to
> `wss://your-domain/ws/relay/{session-id}`. This project implements the equivalent hbbs/hbbr WebSocket
> protocol subset with Durable Objects on Cloudflare.

---

## ✨ Features

- 🆓 **Zero server cost**: runs entirely on the Cloudflare Free plan (Workers + Durable Objects)
- 🔐 **Relay key auth**: relay requests whose Key doesn't match are rejected — strangers can't burn your quota
- 🚦 **Registration cap**: new registrations are refused once the session table is full, blocking mass abuse
- 🌐 **Fully managed domain**: DNS record + TLS certificate are created automatically on deploy
- 📦 **One-command deploy**: `npm run deploy` generates config, uploads the key and deploys

## ⚠️ Know the limits first (important)

| Limit | Details |
|---|---|
| Always relayed | In WebSocket mode RustDesk skips P2P hole punching; every connection goes through the relay |
| Free quota | The Durable Objects free tier allows ~100k billable requests/day (incoming WS messages count at a 20:1 ratio). Fine for light office use; ~10 h/day of continuous high-framerate video |
| Latency | One extra hop vs. native hbbr, typically +50–150 ms |
| No SLA | Free service, no availability guarantee; DOs may hibernate (auto-wake on data) |

**Not suitable for**: high-FPS design/video editing sessions, frequent large file transfers, multi-user team usage.

---

## 🚀 Deployment

### 0. Prerequisites

1. A [free Cloudflare account](https://dash.cloudflare.com/sign-up)
2. A domain hosted in that Cloudflare account (Dashboard → Add a site → follow the NS instructions)
   > ⚠️ Do not rely on the default `workers.dev` domain: **it is blocked in Mainland China**;
   > users in Mainland China must bind their own domain
3. [Node.js](https://nodejs.org) ≥ 18 installed locally

### 1. Install dependencies and log in

```bash
npm install
npx wrangler login        # click Allow in the browser
```

### 2. Generate and fill in config.json (the only file you edit)

```bash
npm run setup
```

On first run a `config.json` is generated for you (with `_说明` / explanation fields inside). Edit it:

```json
{
	"domain": "rust.example.com",   // ← your own domain (hosted in your CF account)
	"key": "a-random-string-20+chars" // ← goes into the Key field of every RustDesk client
}
```

> DNS record and TLS certificate are created automatically by Cloudflare on deploy.
> `config.json` is gitignored — your domain and key are never committed.

### 3. One-command deploy

```bash
npm run deploy
```

The script will: generate the deploy config → upload `key` as a Cloudflare Secret (never stored in the repo) → deploy the Worker.
Success looks like `rust.example.com (custom domain)`. Verify the signaling endpoint:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://rust.example.com/ws/id
# 101 means the full chain works
```

Windows PowerShell (single line):

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://rust.example.com/ws/id
```

> Replace `rust.example.com` with your own domain; the headers are fixed WebSocket handshake values and can be copied as-is.

---

## 🖥️ Client configuration (on BOTH controlling and controlled devices)

Install [RustDesk](https://github.com/rustdesk/rustdesk/releases) (≥ 1.4.3), go to **Settings → Network → unlock advanced settings**:

| Field | Value |
|---|---|
| **Use WebSocket** | ✅ enabled |
| ID Server | `rust.example.com` (your domain, no port, no scheme) |
| Relay Server | `rust.example.com` |
| API Server | `https://rust.example.com` (https is required, otherwise the client falls back to ws://) |
| Key | the `key` from your `config.json` |

The controlled side shows **"Ready"** once registered.

### Verification

- Controlled-side log should show: `start tcp: wss://rust.example.com/ws/id`
- Server logs: `npm run tail`
  - Registration: `Handling register pk id: ...`
  - Relay pairing: `setup initiator for uuid...` + `setup acceptor for uuid...`
- The official web client https://rustdesk.com/web/ also works with your wss domain

---

## 🔒 Security notes

| Mechanism | Details |
|---|---|
| Transport encryption | wss (TLS) end to end |
| Relay auth | `key` is stored as a Cloudflare Secret and matched against the client's Key field; mismatches are disconnected (`handleRequestRelay` in `src/hbbs.ts`) |
| Registration cap | Max 100 online IDs by default; adjust with `npx wrangler secret put MAX_SESSIONS` |
| Session content | RustDesk end-to-end encryption; the relay only forwards ciphertext |

Also set a strong fixed password or 2FA on the controlled device. If the key leaks: change `key` in `config.json`, run `npm run deploy` again, and update all clients.

## 📊 Free quota estimate

| Intensity | Consumption per hour (billable requests) | Daily quota lasts about |
|---|---|---|
| 🟢 Light (screen mostly static) | 400–900 | effectively unlimited |
| 🟡 Medium (normal office work) | 1,800–3,600 | 28–55 hours |
| 🔴 Heavy (continuous scrolling/video) | 7,000–11,000 | 9–14 hours |

Quota resets daily at 00:00 UTC. Usage: Cloudflare Dashboard → Workers & Pages → your Worker → Metrics.

## ❓ FAQ

| Symptom | Fix |
|---|---|
| Client never shows "Ready" | Is API Server set to `https://`? Does the client log show `wss://` after `start tcp:`? |
| Online but disconnects on connect | Do both sides use the same Key matching the server `RELAY_KEY`? Check `npm run tail` for `relay auth failed` |
| Deploy fails on domain | The domain must be hosted in the current account; `custom_domain` cannot contain paths or `*` |
| Cannot connect from Mainland China | The default `workers.dev` domain is blocked in Mainland China — bind your own domain. Also note the Cloudflare Free plan has no PoPs in Mainland China, so high latency (150–300 ms+) is expected |
| Everything suddenly fails | Free quota exhausted; it resets at 00:00 UTC the next day |

## 📁 Project structure

```
config.json             # Your config (domain+key): auto-generated by first npm run setup, gitignored
scripts/setup.mjs       # Reads config.json, generates the local deploy config and uploads secrets
src/index.ts            # Worker entry: routes /ws/id → Hbbs DO, /ws/relay/:uuid → Hbbr DO
src/hbbs.ts             # Hbbs DO: registration/online lookup/relay dispatch; Hbbr DO: uuid pairing & forwarding
src/hbbs-rendezvous.ts  # RustDesk signaling protobuf definitions (generated, do not edit)
wrangler.json           # Deploy template (no edits needed)
```

## 🙏 Credits & License

- Protocol implementation based on [lichon/hbbs-worker](https://github.com/lichon/hbbs-worker) (MIT)
- Protocol-compatible with the [RustDesk](https://github.com/rustdesk/rustdesk) (AGPL-3.0) client WebSocket mode

Released under the [MIT License](LICENSE).
