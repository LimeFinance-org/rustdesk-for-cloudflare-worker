<div align="right">

[English](README.md) | **中文**

</div>

# rustdesk-for-cloudflare-worker

**用 Cloudflare Workers + Durable Objects 免费承载 RustDesk 的信令与中继服务——不需要购买任何 VPS。**

基于 [lichon/hbbs-worker](https://github.com/lichon/hbbs-worker) 改进：单文件配置、密钥鉴权、注册上限防护与保姆级文档。

> 适用于 RustDesk 客户端 **1.4.3+**（1.4.9 已验证）。原理：RustDesk 客户端内置 "Use WebSocket" 模式，
> 信令走 `wss://你的域名/ws/id`、中继走 `wss://你的域名/ws/relay/{会话ID}`，本项目在 Cloudflare 上
> 用 Durable Objects 实现了与 hbbs/hbbr 等价的 WebSocket 协议子集。

---

## ✨ 特性

- 🆓 **零服务器成本**：只用 Cloudflare 免费额度（Workers + Durable Objects 免费版）
- 🔐 **中继密钥鉴权**：客户端 Key 字段不匹配的请求直接拒绝，防止陌生人白嫖额度
- 🚦 **注册上限防护**：会话表满后拒绝新注册，防止批量刷注册
- 🌐 **域名全自动托管**：部署时自动创建 DNS 记录 + 自动签发 TLS 证书，无需手动解析
- 📦 **一键部署**：`npm run deploy` 自动生成配置、上传密钥并部署

## ⚠️ 先了解这些限制（重要）

| 限制 | 说明 |
|---|---|
| 强制中继 | WebSocket 模式下 RustDesk 不做 P2P 打洞，所有连接走中继 |
| 免费额度 | Durable Objects 免费版每天约 10 万计费请求（入站 WS 消息按 20:1 折算）。轻度办公绰绰有余；全天高帧率视频流约够 10 小时/天 |
| 延迟 | 比原生 hbbr 增加一跳，通常 +50~150ms |
| 无 SLA | 免费服务不保证可用性，DO 可能被休眠（有数据时自动唤醒） |

**不适合**：高帧率设计/视频剪辑远程、大文件频繁传输、多人并发团队使用。

---

## 🚀 部署步骤

### 0. 准备

1. 一个 [Cloudflare 免费账号](https://dash.cloudflare.com/sign-up)
2. 一个域名，且已托管在该 Cloudflare 账号（面板 → Add a site → 按提示修改 NS）
   > ⚠️ 不要依赖默认的 `workers.dev` 域名：**该域名在中国大陆被屏蔽**，中国大陆用户必须绑定自己的域名
3. 本地安装 [Node.js](https://nodejs.org) ≥ 18

### 1. 安装依赖并登录 Cloudflare

```bash
npm install
npx wrangler login        # 浏览器中点 Allow 授权
```

### 2. 生成并填写 config.json（唯一需要改的文件）

```bash
npm run setup
```

首次运行会自动生成 `config.json`（内含 `_说明` 字段指导填写），按提示编辑它：

```json
{
	"domain": "rust.example.com",   // ← 改成你自己的域名（须已托管在当前 CF 账号）
	"key": "一串20位以上的随机字符"    // ← 之后填进每个 RustDesk 客户端的 Key 字段
}
```

> DNS 记录和 TLS 证书在部署时由 Cloudflare 自动创建，无需手动解析。
> `config.json` 已被 gitignore，你的域名和密钥不会被提交。

### 3. 一键部署

```bash
npm run deploy
```

脚本会自动：生成部署配置 → 把 `key` 以 Cloudflare Secret 形式上传（不落仓库）→ 部署 Worker。
看到 `rust.example.com (custom domain)` 字样即成功。验证信令端点：

```bash
curl -s -o /dev/null -w "%{http_code}\n" --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://rust.example.com/ws/id
# 输出 101 表示全链路可用
```

Windows PowerShell（单行版）：

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://rust.example.com/ws/id
```

> 只需把 `rust.example.com` 换成你自己的域名；其余请求头是 WebSocket 握手的固定值，照抄即可。

---

## 🖥️ 客户端配置（控制端和被控端都要做）

安装 [RustDesk](https://github.com/rustdesk/rustdesk/releases)（≥ 1.4.3），进入 **设置 → 网络 → 解锁高级网络设置**：

| 配置项 | 填写内容 |
|---|---|
| **Use WebSocket** | ✅ 勾选 |
| ID 服务器 | `rust.example.com`（你的域名，不带端口和协议头） |
| 中继服务器 | `rust.example.com` |
| API Server | `https://rust.example.com`（必须带 https，否则客户端会用 ws://） |
| Key | `config.json` 里的 `key` |

保存后被控端显示 **"就绪"** 即注册成功。

### 验证

- 被控端日志应出现：`start tcp: wss://rust.example.com/ws/id`
- 服务端日志：`npm run tail`
  - 上线：`Handling register pk id: ...`
  - 连接配对：`setup initiator for uuid...` + `setup acceptor for uuid...`
- 官方网页客户端 https://rustdesk.com/web/ 填你的 wss 域名也可连上

---

## 🔒 安全说明

| 机制 | 说明 |
|---|---|
| 传输加密 | 全程 wss（TLS） |
| 中继鉴权 | `key` 作为 Cloudflare Secret 存储，与客户端 Key 字段比对，不符即断开（`src/hbbs.ts` 的 `handleRequestRelay`） |
| 注册上限 | 默认最多 100 个在线 ID，可用 `npx wrangler secret put MAX_SESSIONS` 调整 |
| 会话内容 | RustDesk 端到端加密，中继只转发密文 |

建议被控端同时设置强固定密码或 2FA。密钥泄露后：改 `config.json` 的 `key` 重新 `npm run deploy`，并同步更新所有客户端即可。

## 📊 免费额度估算

| 使用强度 | 每小时消耗（折算请求） | 每日额度约可用 |
|---|---|---|
| 🟢 轻度（画面大部分静止） | 400–900 | 视为无限 |
| 🟡 中度（日常办公） | 1,800–3,600 | 28–55 小时 |
| 🔴 重度（持续滚动/视频） | 7,000–11,000 | 9–14 小时 |

额度每天 UTC 0 点重置。用量查看：Cloudflare 面板 → Workers & Pages → 你的 Worker → Metrics。

## ❓ 常见问题

| 现象 | 解决 |
|---|---|
| 客户端一直不"就绪" | API Server 是否填了 `https://`；客户端日志 `start tcp:` 后是否为 `wss://` |
| 能上线但一连就断 | 两端 Key 是否一致且等于服务端 `RELAY_KEY`；看 `npm run tail` 有无 `relay auth failed` |
| 部署报域名错误 | 域名必须已托管在当前账号；`custom_domain` 不能带路径或 `*` |
| 中国大陆连不上 | `workers.dev` 默认域名在中国大陆被屏蔽，必须绑定自己的域名；另外 Cloudflare 免费版在中国大陆没有加速节点，延迟偏高（150~300ms 起）属正常现象 |
| 突然全部连不上 | 免费额度用尽，次日 UTC 0 点恢复 |

## 📁 项目结构

```
config.json             # 你的配置（域名+密钥）：首次 npm run setup 自动生成，不入库
scripts/setup.mjs       # 读取 config.json，生成本地部署配置并上传 Secret
src/index.ts            # Worker 入口：路由 /ws/id → Hbbs DO，/ws/relay/:uuid → Hbbr DO
src/hbbs.ts             # Hbbs DO：注册/在线查询/下发中继指令；Hbbr DO：按 uuid 配对转发
src/hbbs-rendezvous.ts  # RustDesk 信令 protobuf 定义（自动生成，勿手改）
wrangler.json           # 部署模板（无需修改）
```

## 🙏 致谢与许可

- 协议实现基于 [lichon/hbbs-worker](https://github.com/lichon/hbbs-worker)（MIT）
- 协议兼容 [RustDesk](https://github.com/rustdesk/rustdesk)（AGPL-3.0）客户端 WebSocket 模式

本项目以 [MIT 许可](LICENSE) 发布。
