/**
 * Qoder 上游 HTTP 客户端。
 *
 * 与 WorkBuddy 不同，Qoder 的**模型推理不是公开 REST 接口**（`/v1/chat/completions`
 * 在两个网关上都返回 404，推理走 CLI 的 SDK 私协议）。因此本客户端只覆盖
 * 「账号元数据」这一类确实存在的 REST 能力：
 *
 *   账号信息   GET {openapi}/api/v1/userinfo
 *   套餐       GET {openapi}/api/v2/user/plan
 *   额度用量   GET {openapi}/sash/api/v2/me/usage
 *   签到状态   GET {openapi}/sash/api/v1/me/campaigns
 *   活跃天数   GET {openapi}/sash/api/v1/ai-conversations/seat-activity
 *   积分统计   GET {openapi}/sash/api/v1/ai-conversations/credits-summary
 *
 * 请求头与官方客户端保持一致（`Cosy-ClientType: 10` + `User-Agent: Qoder`），
 * 否则部分端点会拒绝。
 *
 * @module qoder-proxy/upstream
 */

import type { QoderCredential, QoderRegion } from './auth.ts'

/** 单区域端点配置。 */
export interface QoderEndpoints {
  openapi: string
}

/**
 * 默认端点。
 *
 * 官方客户端会通过 `center.qoder.sh/api/v3/service/region/endpoints` 做端点选举，
 * 但实测这两个域名长期稳定，直接写死可少一次网络往返；如上游调整，
 * 可用环境变量覆盖。
 */
export function defaultEndpoints(region: QoderRegion): QoderEndpoints {
  if (region === 'cn') {
    return { openapi: process.env['QODER_CN_OPENAPI'] ?? 'https://openapi.qoder.com.cn' }
  }
  return { openapi: process.env['QODER_OPENAPI'] ?? 'https://openapi.qoder.sh' }
}

/** 官方客户端的客户端标识，服务端会按它区分入口。 */
const CLIENT_TYPE = 10
const CLIENT_VERSION = '0.4.2'

/** 额度信息（来自 /sash/api/v2/me/usage）。 */
export interface QoderUsage {
  /** 展示模式：qoder / enterprise。 */
  displayMode?: string
  /** 套餐类型，如 personal_professional_trial。 */
  userType?: string
  /** 计费单位，通常 credits。 */
  usageType?: string
  /** 已用百分比。 */
  totalUsagePercentage?: number
  /** 是否已超额。 */
  isQuotaExceeded?: boolean
  /** 额度过期时刻（ms）。 */
  expiresAtMs?: number
  /** 升级链接。 */
  upgradeUrl?: string
  /** 额度明细。 */
  total?: number
  used?: number
  remaining?: number
  percentage?: number
  unit?: string
}

/** 套餐信息（来自 /api/v2/user/plan）。 */
export interface QoderPlan {
  userType?: string
  planTierName?: string
  isPersonalVersion?: boolean
  isPaidPlan?: boolean
  isHighestTier?: boolean
  startDateMs?: number
  endDateMs?: number
}

/** 活动文案的本地化内容。 */
export interface QoderLocalizedText {
  title?: string
  description?: string
  buttonText?: string
  detailUrl?: string
}

/** 活动投放位（POPUP 弹窗 / USAGE 使用页）。 */
export interface QoderPlacement {
  type?: string
  campaignUrl?: string
  content?: {
    zh?: QoderLocalizedText
    en?: QoderLocalizedText
  }
}

/** 单个签到活动。 */
export interface QoderCampaign {
  campaignId?: string
  campaignKey?: string
  /** CLAIM_BENEFIT 表示可领取；VIEW_DETAILS 是纯展示活动。 */
  actionType?: string
  /** CLAIMABLE / CLAIMED / ... */
  claimStatus?: string
  startAtSec?: number
  endAtSec?: number
  /** 奖励描述。 */
  benefitKind?: string
  benefitAmount?: number
  benefitValidityDays?: number
  /** 活动投放位，含文案。 */
  placements?: QoderPlacement[]
}

/** 领取结果（服务端返回）。 */
export interface QoderClaimOutcome {
  grantId?: string
  /** CLAIMED 表示已发放。 */
  status?: string
  /** true 表示这是幂等重放（此前已领过）。 */
  replayed: boolean
  /** 实际发放的积分数。 */
  amount?: number
  kind?: string
  validityDays?: number
  claimedAt?: string
}

