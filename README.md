<div align="right">

**English** | [中文](README_zh-CN.md)

</div>

# rustdesk-for-cloudflare-worker

**Host RustDesk servers (hbbs/hbbr) for free on Cloudflare Workers — no VPS required.**

RustDesk clients have a built-in "Use WebSocket" mode. This project runs the signaling (`/ws/id`) and relay (`/ws/relay`) services on Cloudflare Workers, so you only need a free Cloudflare account and a domain.

Verified with RustDesk client 1.4.9 (works with 1.4.3+). Based on [lichon/hbbs-worker](https://github.com/lichon/hbbs-worker).

## Limits

- All connections go through the relay (WebSocket mode has no P2P hole punching)
- Free quota: plenty for light/medium daily use; heavy full-day video streaming ≈ 10 h/day
- Extra latency vs. native hbbr: typically +50–150 ms

## Deploy

Prerequisites: a free [Cloudflare account](https://dash.cloudflare.com/sign-up) with your domain hosted in it, and Node.js ≥ 18.

> ⚠️ The default `workers.dev` domain is blocked in **Mainland China** — bind your own domain.

```bash
npm install
npx wrangler login          # click Allow in the browser
npm run setup               # generates config.json — edit your domain & key in it
npm run deploy              # uploads the key as a Cloudflare secret and deploys
```

The generated `config.json` (gitignored, never committed):

```json
{
	"domain": "rust.example.com",       // ← your domain (hosted in your Cloudflare account)
	"key": "a-random-string-20+chars"   // ← also goes into the Key field of every RustDesk client
}
```

Verify (replace the domain; a `101` response means it works):

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://rust.example.com/ws/id
```

## Client settings (on both devices)

RustDesk → Settings → Network → unlock advanced settings:

| Field | Value |
|---|---|
| **Use WebSocket** | ✅ enabled |
| ID Server | your domain (no port, no scheme) |
| Relay Server | your domain |
| API Server | `https://your-domain` (https required) |
| Key | the `key` from `config.json` |

The controlled side shows **"Ready"** when registered. Server logs: `npm run tail`.

## Security

- All traffic runs over wss (TLS); session content stays end-to-end encrypted by RustDesk
- Relay requests must present the `key`; mismatches are rejected
- Max 100 online IDs by default (anti-abuse); adjust with `npx wrangler secret put MAX_SESSIONS`
- Also set a strong password or 2FA on the controlled device

## FAQ

| Symptom | Fix |
|---|---|
| Client never shows "Ready" | API Server must start with `https://`; check the client log shows `wss://` |
| Online but disconnects on connect | Both sides' Key must match the `key` in `config.json`; check `npm run tail` for `relay auth failed` |
| Cannot connect from Mainland China | Bind your own domain (`workers.dev` is blocked); note Cloudflare has no free-tier PoPs in Mainland China, so 150–300 ms+ latency is expected |
| Everything suddenly fails | Free quota exhausted; resets daily at 00:00 UTC |

## License

[MIT](LICENSE). Protocol-compatible with the [RustDesk](https://github.com/rustdesk/rustdesk) client WebSocket mode.
