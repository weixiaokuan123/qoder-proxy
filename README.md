# qoder-proxy

把 **Qoder 桌面端**（国际版 / 国内版）的本机登录态，以只读方式暴露成一个本地管理服务，
并每天 **10:00 之后随机时刻**自动领取每日签到积分（100 Credits）。

与同目录下的 `workbuddy-proxy`、`trae-proxy`、`minimax-proxy` 一脉相承：**零依赖**
（没有 `package.json`、没有 `node_modules`，`.ts` 直接由 Node 原生类型剥离执行）。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **读取登录态** | 只读解析桌面端 `auth.v1.dat`（Electron `safeStorage` 加密），拿到访问令牌 |
| **账号概览** | 昵称、邮箱/手机、令牌有效期 |
| **套餐信息** | 当前套餐等级与到期时间 |
| **额度查询** | 剩余 / 已用 / 总额度，是否超额 |
| **每日自动签到** | 每天 10:00 后随机时刻领取 100 Credits（官方每日 10:00 UTC+8 刷新） |
| **手动签到** | `POST /signin/claim` 立即执行，幂等安全 |

> **它不做什么**：Qoder 的模型推理**不是公开 REST 接口**（`/v1/chat/completions` 在两个
> 网关上都是 404），而是走 CLI 的 SDK 私协议。因此本项目**不提供** OpenAI / Anthropic
> 兼容的推理入口，只做账号与签到管理。

---

## 快速开始

```powershell
# 启动（后台常驻）
powershell -ExecutionPolicy Bypass -File scripts\start.ps1

# 查看状态
powershell -ExecutionPolicy Bypass -File scripts\status.ps1

# 停止
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```

服务监听 `http://127.0.0.1:39320`。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 存活探针，返回版本与运行时长 |
| `GET` | `/status` | 全区域概览：账号 + 套餐 + 额度 + 签到状态 |
| `GET` | `/status?region=cn` | 只看国内版（`cn` / `global`） |
| `GET` | `/usage?region=cn` | 单区域额度与套餐明细 |
| `GET` | `/signin` | 签到状态（可领项、今日是否已领） |
| `POST` | `/signin/claim` | 立即签到（默认全部区域，可用 `?region=` 限定） |

示例：

```bash
curl http://127.0.0.1:39320/status
curl -X POST "http://127.0.0.1:39320/signin/claim?region=cn"
```

---

## 签到机制

Qoder 官方把每日赠送建模成**活动（campaign）**，而不是一个「打卡」端点：

```
GET  {openapi}/sash/api/v1/me/campaigns                    列出活动与领取状态
POST {openapi}/sash/api/v1/me/campaigns/{campaignId}/claim  领取（幂等）
```

- 官方规则：**每日 10:00（UTC+8）刷新**，奖励 100 Credits，领取后 30 天有效
- 领取用 `campaignId`（UUID），不是 `campaignKey`
- **服务端幂等**：重复领取返回同一个 `grantId` 且 `replayed: true`，可安全重试
- 状态流转：`CLAIMABLE` → `CLAIMED`

### 调度策略

每天在本地 **10:00–24:00** 之间随机一个时刻执行，计划生成后立即持久化到
`state/signin.json`，**重启不重摇**；跨天自动重排。这与另外三个代理共用同一套
调度实现（`src/scheduler.ts`）。

三种结果语义：

| 情形 | 行为 |
|---|---|
| 本次领到 | 标记当天完成 |
| 服务端确认已领 | 标记当天完成 |
| 该区域没有签到活动 | 标记当天完成（不是故障，避免空跑） |
| 活动存在但未到刷新时间 | 抛错，稍后重试 |

> 注意：当前**国内版有每日签到活动**，国际版暂无（只有订阅推广活动）。调度器会自动
> 识别，不会在国际版上反复重试。

---

## 凭据是怎么读到的

Qoder 桌面端把登录凭据存在 Electron 的 userData 目录：

```
%APPDATA%\com.qoder.app.stable\auth.v1.dat       国际版
%APPDATA%\com.qodercn.app.stable\auth.v1.dat     国内版
```

写入方式是 Electron 的 `safeStorage.encryptString()`，在 Windows 上产出 Chromium 的
`v10` 密文：

```
"v10" || nonce(12) || ciphertext || tag(16)      算法 AES-256-GCM
```

主密钥在同目录的 `Local State` → `os_crypt.encrypted_key`（base64，解出后以 `DPAPI`
五字节开头），需要经 Windows DPAPI（当前用户作用域）解保护。因此完整链路是：

```
DPAPI(encrypted_key) → 32 字节 AES 主密钥 → 解 auth.v1.dat → JSON 凭据
```

解出的明文结构：

```json
{
  "schemaVersion": 1,
  "token": "dt-...",
  "refreshToken": "drt-...",
  "expiresAt": "2026-10-24T09:05:59Z",
  "user": { "id": "...", "name": "...", "email": "...", "phone": null }
}
```

**两个区域各有独立的 `Local State` 与独立主密钥**，不能混用。

### 安全边界

- 全程**只读** —— 绝不写回 `auth.v1.dat`，登录态的归属权始终在官方客户端
- DPAPI 是**用户作用域**的，换机器 / 换账户无法解开，凭据天然不可移植
- 令牌只留在进程内存，不落地；`state/` 只存签到计划，不含任何凭据
- 服务只监听 `127.0.0.1`

---

## 目录结构

```
qoder-proxy/
├── src/
│   ├── auth.ts        凭据读取（DPAPI + AES-256-GCM 解密）
│   ├── upstream.ts    Qoder 上游 HTTP 客户端（账号/套餐/额度/活动/领取）
│   ├── signin.ts      签到适配层（状态判定 + 领取语义）
│   ├── scheduler.ts   每日随机时刻调度器（与其它代理共用）
│   ├── serve.ts       HTTP 管理服务
│   ├── main.ts        进程入口（服务 + 调度）
│   └── version.ts     版本号
├── scripts/           start / stop / status
├── test/              单元测试（40 项）
└── state/             签到计划持久化（运行时生成）
```

---

## 测试

```powershell
node --test test/signin.test.ts test/auth-scheduler.test.ts test/crypto-upstream.test.ts
```

全部离线：加解密用自造密钥与临时文件，上游解析用假 `fetch`，
**不触碰真实的 `auth.v1.dat`**。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `QODER_PROXY_PORT` | `39320` | 监听端口 |
| `QODER_SIGNIN_START_HOUR` | `10` | 签到窗口起点（小时） |
| `QODER_SIGNIN_END_HOUR` | `24` | 签到窗口终点（小时） |
| `QODER_USER_DATA` / `QODER_CN_USER_DATA` | 自动探测 | 覆盖 Electron userData 目录 |
| `QODER_HOME` / `QODER_CN_HOME` | 自动探测 | 覆盖 `~/.qoder` 目录 |
| `QODER_OPENAPI` / `QODER_CN_OPENAPI` | 官方域名 | 覆盖上游 API 域名 |

---

## 已知限制

- **不支持模型推理**：Qoder 推理走 CLI 私协议，不是公开 REST。
- **单账号 per 区域**：桌面端同一区域只保留一份登录态，多账号需在客户端手动切换。
- **依赖桌面端登录**：令牌过期后需在 Qoder 客户端重新登录；本项目不做自动刷新
  （刷新令牌虽已读出，但主动刷新容易被风控识别，故不实现）。

---

## 版本

当前 `0.1.0`。发布规则：只 bump PATCH。
