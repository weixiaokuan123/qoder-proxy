/**
 * qoder-proxy HTTP 服务。
 *
 * 管理面（REST，直接读桌面端登录态）：
 *
 *   GET  /health              存活探针
 *   GET  /status              全区域概览：账号、套餐、额度、签到状态
 *   GET  /usage?region=cn     单区域额度明细
 *   GET  /signin?region=cn    单区域签到状态
 *   POST /signin/claim        立即执行签到（全部区域或指定 region）
 *   GET  /schedule            今日签到计划时刻（各区域）
 *
 * 推理面（走官方 qodercli 子进程，见 src/cli.ts）：
 *
 *   GET  /cli/status                 qodercli 安装/登录/可用模型/并发占用
 *   GET  /v1/models                  模型发现（OpenAI 风格列表）
 *   POST /v1/chat/completions        OpenAI 兼容推理入口（支持 stream: true 的 SSE 回放）
 *
 * 账号来源是**桌面端登录态**（只读 `auth.v1.dat`），不做账号池、不做端口分账号
 * —— Qoder 桌面端同一区域只保留一份登录态，多账号需要用户自行在客户端切换。
 * 推理面用的是 qodercli 自己的登录态（`qodercli login`），与桌面端凭据相互独立。
 *
 * @module qoder-proxy/serve
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { defaultLayout, describeExpiry, probeCredential, type QoderRegion } from './auth.ts'
import { cliConcurrency, isCliAvailable, probeCli, runCli } from './cli.ts'
import { QoderSigninService } from './signin.ts'
import { QoderUpstreamClient, QoderUpstreamError } from './upstream.ts'
import { QODER_PROXY_VERSION } from './version.ts'

/** 支持的区域列表。 */
export const REGIONS: readonly QoderRegion[] = ['cn', 'global']

/** 默认端口：与 workbuddy(39301/39302)、trae(39303/39304)、minimax(39305/39306) 错开。 */
export function defaultPort(): number {
  return Number(process.env['QODER_PROXY_PORT'] ?? 39320)
}

/** 单区域运行时上下文。 */
interface RegionRuntime {
  region: QoderRegion
  client: QoderUpstreamClient
}

function log(message: string): void {
  const ts = new Date().toISOString()
  process.stdout.write(`[${ts}] ${message}\n`)
}

/** 组装某区域的完整状态（账号 + 套餐 + 额度 + 签到）。 */
async function regionStatus(rt: RegionRuntime): Promise<Record<string, unknown>> {
  const probe = await probeCredential(rt.region)
  if (!probe.ok) {
    return {
      region: rt.region,
      loggedIn: false,
      error: probe.code,
      message: probe.message,
      userDataDir: defaultLayout(rt.region).userDataDir,
    }
  }

  const credential = probe.credential
  const base: Record<string, unknown> = {
    region: rt.region,
    loggedIn: true,
    uid: credential.uid,
    name: credential.name,
    email: credential.email,
    phone: credential.phone,
    tokenExpiresAt: credential.expiresAt,
    tokenExpiresIn: describeExpiry(credential.expiresAt),
  }

  // 三个上游查询互不依赖，并发取；任一失败只标记该段，不影响其它段。
  const [info, plan, usage, signin] = await Promise.allSettled([
    rt.client.fetchUserInfo(credential),
    rt.client.fetchPlan(credential),
    rt.client.fetchUsage(credential),
    new QoderSigninService({ resolve: async () => credential }, rt.client).getStatus(),
  ])

  if (info.status === 'fulfilled') {
    base['account'] = info.value
  } else {
    base['accountError'] = errorText(info.reason)
  }

  if (plan.status === 'fulfilled') {
    const p = plan.value
    base['plan'] = {
      userType: p.userType,
      planTierName: p.planTierName,
      isPaidPlan: p.isPaidPlan,
      isHighestTier: p.isHighestTier,
      endDateMs: p.endDateMs,
    }
  } else {
    base['planError'] = errorText(plan.reason)
  }

  if (usage.status === 'fulfilled') {
    const u = usage.value
    base['usage'] = {
      total: u.total,
      used: u.used,
      remaining: u.remaining,
      unit: u.unit,
      percentage: u.percentage,
      isQuotaExceeded: u.isQuotaExceeded,
      expiresAtMs: u.expiresAtMs,
    }
  } else {
    base['usageError'] = errorText(usage.reason)
  }

  if (signin.status === 'fulfilled') {
    const s = signin.value
    base['signin'] = {
      claimable: s.claimable,
      todayCheckedIn: s.todayCheckedIn,
      hasBenefitCampaign: s.hasBenefitCampaign,
      claimableAmount: s.claimableAmount,
      dailyCredit: s.dailyCredit,
      validityDays: s.validityDays,
      title: s.title,
      description: s.description,
      streakDays: s.streakDays,
      claimableCampaigns: s.claimableCampaigns.map(c => ({
        campaignId: c.campaignId,
        campaignKey: c.campaignKey,
        amount: c.benefitAmount,
        kind: c.benefitKind,
        validityDays: c.benefitValidityDays,
        endAtSec: c.endAtSec,
      })),
    }
  } else {
    base['signinError'] = errorText(signin.reason)
  }

  return base
}

