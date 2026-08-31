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
npm run setup               # first run creates config.json and exits
# edit config.json with your domain, key, and optional locationHint
npm run setup               # run again to generate deployment config and upload secrets
npm run deploy              # deploys the generated config without re-uploading secrets
```

The generated `config.json` (gitignored, never committed):

```json
{
	"domain": "rust.example.com",
	"key": "a-random-string-20+chars",
	"locationHint": "apac"
}
```

`locationHint` defaults to `apac` for China/APAC users. `apac-ne` and `apac-se` are also available. This is a best-effort Durable Object placement hint, not a country-specific IP, and an existing Durable Object will not move automatically after changing it.

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

## Multiple sessions and performance

- Every remote connection gets its own HBBR Durable Object. Relay frame buffers are not shared between sessions, so a slow session cannot mix with or directly block another session.
- The single named HBBS Durable Object handles signaling, online checks, and relay setup only. Remote data frames are forwarded by the per-session HBBR objects, so multiple remote sessions can run concurrently.
- `MAX_SESSIONS` limits online device IDs, not active remote sessions. Each HBBR session accepts exactly two WebSockets, one from each endpoint.
- The default per-relay send-buffer limit is 2 MiB, balancing interactive latency with memory use across concurrent sessions. Increasing it without measuring can make concurrency worse.

If many clients connect at the same time, tune these optional settings after testing (they are regular string settings and can also be set in the Cloudflare Dashboard under Variables):

```bash
# Consider 4194304 for large-screen/file-transfer throughput; keep 2097152 for interactive use
npx wrangler secret put MAX_RELAY_BUFFERED_BYTES -c wrangler.local.json

# Only limits sockets that have not completed registration; it does not limit active relays
npx wrangler secret put MAX_PENDING_CONNECTIONS -c wrangler.local.json
```

## Security

- All traffic runs over wss (TLS); the Worker only forwards WebSocket frames
- Relay requests must present the `key`; this project key is a Relay admission secret, not the native hbbs server public key
- Max 100 online IDs by default (anti-abuse); adjust with `npx wrangler secret put MAX_SESSIONS`
- Also set a strong password or 2FA on the controlled device

## FAQ

| Symptom | Fix |
|---|---|
| Client never shows "Ready" | API Server must start with `https://`; check the client log shows `wss://` |
| Online but disconnects on connect | Both sides' Key must match the `key` in `config.json`; check `npm run tail` for `relay auth failed` |
| Cannot connect from Mainland China | Bind your own domain (`workers.dev` is blocked); normal Workers cannot guarantee a Mainland China PoP or fixed China IP, so keep `locationHint: "apac"` and benchmark your ISP path |
| Everything suddenly fails | Free quota exhausted; resets daily at 00:00 UTC |

## License

[MIT](LICENSE). Protocol-compatible with the [RustDesk](https://github.com/rustdesk/rustdesk) client WebSocket mode.
