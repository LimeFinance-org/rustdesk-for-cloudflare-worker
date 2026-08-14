<div align="right">

[English](README.md) | **中文**

</div>

# rustdesk-for-cloudflare-worker

**用 Cloudflare Workers 免费承载 RustDesk 服务端（hbbs/hbbr）——无需购买 VPS。**

RustDesk 客户端内置 "Use WebSocket" 模式，本项目在 Cloudflare Workers 上实现信令（`/ws/id`）与中继（`/ws/relay`）服务，你只需要一个 Cloudflare 免费账号和一个域名。

1.4.9 客户端已验证（1.4.3+ 可用）。基于 [lichon/hbbs-worker](https://github.com/lichon/hbbs-worker) 改进。

## 限制

- 所有连接强制走中继（WebSocket 模式不做 P2P 打洞）
- 免费额度：日常轻中度使用足够；全天高帧率视频流约够 10 小时/天
- 延迟比原生 hbbr 略高：通常 +50~150ms

## 部署

准备：一个 [Cloudflare 免费账号](https://dash.cloudflare.com/sign-up)（域名托管在其中）+ Node.js ≥ 18。

> ⚠️ 默认的 `workers.dev` 域名在**中国大陆被屏蔽**，请绑定自己的域名。

```bash
npm install
npx wrangler login          # 浏览器中点 Allow
npm run setup               # 生成 config.json —— 在里面填你的域名和密钥
npm run deploy              # 密钥自动上传为 Cloudflare Secret 并部署
```

自动生成的 `config.json`（已 gitignore，不会提交）：

```json
{
	"domain": "rust.example.com",       // ← 你的域名（须托管在当前 Cloudflare 账号）
	"key": "一串20位以上的随机字符"        // ← 同时填进每个 RustDesk 客户端的 Key 字段
}
```

验证（替换域名，返回 `101` 即成功）：

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://rust.example.com/ws/id
```

## 客户端配置（两端设备都要做）

RustDesk → 设置 → 网络 → 解锁高级网络设置：

| 配置项 | 填写内容 |
|---|---|
| **Use WebSocket** | ✅ 勾选 |
| ID 服务器 | 你的域名（不带端口和协议头） |
| 中继服务器 | 你的域名 |
| API Server | `https://你的域名`（必须带 https） |
| Key | `config.json` 里的 `key` |

被控端显示 **"就绪"** 即注册成功。服务端日志：`npm run tail`。

## 安全

- 全程 wss（TLS）传输；会话内容由 RustDesk 端到端加密，服务端只转发密文
- 中继请求必须携带正确的 `key`，否则拒绝
- 默认最多 100 个在线 ID（防滥用），可用 `npx wrangler secret put MAX_SESSIONS` 调整
- 建议被控端同时设置强密码或 2FA

## 常见问题

| 现象 | 解决 |
|---|---|
| 客户端一直不"就绪" | API Server 必须以 `https://` 开头；确认客户端日志显示 `wss://` |
| 能上线但一连就断 | 两端 Key 必须与 `config.json` 的 `key` 一致；看 `npm run tail` 有无 `relay auth failed` |
| 中国大陆连不上 | 必须绑自己的域名（`workers.dev` 被屏蔽）；Cloudflare 免费版在中国大陆没有节点，延迟 150~300ms 起属正常 |
| 突然全部连不上 | 免费额度用尽，每天 UTC 0 点（北京 8 点）恢复 |

## 许可

[MIT](LICENSE)。协议兼容 [RustDesk](https://github.com/rustdesk/rustdesk) 客户端 WebSocket 模式。
