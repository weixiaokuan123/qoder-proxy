/**
 * Qoder 每日签到适配层。
 *
 * Qoder 的签到机制与 WorkBuddy 不同：官方客户端不暴露一个「打卡」端点，而是把
 * 每日 100 Credits 建模成一个**活动（campaign）**，通过两个端点驱动：
 *
 *   GET  {openapi}/sash/api/v1/me/campaigns                    列出活动与领取状态
 *   POST {openapi}/sash/api/v1/me/campaigns/{campaignId}/claim  领取（幂等）
 *
 * 服务端保证幂等：重复领取返回同一个 `grantId` 且 `replayed: true`，因此本层可以
 * 安全地「先查再领」而不必担心重复发放。
 *
 * 官方说明：每日 10:00（UTC+8）刷新，领取后 30 天有效。
 *
 * @module qoder-proxy/signin
 */

import type { QoderCredential } from './auth.ts'
import type { QoderCampaign, QoderUpstreamClient } from './upstream.ts'

/** 领取结果。 */
export interface ClaimResult {
  /** 本次调用是否真的新领取到了（对应 replayed: false）。 */
  claimed: boolean
  /** 服务端确认今天已经领过（对应 replayed: true，或查询时已是 CLAIMED）。 */
  already: boolean
  message: string
  /** 服务端返回的发放记录 ID。 */
  grantId?: string
  /** 领取的积分数。 */
  amount?: number
  /** 积分类别（通常 CREDITS）。 */
  kind?: string
  /** 有效期天数。 */
  validityDays?: number
}

/** 签到状态视图，供 /status 展示。 */
export interface QoderSigninView {
  /** 当前是否还有可领取项。 */
  claimable: boolean
  /** 今天是否已领取（存在 CLAIM_BENEFIT 活动且已 CLAIMED）。 */
  todayCheckedIn: boolean
  /**
   * 该区域当前是否存在「领积分」类签到活动。
   *
   * 用于区分两种「不可领」：
   * - `hasBenefitCampaign=false`：区域没有这类活动（如国际版当前只有订阅推广活动），
   *   此时签到无意义，不是异常。
   * - `hasBenefitCampaign=true && claimable=false`：活动存在但今天已领。
   */
  hasBenefitCampaign: boolean
  /** 可领取的活动列表。 */
  claimableCampaigns: QoderCampaign[]
  /** 全部活动（含已领与纯展示型）。 */
  campaigns: QoderCampaign[]
  /** 今日可领积分合计。 */
  claimableAmount: number
  /** 每日奖励额度（取可领项的最大值，通常 100）。 */
  dailyCredit: number
  /** 领取后有效天数。 */
  validityDays?: number
  /** 活动文案（来自 placements，给面板展示）。 */
  title?: string
  description?: string
  /** 连续活跃天数（来自 seat-activity，best-effort）。 */
  streakDays?: number
}

/** 只要求 resolve()，方便测试注入。 */
export interface SigninCredentialStore {
  resolve(): Promise<QoderCredential>
}

export class QoderSigninService {
  private readonly store: SigninCredentialStore
  private readonly client: QoderUpstreamClient
  /** 缓存「今日是否已领」，避免面板频繁轮询时打爆上游。 */
  private lastClaimedAtMs = 0

  constructor(store: SigninCredentialStore, client: QoderUpstreamClient) {
    this.store = store
    this.client = client
  }

  /** 读取签到状态。 */
  async getStatus(nowMs = Date.now()): Promise<QoderSigninView> {
    const credential = await this.store.resolve()
    const status = await this.client.fetchCampaigns(credential)

    // 只看真正的领积分活动；VIEW_DETAILS 是纯展示，不参与签到判定。
    const benefitCampaigns = status.campaigns.filter(c => c.actionType === 'CLAIM_BENEFIT')
    const claimableCampaigns = status.claimableCampaigns

    // 「今天已领」= 存在领积分活动，且没有任何一项仍可领取。
    const todayCheckedIn = benefitCampaigns.length > 0 && claimableCampaigns.length === 0

    const claimableAmount = claimableCampaigns.reduce((sum, c) => sum + (c.benefitAmount ?? 0), 0)
    // 每日奖励取「已领或可领」项的最大额度；都没有时回退到官方标准值 100。
    const dailyCredit = benefitCampaigns.reduce((max, c) => Math.max(max, c.benefitAmount ?? 0), 0) || 100
    const validityDays = benefitCampaigns.find(c => c.benefitValidityDays !== undefined)?.benefitValidityDays

    const view: QoderSigninView = {
      claimable: claimableCampaigns.length > 0,
      todayCheckedIn,
      hasBenefitCampaign: benefitCampaigns.length > 0,
      claimableCampaigns,
      campaigns: status.campaigns,
      claimableAmount,
      dailyCredit,
    }
    if (validityDays !== undefined) view.validityDays = validityDays

    // 活动文案：优先取当前可领项，否则取任意一项，便于面板显示活动名。
    const forText = claimableCampaigns[0] ?? benefitCampaigns[0]
    if (forText !== undefined) {
      const text = readPlacementText(forText)
      if (text.title !== undefined) view.title = text.title
      if (text.description !== undefined) view.description = text.description
    }

    // 连续活跃天数：失败不影响签到状态展示。
    try {
      const seat = await this.client.fetchSeatActivity(credential)
      if (seat.currentConsecutiveDays !== undefined) view.streakDays = seat.currentConsecutiveDays
    } catch {
      // ignore：seat-activity 是可选信息
    }

    if (view.todayCheckedIn) this.lastClaimedAtMs = nowMs
    return view
  }

