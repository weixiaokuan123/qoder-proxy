/**
 * Qoder 每日签到逻辑测试。
 *
 * 全部用假的 credential store 与假的上游客户端，不触网、不读真实凭据。
 * 覆盖：
 * - 状态判定（可领 / 已领 / 无活动）
 * - 领取语义（新领 / 幂等重放 / 无活动 / 未到时间抛错）
 * - 多活动逐个领取
 *
 * 运行：node --test test/signin.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { QoderSigninService, type SigninCredentialStore } from '../src/signin.ts'
import type { QoderCampaign, QoderClaimOutcome, QoderCredential } from '../src/upstream.ts'

const CRED: QoderCredential = {
  region: 'cn',
  uid: 'uid-1',
  token: 'tok',
  refreshToken: 'rtok',
}

const STORE: SigninCredentialStore = { resolve: async () => CRED }

/** 造一个活动对象。 */
function campaign(over: Partial<QoderCampaign> = {}): QoderCampaign {
  return {
    campaignId: 'cid-1',
    campaignKey: 'act-1',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefitKind: 'CREDITS',
    benefitAmount: 100,
    benefitValidityDays: 30,
    ...over,
  }
}

/** 最小可用假客户端；只实现 signin 用到的三个方法。 */
function fakeClient(opts: {
  campaigns: QoderCampaign[]
  claims?: Record<string, QoderClaimOutcome>
  seatError?: boolean
}) {
  const calls: string[] = []
  return {
    calls,
    async fetchCampaigns(): Promise<{
      showCampaign: boolean
      claimable: boolean
      claimableCampaigns: QoderCampaign[]
      campaigns: QoderCampaign[]
    }> {
      const claimable = opts.campaigns.filter(c => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE')
      return {
        showCampaign: true,
        claimable: claimable.length > 0,
        claimableCampaigns: claimable,
        campaigns: opts.campaigns,
      }
    },
    async fetchSeatActivity(): Promise<{ currentConsecutiveDays?: number }> {
      if (opts.seatError === true) throw new Error('seat 不可用')
      return { currentConsecutiveDays: 7 }
    },
    async claimCampaign(_cred: QoderCredential, campaignId: string): Promise<QoderClaimOutcome> {
      calls.push(campaignId)
      const canned = opts.claims?.[campaignId]
      if (canned !== undefined) return canned
      const src = opts.campaigns.find(c => c.campaignId === campaignId)
      return {
        replayed: false,
        status: 'CLAIMED',
        amount: src?.benefitAmount ?? 100,
        kind: src?.benefitKind ?? 'CREDITS',
        validityDays: src?.benefitValidityDays ?? 30,
        grantId: 'g-' + campaignId,
      }
    },
    // 其余方法不会被调用，占位以满足类型
    async fetchUserInfo() { return { id: 'x' } },
    async fetchUsage() { return {} },
    async fetchPlan() { return {} },
    async fetchCreditsSummary() { return {} },
  }
}

// ── 状态判定 ────────────────────────────────────────────────────────────────

test('getStatus：有可领项 → claimable=true, todayCheckedIn=false', async () => {
  const svc = new QoderSigninService(STORE, fakeClient({ campaigns: [campaign()] }) as never)
  const view = await svc.getStatus()
  assert.equal(view.claimable, true)
  assert.equal(view.todayCheckedIn, false)
  assert.equal(view.hasBenefitCampaign, true)
  assert.equal(view.claimableAmount, 100)
  assert.equal(view.dailyCredit, 100)
  assert.equal(view.validityDays, 30)
  assert.equal(view.streakDays, 7)
})

test('getStatus：已领取 → claimable=false, todayCheckedIn=true', async () => {
  const svc = new QoderSigninService(
    STORE,
    fakeClient({ campaigns: [campaign({ claimStatus: 'CLAIMED' })] }) as never,
  )
  const view = await svc.getStatus()
  assert.equal(view.claimable, false)
  assert.equal(view.todayCheckedIn, true)
  assert.equal(view.hasBenefitCampaign, true)
  assert.equal(view.dailyCredit, 100, '已领时仍应保留每日额度信息')
})

test('getStatus：只有 VIEW_DETAILS 活动 → 无签到活动，不算已签', async () => {
  const svc = new QoderSigninService(
    STORE,
    fakeClient({ campaigns: [campaign({ actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED', benefitAmount: undefined })] }) as never,
  )
  const view = await svc.getStatus()
  assert.equal(view.hasBenefitCampaign, false)
  assert.equal(view.todayCheckedIn, false, '纯展示活动不能被当作已签到')
  assert.equal(view.claimable, false)
})

test('getStatus：seat-activity 失败不影响主流程', async () => {
  const svc = new QoderSigninService(
    STORE,
    fakeClient({ campaigns: [campaign()], seatError: true }) as never,
  )
  const view = await svc.getStatus()
  assert.equal(view.claimable, true)
  assert.equal(view.streakDays, undefined, '取不到连续天数时应省略该字段')
})

test('getStatus：取活动文案（优先中文）', async () => {
  const svc = new QoderSigninService(
    STORE,
    fakeClient({
      campaigns: [
        campaign({
          placements: [
            {
              type: 'POPUP',
              content: {
                zh: { title: '每天领 100 Credits', description: '每日 10:00 刷新' },
                en: { title: 'Claim 100 Credits Daily' },
              },
            },
          ],
        }),
      ],
    }) as never,
  )
  const view = await svc.getStatus()
  assert.equal(view.title, '每天领 100 Credits')
  assert.equal(view.description, '每日 10:00 刷新')
})

// ── 领取语义 ────────────────────────────────────────────────────────────────

test('claim：成功新领 → claimed=true, already=false', async () => {
  const client = fakeClient({ campaigns: [campaign()] })
  const svc = new QoderSigninService(STORE, client as never)
  const r = await svc.claim()
  assert.equal(r.claimed, true)
  assert.equal(r.already, false)
  assert.equal(r.amount, 100)
  assert.equal(r.grantId, 'g-cid-1')
  assert.deepEqual(client.calls, ['cid-1'])
})

test('claim：服务端重放 → claimed=false, already=true', async () => {
  const client = fakeClient({
    campaigns: [campaign()],
    claims: { 'cid-1': { replayed: true, status: 'CLAIMED', amount: 100, kind: 'CREDITS', grantId: 'g-old' } },
  })
  const svc = new QoderSigninService(STORE, client as never)
  const r = await svc.claim()
  assert.equal(r.claimed, false)
  assert.equal(r.already, true, '幂等重放应被识别为「已领过」')
  assert.match(r.message, /已领取/)
})

test('claim：无任何活动 → already=true（不抛错，避免每天空跑重试）', async () => {
  const client = fakeClient({ campaigns: [] })
  const svc = new QoderSigninService(STORE, client as never)
  const r = await svc.claim()
  assert.equal(r.claimed, false)
  assert.equal(r.already, true)
  assert.match(r.message, /没有每日签到活动/)
  assert.deepEqual(client.calls, [], '无活动时不应发起任何领取请求')
})

test('claim：有活动但不可领（未到刷新时间）→ 抛错以便稍后重试', async () => {
  const client = fakeClient({
    campaigns: [campaign({ claimStatus: 'INELIGIBLE' })],
  })
  const svc = new QoderSigninService(STORE, client as never)
  await assert.rejects(() => svc.claim(), /没有可领取的签到活动/)
  assert.deepEqual(client.calls, [], '不可领时不应发起领取请求')
})

test('claim：多个可领活动 → 逐个领取并累加额度', async () => {
  const client = fakeClient({
    campaigns: [
      campaign({ campaignId: 'a', benefitAmount: 100 }),
      campaign({ campaignId: 'b', benefitAmount: 50, benefitKind: 'CREDITS' }),
    ],
  })
  const svc = new QoderSigninService(STORE, client as never)
  const r = await svc.claim()
  assert.equal(r.claimed, true)
  assert.equal(r.amount, 150, '两个活动的额度应累加')
  assert.deepEqual(client.calls.sort(), ['a', 'b'])
})

test('claim：混合结果（一新领 + 一重放）→ claimed 与 already 双真时以 claimed 为准', async () => {
  const client = fakeClient({
    campaigns: [campaign({ campaignId: 'a' }), campaign({ campaignId: 'b' })],
    claims: { b: { replayed: true, status: 'CLAIMED', amount: 50, kind: 'CREDITS' } },
  })
  const svc = new QoderSigninService(STORE, client as never)
  const r = await svc.claim()
  assert.equal(r.claimed, true, '只要有一项是新领的就算 claimed')
  assert.equal(r.already, false)
})

test('claim：跳过缺少 campaignId 的活动', async () => {
  const client = fakeClient({
    campaigns: [campaign({ campaignId: undefined }), campaign({ campaignId: 'b' })],
  })
  const svc = new QoderSigninService(STORE, client as never)
  const r = await svc.claim()
  assert.equal(r.claimed, true)
  assert.deepEqual(client.calls, ['b'], '缺 id 的项应被跳过')
})
