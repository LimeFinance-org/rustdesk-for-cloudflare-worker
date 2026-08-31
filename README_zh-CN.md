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
npm run setup               # 首次运行只生成 config.json，然后退出
# 编辑 config.json，填入你的域名、密钥和可选的 locationHint
npm run setup               # 再次运行：生成部署配置并上传 Secret
npm run deploy              # 使用 setup 生成的配置部署；不会重复上传 Secret
```

自动生成的 `config.json`（已 gitignore，不会提交）：

```json
{
	"domain": "rust.example.com",
	"key": "一串20位以上的随机字符",
	"locationHint": "apac"
}
```

`locationHint` 默认是 `apac`，适合中国及亚太用户；也可以选择 `apac-ne` 或 `apac-se`。它只是 Durable Object 的区域提示，不是固定的中国 IP，也不是精确到国家/城市的保证。已经创建的 Durable Object 不会因为修改 Hint 自动迁移。

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

## 多会话与性能

- 每次远程连接都会创建一个独立的 HBBR Durable Object；多个远程会话不会共用视频帧缓冲，也不会因为某一条会话变慢而串流到另一条会话。
- HBBS Durable Object 只负责上线、查询和建立中继，真正的远程数据帧只在对应的 HBBR 中转发；因此可以同时开多个远程会话。
- `MAX_SESSIONS` 限制的是在线设备 ID 数量，不是同时远程会话数量。单个 HBBR 会话固定接收两条 WebSocket（两端各一条）。
- 默认每条中继的发送缓冲上限为 2 MiB，优先兼顾交互延迟和多会话内存；不要为了“更快”盲目调大。

如果同时上线的客户端很多，可以按压测结果调整（这些是普通配置项，也可以在 Cloudflare Dashboard 的 Variables 中设置）：

```bash
# 大屏/文件传输吞吐优先时再考虑 4194304；交互远程保持默认 2097152
npx wrangler secret put MAX_RELAY_BUFFERED_BYTES -c wrangler.local.json

# 只控制“尚未完成注册”的等待连接，不限制已经建立的远程会话
npx wrangler secret put MAX_PENDING_CONNECTIONS -c wrangler.local.json
```

## 安全

- 全程 wss（TLS）传输；Worker 只转发 WebSocket 帧
- 中继请求必须携带正确的 `key`，否则拒绝；这里的 `key` 是本项目的 Relay 接入密钥，不等同于原生 hbbs 的服务器公钥
- 默认最多 100 个在线 ID（防滥用），可用 `npx wrangler secret put MAX_SESSIONS` 调整
- 建议被控端同时设置强密码或 2FA

## 常见问题

| 现象 | 解决 |
|---|---|
| 客户端一直不"就绪" | API Server 必须以 `https://` 开头；确认客户端日志显示 `wss://` |
| 能上线但一连就断 | 两端 Key 必须与 `config.json` 的 `key` 一致；看 `npm run tail` 有无 `relay auth failed` |
| 中国大陆连不上 | 必须绑自己的域名（`workers.dev` 被屏蔽）；普通 Workers 不能保证中国大陆节点或固定中国 IP，可先保持 `locationHint: "apac"` 并实测 |
| 突然全部连不上 | 免费额度用尽，每天 UTC 0 点（北京 8 点）恢复 |

## 许可

[MIT](LICENSE)。协议兼容 [RustDesk](https://github.com/rustdesk/rustdesk) 客户端 WebSocket 模式。
