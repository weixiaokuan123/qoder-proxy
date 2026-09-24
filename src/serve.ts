/**
 * qoder-proxy HTTP 服务。
 *
 * 与另外三个代理不同，Qoder 的模型推理走 CLI 的 SDK 私协议（不是公开 REST），
 * 因此本服务**不提供** OpenAI/Anthropic 兼容的推理入口，只提供管理面：
 *
 *   GET  /health              存活探针
 *   GET  /status              全区域概览：账号、套餐、额度、签到状态
 *   GET  /usage?region=cn    单区域额度明细
 *   GET  /signin?region=cn   单区域签到状态
 *   POST /signin/claim       立即执行签到（全部区域或指定 region）
 *   GET  /schedule           今日签到计划时刻（各区域）
 *
 * 账号来源是**桌面端登录态**（只读 `auth.v1.dat`），不做账号池、不做端口分账号
 * —— Qoder 桌面端同一区域只保留一份登录态，多账号需要用户自行在客户端切换。
 *
 * @module qoder-proxy/serve
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { defaultLayout, describeExpiry, probeCredential, type QoderRegion } from './auth.ts'
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