/** 把任意错误转成可读文本，并保留上游状态码。 */
function errorText(reason: unknown): string {
  if (reason instanceof QoderUpstreamError) {
    const code = reason.code !== undefined ? ` [${reason.code}]` : ''
    const status = reason.status !== undefined ? ` (HTTP ${reason.status})` : ''
    return `${reason.message}${code}${status}`
  }
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/** 从 query 里取 region；非法值返回 null。 */
function readRegion(url: URL): QoderRegion | null | 'all' {
  const raw = url.searchParams.get('region')
  if (raw === null || raw === '' || raw === 'all') return 'all'
  if (raw === 'cn' || raw === 'global') return raw
  return null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 官方 CLI `--list-models` 暴露的模型清单（去掉表头），供 /v1/models 发现用。 */
export const KNOWN_CLI_MODELS: readonly string[] = [
  'Auto', 'Ultimate', 'Performance', 'Efficient', 'Sonus', 'Cantus',
  'Qwen3.8-Max', 'Qwen3.8-Flash', 'Qwen3.7-Max', 'Qwen3.7-Plus',
  'Kimi-K3', 'Kimi-K2.8-Preview', 'GLM-5.3', 'GLM-5.3-Flash',
  'DeepSeek-V4-Pro', 'DeepSeek-Flash', 'MiniMax-M3',
]

interface SseUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/**
 * 以 OpenAI SSE 流协议回放一段完整文本。
 *
 * qodercli 的 `-p` 模式不产生 token 级增量（assistant 文本整块一次到达），
 * 因此这里在拿到完整结果后**回放**成分片 chunk——协议上与真流式无异，
 * 客户端（如 opencode）能正常逐块消费，但延迟收益为零（总耗时仍由 CLI 决定）。
 *
 * 必须在调用成功后才调用：一旦 writeHead 就无法再返回 502。
 */
function sendSseChatCompletion(
  res: ServerResponse,
  opts: { id: string; created: number; model: string; text: string; usage: SseUsage },
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: SseUsage): string => {
    const payload: Record<string, unknown> = {
      id: opts.id,
      object: 'chat.completion.chunk',
      created: opts.created,
      model: opts.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }
    if (usage !== undefined) payload['usage'] = usage
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  // 首块声明角色
  res.write(chunk({ role: 'assistant', content: '' }, null))

  // 内容分片回放
  const PIECE = 48
  for (let i = 0; i < opts.text.length; i += PIECE) {
    res.write(chunk({ content: opts.text.slice(i, i + PIECE) }, null))
  }

  res.write(chunk({}, 'stop', opts.usage))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 读取并解析请求体（限 1MB）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 1_048_576) throw new Error('请求体超过 1MB 上限')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/**
 * 把 OpenAI 风格的 messages 拍平成单段提示词。
 *
 * qodercli 是 agent 而非无状态补全接口，没有 system/user/assistant 角色概念，
 * 因此这里把历史对话拼成带角色标注的纯文本，交给 CLI 当作一次任务提示。
 */
function flattenMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue
    const item = m as { role?: unknown; content?: unknown }
    const role = typeof item.role === 'string' ? item.role : 'user'
    let text = ''
    if (typeof item.content === 'string') {
      text = item.content
    } else if (Array.isArray(item.content)) {
      text = item.content
        .map(part => {
          if (typeof part === 'string') return part
          if (typeof part === 'object' && part !== null) {
            const p = part as { type?: unknown; text?: unknown }
            return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    if (!text.trim()) continue
    if (role === 'system') parts.push(`[系统指令]\n${text}`)
    else if (role === 'assistant') parts.push(`[助手]\n${text}`)
    else parts.push(text)
  }
  return parts.join('\n\n')
}

export interface ServeOptions {
  port?: number
  host?: string
}

export async function startServer(options: ServeOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const port = options.port ?? defaultPort()
  const host = options.host ?? '127.0.0.1'

  const runtimes: RegionRuntime[] = REGIONS.map(region => ({
    region,
    client: new QoderUpstreamClient(region),
  }))

  const started = Date.now()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: errorText(error) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    const path = url.pathname

    if (path === '/health') {
      sendJson(res, 200, {
        ok: true,
        version: QODER_PROXY_VERSION,
        uptimeSec: Math.floor((Date.now() - started) / 1000),
      })
      return
    }

    if (path === '/status') {
      const wanted = readRegion(url)
      if (wanted === null) {
        sendJson(res, 400, { error: 'region 必须是 cn 或 global' })
        return
      }
      const targets = wanted === 'all' ? runtimes : runtimes.filter(r => r.region === wanted)
      const regions = await Promise.all(targets.map(rt => regionStatus(rt)))
      sendJson(res, 200, {
        version: QODER_PROXY_VERSION,
        generatedAt: new Date().toISOString(),
        regions,
      })
      return
    }

    if (path === '/usage') {
      const wanted = readRegion(url)
      if (wanted === null || wanted === 'all') {
        sendJson(res, 400, { error: 'region 必须是 cn 或 global' })
        return
      }
      const probe = await probeCredential(wanted)
      if (!probe.ok) {
        sendJson(res, 200, { region: wanted, loggedIn: false, error: probe.code, message: probe.message })
        return
      }
      const rt = runtimes.find(r => r.region === wanted)
      if (rt === undefined) {
        sendJson(res, 500, { error: '内部错误：区域运行时缺失' })
        return
      }
      const [usage, plan] = await Promise.all([
        rt.client.fetchUsage(probe.credential),
        rt.client.fetchPlan(probe.credential),
      ])
      sendJson(res, 200, { region: wanted, loggedIn: true, usage, plan })
      return
    }

    if (path === '/signin') {
      const wanted = readRegion(url)
      if (wanted === null) {
        sendJson(res, 400, { error: 'region 必须是 cn 或 global' })
        return
      }
      const targets = wanted === 'all' ? runtimes : runtimes.filter(r => r.region === wanted)
      const out: unknown[] = []
      for (const rt of targets) {
        const probe = await probeCredential(rt.region)
        if (!probe.ok) {
          out.push({ region: rt.region, loggedIn: false, error: probe.code, message: probe.message })
          continue
        }
        try {
          const svc = new QoderSigninService({ resolve: async () => probe.credential }, rt.client)
          const view = await svc.getStatus()
          out.push({ region: rt.region, loggedIn: true, ...view })
        } catch (error: unknown) {
          out.push({ region: rt.region, loggedIn: true, error: errorText(error) })
        }
      }
      sendJson(res, 200, { generatedAt: new Date().toISOString(), signin: out })
      return
    }

    if (path === '/signin/claim') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '请用 POST' })
        return
      }
      const wanted = readRegion(url)
      if (wanted === null) {
        sendJson(res, 400, { error: 'region 必须是 cn 或 global' })
        return
      }
      const targets = wanted === 'all' ? runtimes : runtimes.filter(r => r.region === wanted)
      const results: unknown[] = []
      for (const rt of targets) {
        const probe = await probeCredential(rt.region)
        if (!probe.ok) {
          results.push({ region: rt.region, ok: false, error: probe.code, message: probe.message })
          continue
        }
        try {
          const svc = new QoderSigninService({ resolve: async () => probe.credential }, rt.client)
          const r = await svc.claim()
          results.push({
            region: rt.region,
            ok: true,
            claimed: r.claimed,
            already: r.already,
            message: r.message,
            grantId: r.grantId,
            amount: r.amount,
            kind: r.kind,
            validityDays: r.validityDays,
          })
        } catch (error: unknown) {
          results.push({ region: rt.region, ok: false, error: errorText(error) })
        }
      }
      sendJson(res, 200, { generatedAt: new Date().toISOString(), results })
      return
    }

    if (path === '/cli/status') {
      const probe = await probeCli()
      sendJson(res, 200, {
        installed: probe.installed,
        available: isCliAvailable(),
        loggedIn: probe.loggedIn,
        statusText: probe.statusText,
        models: probe.models,
        concurrency: cliConcurrency(),
        maxConcurrency: Number(process.env['QODER_CLI_MAX_CONCURRENCY'] ?? 2),
        timeoutMs: Number(process.env['QODER_CLI_TIMEOUT_MS'] ?? 180000),
      })
      return
    }

    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { message: '请用 POST', type: 'invalid_request_error' } })
        return
      }

      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (error: unknown) {
        sendJson(res, 400, { error: { message: errorText(error), type: 'invalid_request_error' } })
        return
      }

      const prompt = flattenMessages(body['messages'])
      if (!prompt.trim()) {
        sendJson(res, 400, {
          error: { message: 'messages 为空或无可提取文本', type: 'invalid_request_error' },
        })
        return
      }

      const model = typeof body['model'] === 'string' && body['model'] !== '' ? body['model'] : undefined
      const wantStream = body['stream'] === true
      const result = await runCli({ prompt, ...(model !== undefined ? { model } : {}) })

      const created = Math.floor(Date.now() / 1000)
      if (!result.ok) {
        // 尚未写响应头，两种模式都能干净地返回 502
        sendJson(res, 502, {
          error: { message: result.error ?? 'qodercli 调用失败', type: 'upstream_error' },
          qoder: { durationMs: result.durationMs, timedOut: result.timedOut, code: result.code },
        })
        return
      }

      const id = `chatcmpl-qoder-${created}-${Math.random().toString(36).slice(2, 10)}`
      const responseModel = model ?? 'qoder-auto'
      const usage: SseUsage = {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(result.text.length / 4),
        total_tokens: Math.ceil((prompt.length + result.text.length) / 4),
      }

      if (wantStream) {
        sendSseChatCompletion(res, { id, created, model: responseModel, text: result.text, usage })
        return
      }

      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text },
            finish_reason: 'stop',
          },
        ],
        usage,
        qoder: { durationMs: result.durationMs },
      })
      return
    }

    if (path === '/v1/models' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, {
        object: 'list',
        data: KNOWN_CLI_MODELS.map((id) => ({ id, object: 'model', owned_by: 'qoder' })),
      })
      return
    }

    sendJson(res, 404, { error: 'Not found', path })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  log(`qoder-proxy v${QODER_PROXY_VERSION} 已监听 http://${host}:${port}`)

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      }),
  }
}
