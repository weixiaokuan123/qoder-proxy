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
| **模型推理** | `POST /v1/chat/completions`（OpenAI 兼容），经官方 qodercli 子进程执行 |

> **推理是怎么实现的**：Qoder 的模型推理**不是公开 REST 接口**（`/v1/chat/completions`
> 在两个网关上都是 404）。官方为自动化场景提供了 **Agent SDK + 独立 CLI**
> （`@qoder-ai/qodercli`），推理在本地 `qodercli` 子进程内完成。
> 本项目据此把 CLI 包成 OpenAI 兼容入口，**不逆向任何私有协议**。
> 详见 [模型推理](#模型推理)。

---

## 快速开始

```powershell
# 启动（后台常驻）
powershell -ExecutionPolicy Bypass -File scripts\start.ps1

# 查看状态
powershell -ExecutionPolicy Bypass -File scripts\status.ps1

# 停止
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1

# 注册「登录时静默自启」（可选，推荐）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
# 取消自启
powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
```

服务监听 `http://127.0.0.1:39320`。

> 自启通过计划任务（`qoder-proxy-autostart`，触发器为当前用户登录）调用一个隐藏窗口的
> `.vbs`，因此不会弹出控制台窗口。注册后重启电脑也会自动常驻。

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
| `GET` | `/cli/status` | qodercli 安装/登录/可用模型/并发占用 |
| `POST` | `/v1/chat/completions` | OpenAI 兼容推理入口 |

示例：

```bash
# 管理面
curl http://127.0.0.1:39320/status
curl -X POST "http://127.0.0.1:39320/signin/claim?region=cn"

# 推理面
curl http://127.0.0.1:39320/cli/status
curl -X POST http://127.0.0.1:39320/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"用一句话说明什么是递归"}]}'
```

---

## 模型推理

推理走**官方 qodercli 子进程**，不是 REST 转发（Qoder 的推理端点不对外公开）。

### 一次性准备

```powershell
# 1. 装内嵌运行时（68MB，落在 vendor/，不进版本库）
cd vendor
npm install

# 2. 登录一次（会打开浏览器 OAuth）
powershell -ExecutionPolicy Bypass -File scripts\login-qodercli.ps1
```

登录态由 qodercli 自己保管（`--config-dir` 可指向独立配置目录做多账号隔离），
本项目**不接触**该凭据。

### 调用形态

```jsonc
POST /v1/chat/completions
{
  "model": "auto",              // 可选：auto / performance / efficient / lite
  "messages": [                 // OpenAI 风格；system/assistant 会被拼成角色标注文本
    { "role": "system", "content": "你是一个简洁的助手" },
    { "role": "user", "content": "什么是递归？" }
  ]
}
```

响应是标准 OpenAI `chat.completion` 结构，另附 `qoder.durationMs` 供观测。

### 关键设计与约束

| 项 | 取值 | 原因 |
|---|---|---|
| 每次请求 | **一个短命子进程** | 官方明确「一个本地 session 由一个 qodercli 进程独占」 |
| 工具集 | `--tools ""` **全部禁用** | 使其退化为纯对话，不读文件、不跑命令 |
| 权限模式 | `--permission-mode dont_ask` | 无人值守，不做交互确认 |
| 会话持久化 | 关闭 | 避免磁盘堆积 |
| 并发 | **默认 2**（`QODER_CLI_MAX_CONCURRENCY`） | 每个进程约 100–200MB，开大易爆内存 |
| 超时 | **默认 180s**（`QODER_CLI_TIMEOUT_MS`） | CLI 要起进程 + 握手 + 推理 |

> **流式（`stream: true`）暂不支持**——当前实现在子进程退出后一次性返回。
> 需要真流式时应改用 SDK 的消息迭代器（`query()` 的 `for await`），而非 CLI `-p`。

> **性能预期**：每个请求都要付「起进程 + 握手」的固定开销，因此**单次延迟明显高于
> 纯 REST 代理**，不适合高频小请求。这是子进程架构的固有代价。

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
│   ├── cli.ts         qodercli 子进程驱动（推理面）
│   ├── serve.ts       HTTP 管理 + 推理服务
│   ├── main.ts        进程入口（服务 + 调度）
│   └── version.ts     版本号
├── scripts/           start / stop / status / login-qodercli / install-autostart / uninstall-autostart
├── vendor/            内嵌 qodercli 运行时（node_modules 不入库）
├── test/              单元测试（46 项）
└── state/             签到计划持久化（运行时生成）
```

---

## 测试

```powershell
node --test test/signin.test.ts test/auth-scheduler.test.ts test/crypto-upstream.test.ts test/cli.test.ts
```

全部离线：加解密用自造密钥与临时文件，上游解析用假 `fetch`，
CLI 层只测可确定的纯逻辑（不启动真实进程），
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
| `QODER_CLI_ENTRY` | 内嵌 vendor | 覆盖 qodercli 可执行入口（自管运行时） |
| `QODER_CLI_CONFIG_DIR` | CLI 默认 | 传 `--config-dir`，用于多账号配置隔离 |
| `QODER_CLI_MAX_CONCURRENCY` | `2` | 同时在跑的 qodercli 进程上限 |
| `QODER_CLI_TIMEOUT_MS` | `180000` | 单次推理超时 |

---

## 已知限制

- **流式输出未实现**：`stream: true` 会被忽略，响应一次性返回。需要真流式须改用 SDK 消息迭代器。
- **单次延迟偏高**：每个请求一个子进程，需付「起进程 + 握手」固定开销，不适合高频小请求。
- **推理凭据独立**：推理用 qodercli 自己的登录态（`qodercli login`），与桌面端
  `auth.v1.dat` 是两套体系——桌面端令牌可用于签到，但**不能**直接驱动 CLI 推理。
- **单账号 per 区域**：桌面端同一区域只保留一份登录态，多账号需在客户端手动切换。
- **依赖桌面端登录**：令牌过期后需在 Qoder 客户端重新登录；本项目不做自动刷新
  （刷新令牌虽已读出，但主动刷新容易被风控识别，故不实现）。

---

## 版本

当前 `0.1.3`。发布规则：只 bump PATCH。