  /**
   * 执行签到。
   *
   * 语义与另外三个代理保持一致：
   * - 已领过 → `{ claimed:false, already:true }`（调度器据此标记当天完成）
   * - 本次领到 → `{ claimed:true, already:false }`
   * - 该区域压根没有签到活动 → 也返回 `already:true`，视为「无需签到」，
   *   避免国际版这种没有每日活动的区域每天空跑重试
   * - 活动存在但当前不可领（未到刷新时间） → 抛错，调度器稍后重试
   */
  async claim(): Promise<ClaimResult> {
    const credential = await this.store.resolve()
    const status = await this.client.fetchCampaigns(credential)
    const claimable = status.claimableCampaigns

    if (claimable.length === 0) {
      const benefitCampaigns = status.campaigns.filter(c => c.actionType === 'CLAIM_BENEFIT')
      const anyClaimed = benefitCampaigns.some(c => c.claimStatus === 'CLAIMED')
      if (benefitCampaigns.length === 0) {
        // 该区域没有每日签到活动（例如国际版只有订阅推广活动）。
        // 不是故障，标记为已完成，避免每次 tick 都重试。
        return { claimed: false, already: true, message: '该区域当前没有每日签到活动' }
      }
      if (anyClaimed) {
        return { claimed: false, already: true, message: '今日已领取（服务端确认）' }
      }
      throw new Error('当前没有可领取的签到活动（可能尚未到刷新时间，或活动已结束）')
    }

    // 逐个领取；通常只有一个。
    let claimedAny = false
    let alreadyAny = false
    let lastGrantId: string | undefined
    let amount = 0
    let kind: string | undefined
    let validityDays: number | undefined

    for (const campaign of claimable) {
      if (campaign.campaignId === undefined) continue
      const result = await this.client.claimCampaign(credential, campaign.campaignId)
      lastGrantId = result.grantId ?? lastGrantId
      amount += result.amount ?? campaign.benefitAmount ?? 0
      kind = result.kind ?? kind
      validityDays = result.validityDays ?? validityDays
      if (result.replayed) alreadyAny = true
      else claimedAny = true
    }

    const out: ClaimResult = {
      claimed: claimedAny,
      already: !claimedAny && alreadyAny,
      message: claimedAny
        ? `领取成功，+${amount} ${kind ?? 'CREDITS'}（${validityDays ?? 30} 天有效）`
        : '今日已领取（服务端确认）',
    }
    if (lastGrantId !== undefined) out.grantId = lastGrantId
    if (amount > 0) out.amount = amount
    if (kind !== undefined) out.kind = kind
    if (validityDays !== undefined) out.validityDays = validityDays
    return out
  }

  /** 最近一次确认「今日已领」的时刻，供 /status 判断缓存新鲜度。 */
  lastClaimedAt(): number {
    return this.lastClaimedAtMs
  }
}

/**
 * 从活动的 placements 里取出人类可读标题/描述。
 *
 * 结构：`placements[].content.{zh,en}.{title,description}`，优先中文。
 */
function readPlacementText(campaign: QoderCampaign): { title?: string; description?: string } {
  const placements = campaign.placements ?? []
  const popup = placements.find(p => p.type === 'POPUP') ?? placements[0]
  const content = popup?.content
  if (content === undefined) return {}
  const localized = content.zh ?? content.en
  if (localized === undefined) return {}
  const out: { title?: string; description?: string } = {}
  if (typeof localized.title === 'string' && localized.title !== '') out.title = localized.title
  if (typeof localized.description === 'string' && localized.description !== '') {
    out.description = localized.description
  }
  return out
}