/** 签到总览。 */
export interface QoderCampaignStatus {
  uid?: string
  showCampaign: boolean
  /** 是否还有可领取项。 */
  claimable: boolean
  /** 可领取的额度活动（actionType=CLAIM_BENEFIT 且 claimStatus=CLAIMABLE）。 */
  claimableCampaigns: QoderCampaign[]
  campaigns: QoderCampaign[]
}

/** 活跃/连续签到天数。 */
export interface QoderSeatActivity {
  cumulativeActiveDays?: number
  currentConsecutiveDays?: number
  lastActiveDate?: string
  maxConsecutiveDays?: number
}

/** 上游调用失败。 */
export class QoderUpstreamError extends Error {
  readonly status?: number
  readonly code?: string
  /** 是否属于「认证失效」，上层据此提示重新登录。 */
  readonly unauthorized: boolean

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'QoderUpstreamError'
    if (status !== undefined) this.status = status
    if (code !== undefined) this.code = code
    this.unauthorized = status === 401 || status === 403
  }
}

/** 官方客户端使用的请求头。 */
function headersOf(credential: QoderCredential): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.token}`,
    'Cosy-ClientType': String(CLIENT_TYPE),
    'Cosy-Version': CLIENT_VERSION,
    'User-Agent': 'Qoder',
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 解析单个本地化文案块。 */
function parseLocalizedText(value: unknown): QoderLocalizedText | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const o = value as Record<string, unknown>
  const out: QoderLocalizedText = {}
  const title = str(o['title'])
  if (title !== undefined) out.title = title
  const description = str(o['description'])
  if (description !== undefined) out.description = description
  const buttonText = str(o['buttonText'])
  if (buttonText !== undefined) out.buttonText = buttonText
  const detailUrl = str(o['detailUrl'])
  if (detailUrl !== undefined) out.detailUrl = detailUrl
  return Object.keys(out).length > 0 ? out : undefined
}

/** 解析 placements 数组，保留文案供面板展示。 */
function parsePlacements(value: unknown): QoderPlacement[] {
  if (!Array.isArray(value)) return []
  const out: QoderPlacement[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const placement: QoderPlacement = {}
    const type = str(p['type'])
    if (type !== undefined) placement.type = type
    const campaignUrl = str(p['campaignUrl'])
    if (campaignUrl !== undefined) placement.campaignUrl = campaignUrl
    const content = p['content']
    if (content !== null && typeof content === 'object') {
      const c = content as Record<string, unknown>
      const zh = parseLocalizedText(c['zh'])
      const en = parseLocalizedText(c['en'])
      if (zh !== undefined || en !== undefined) {
        placement.content = {}
        if (zh !== undefined) placement.content.zh = zh
        if (en !== undefined) placement.content.en = en
      }
    }
    out.push(placement)
  }
  return out
}

export interface QoderUpstreamClientOptions {
  endpoints?: QoderEndpoints
  /** 单次请求超时，默认 15 秒。 */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class QoderUpstreamClient {
  private readonly endpoints: QoderEndpoints
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(region: QoderRegion, options: QoderUpstreamClientOptions = {}) {
    this.endpoints = options.endpoints ?? defaultEndpoints(region)
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 底层请求：统一鉴权、超时与错误归类。 */
  private async request(
    credential: QoderCredential,
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(path, this.endpoints.openapi)
    if (query !== undefined) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    }

    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: headersOf(credential),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new QoderUpstreamError(`请求 ${method} ${path} 失败：${detail}`)
    }

    const text = await res.text()
    if (!res.ok) {
      // 上游错误信封形如 { errorCode, errorMessage, requestId }
      try {
        const parsed = JSON.parse(text) as { errorCode?: string; errorMessage?: string }
        throw new QoderUpstreamError(
          parsed.errorMessage ?? `HTTP ${res.status}`,
          res.status,
          parsed.errorCode,
        )
      } catch (error: unknown) {
        if (error instanceof QoderUpstreamError) throw error
        throw new QoderUpstreamError(`HTTP ${res.status}`, res.status)
      }
    }

    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new QoderUpstreamError(`响应不是合法 JSON（${method} ${path}）`, res.status)
    }
  }

  private get(credential: QoderCredential, path: string, query?: Record<string, string>): Promise<unknown> {
    return this.request(credential, 'GET', path, query)
  }

  /** 账号信息：确认 token 有效性，并取回最新昵称/邮箱。 */
  async fetchUserInfo(credential: QoderCredential): Promise<{ id: string; name?: string; email?: string }> {
    const data = (await this.get(credential, '/api/v1/userinfo')) as Record<string, unknown>
    const id = str(data['id'])
    if (id === undefined) throw new QoderUpstreamError('userinfo 缺少 id')
    const out: { id: string; name?: string; email?: string } = { id }
    const name = str(data['name'])
    const email = str(data['email'])
    if (name !== undefined) out.name = name
    if (email !== undefined) out.email = email
    return out
  }

  /** 额度用量。`scope=app` 时带上 product=app，与官方客户端一致。 */
  async fetchUsage(credential: QoderCredential, scope: 'app' | 'web' = 'app'): Promise<QoderUsage> {
    const query = scope === 'app' ? { product: 'app' } : undefined
    const data = (await this.get(credential, '/sash/api/v2/me/usage', query)) as Record<string, unknown>
    const usage = (data['qoderUsage'] ?? data) as Record<string, unknown>
    // 额度可能出现在两个位置之一：
    // - 嵌套：{ qoderUsage: { userQuota: { total, used, ... } } }（当前线上形态）
    // - 扁平：{ qoderUsage: { total, used, ... } } 或 { total, used, ... }
    const quota = (usage['userQuota'] ?? usage) as Record<string, unknown>

    const out: QoderUsage = {}
    const displayMode = str(data['displayMode'])
    if (displayMode !== undefined) out.displayMode = displayMode
    const userType = str(usage['userType'])
    if (userType !== undefined) out.userType = userType
    const usageType = str(usage['usageType'])
    if (usageType !== undefined) out.usageType = usageType
    const pct = num(usage['totalUsagePercentage'])
    if (pct !== undefined) out.totalUsagePercentage = pct
    if (typeof usage['isQuotaExceeded'] === 'boolean') out.isQuotaExceeded = usage['isQuotaExceeded']
    const expiresAt = num(usage['expiresAt'])
    if (expiresAt !== undefined) out.expiresAtMs = expiresAt
    const upgradeUrl = str(usage['upgradeUrl'])
    if (upgradeUrl !== undefined) out.upgradeUrl = upgradeUrl

    const total = num(quota['total'])
    const used = num(quota['used'])
    const remaining = num(quota['remaining'])
    const percentage = num(quota['percentage'])
    const unit = str(quota['unit'])
    if (total !== undefined) out.total = total
    if (used !== undefined) out.used = used
    if (remaining !== undefined) out.remaining = remaining
    if (percentage !== undefined) out.percentage = percentage
    if (unit !== undefined) out.unit = unit
    return out
  }

  /** 套餐。 */
  async fetchPlan(credential: QoderCredential): Promise<QoderPlan> {
    const data = (await this.get(credential, '/api/v2/user/plan')) as Record<string, unknown>
    const out: QoderPlan = {}
    const userType = str(data['user_type'])
    if (userType !== undefined) out.userType = userType
    const tier = str(data['plan_tier_name'])
    if (tier !== undefined) out.planTierName = tier
    if (typeof data['is_personal_version'] === 'boolean') out.isPersonalVersion = data['is_personal_version']
    if (typeof data['is_paid_plan'] === 'boolean') out.isPaidPlan = data['is_paid_plan']
    if (typeof data['is_highest_tier'] === 'boolean') out.isHighestTier = data['is_highest_tier']
    const start = num(data['start_date'])
    if (start !== undefined) out.startDateMs = start
    const end = num(data['end_date'])
    if (end !== undefined) out.endDateMs = end
    return out
  }

  /** 签到/活动状态。 */
  async fetchCampaigns(credential: QoderCredential): Promise<QoderCampaignStatus> {
    const data = (await this.get(credential, '/sash/api/v1/me/campaigns')) as Record<string, unknown>
    const rawList = Array.isArray(data['campaigns']) ? data['campaigns'] : []
    const campaigns: QoderCampaign[] = rawList.map((item): QoderCampaign => {
      const c = (item ?? {}) as Record<string, unknown>
      const out: QoderCampaign = {}
      const campaignId = str(c['campaignId'])
      if (campaignId !== undefined) out.campaignId = campaignId
      const campaignKey = str(c['campaignKey'])
      if (campaignKey !== undefined) out.campaignKey = campaignKey
      const actionType = str(c['actionType'])
      if (actionType !== undefined) out.actionType = actionType
      const claimStatus = str(c['claimStatus'])
      if (claimStatus !== undefined) out.claimStatus = claimStatus
      const startAt = num(c['startAt'])
      if (startAt !== undefined) out.startAtSec = startAt
      const endAt = num(c['endAt'])
      if (endAt !== undefined) out.endAtSec = endAt
      const benefit = (c['benefit'] ?? {}) as Record<string, unknown>
      const kind = str(benefit['kind'])
      if (kind !== undefined) out.benefitKind = kind
      const amount = num(benefit['amount'])
      if (amount !== undefined) out.benefitAmount = amount
      const validity = (benefit['validity'] ?? {}) as Record<string, unknown>
      const days = num(validity['days'])
      if (days !== undefined) out.benefitValidityDays = days
      const placements = parsePlacements(c['placements'])
      if (placements.length > 0) out.placements = placements
      return out
    })

    const claimableCampaigns = campaigns.filter(
      c => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE',
    )

    const out: QoderCampaignStatus = {
      showCampaign: data['showCampaign'] === true,
      claimable: data['claimable'] === true || claimableCampaigns.length > 0,
      claimableCampaigns,
      campaigns,
    }
    const uid = str(data['uid'])
    if (uid !== undefined) out.uid = uid
    return out
  }

  /**
   * 领取某个活动的奖励。
   *
   * 服务端幂等：重复领取返回同一个 `grantId` 且 `replayed: true`，可安全重试。
   */
  async claimCampaign(credential: QoderCredential, campaignId: string): Promise<QoderClaimOutcome> {
    const path = `/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`
    const data = (await this.request(credential, 'POST', path)) as Record<string, unknown>

    const out: QoderClaimOutcome = { replayed: data['replayed'] === true }
    const grantId = str(data['grantId'])
    if (grantId !== undefined) out.grantId = grantId
    const status = str(data['status'])
    if (status !== undefined) out.status = status
    const claimedAt = str(data['claimedAt'])
    if (claimedAt !== undefined) out.claimedAt = claimedAt

    const benefit = (data['benefit'] ?? {}) as Record<string, unknown>
    const kind = str(benefit['kind'])
    if (kind !== undefined) out.kind = kind
    const amount = num(benefit['amount'])
    if (amount !== undefined) out.amount = amount
    const validity = (benefit['validity'] ?? {}) as Record<string, unknown>
    const days = num(validity['days'])
    if (days !== undefined) out.validityDays = days

    return out
  }

  /** 活跃 / 连续签到天数。 */
  async fetchSeatActivity(credential: QoderCredential, scope: 'app' | 'web' = 'app'): Promise<QoderSeatActivity> {
    const query = scope === 'app' ? { product: 'app' } : undefined
    const data = (await this.get(credential, '/sash/api/v1/ai-conversations/seat-activity', query)) as Record<string, unknown>
    const out: QoderSeatActivity = {}
    const cumulative = num(data['cumulativeActiveDays'])
    if (cumulative !== undefined) out.cumulativeActiveDays = cumulative
    const current = num(data['currentConsecutiveDays'])
    if (current !== undefined) out.currentConsecutiveDays = current
    const last = str(data['lastActiveDate'])
    if (last !== undefined) out.lastActiveDate = last
    const max = num(data['maxConsecutiveDays'])
    if (max !== undefined) out.maxConsecutiveDays = max
    return out
  }

  /** 累计积分统计（个人资料页用）。 */
  async fetchCreditsSummary(credential: QoderCredential, scope: 'app' | 'web' = 'app'): Promise<{ totalCredits?: number; peakCredits?: number }> {
    const query = scope === 'app' ? { product: 'app' } : undefined
    const data = (await this.get(credential, '/sash/api/v1/ai-conversations/credits-summary', query)) as Record<string, unknown>
    const out: { totalCredits?: number; peakCredits?: number } = {}
    const total = num(data['totalCredits'])
    if (total !== undefined) out.totalCredits = total
    const peak = num(data['peakCredits'])
    if (peak !== undefined) out.peakCredits = peak
    return out
  }
}
