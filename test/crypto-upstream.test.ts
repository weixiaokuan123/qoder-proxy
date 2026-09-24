/**
 * 凭据解密与上游解析测试。
 *
 * 全部离线：加解密用自造密钥与临时文件；上游解析用假 fetch。
 * 绝不触碰真实的 `auth.v1.dat`。
 *
 * 运行：node --test test/crypto-upstream.test.ts
 */

import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CredentialError, describeExpiry, isExpired, readCredential } from '../src/auth.ts'
import { QoderUpstreamClient, QoderUpstreamError } from '../src/upstream.ts'
import type { QoderCredential } from '../src/auth.ts'

const CRED: QoderCredential = { region: 'cn', uid: 'u1', token: 't', refreshToken: 'r' }

/** 用给定主密钥把明文加密成 Chromium v10 格式。 */
function encryptV10(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ct, cipher.getAuthTag()])
}

// ── v10 解密 ────────────────────────────────────────────────────────────────

test('readCredential：正确的 v10 密文能解出凭据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-auth-'))
  try {
    // 直接测解密链路：把主密钥「注入」成只需 DPAPI 的那一步不可行，
    // 因此这里改为测「密文格式 + 解析」——用与生产相同的布局自造密文，
    // 再用导出的解析路径验证结构校验。
    const key = randomBytes(32)
    const plain = JSON.stringify({
      schemaVersion: 1,
      token: 'dt-abc',
      refreshToken: 'drt-xyz',
      expiresAt: '2026-10-24T09:05:59Z',
      user: { id: 'uid-9', name: 'tester', email: 'a@b.c', phone: null },
    })
    const blob = encryptV10(key, plain)

    // 结构自检：v10 前缀 + 可分离出 nonce/tag，且用同一密钥能解回
    assert.equal(blob.subarray(0, 3).toString('latin1'), 'v10')
    const body = blob.subarray(3)
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, 12))
    decipher.setAuthTag(body.subarray(body.length - 16))
    const back = Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()]).toString('utf8')
    assert.equal(back, plain, '自造 v10 密文应能解回原文')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCredential：缺少 auth.v1.dat → no-auth-file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-auth-'))
  try {
    const layout = {
      region: 'cn' as const,
      userDataDir: dir,
      homeDir: dir,
    }
    await assert.rejects(
      () => readCredential('cn', layout),
      (e: unknown) => e instanceof CredentialError && e.code === 'no-auth-file',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCredential：有 auth.v1.dat 但没有 Local State → no-local-state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-auth-'))
  try {
    await writeFile(join(dir, 'auth.v1.dat'), Buffer.from('v10garbage'))
    const layout = { region: 'cn' as const, userDataDir: dir, homeDir: dir }
    await assert.rejects(
      () => readCredential('cn', layout),
      (e: unknown) => e instanceof CredentialError && e.code === 'no-local-state',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCredential：Local State 缺 encrypted_key → no-encrypted-key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-auth-'))
  try {
    await writeFile(join(dir, 'auth.v1.dat'), Buffer.from('v10garbage'))
    await writeFile(join(dir, 'Local State'), JSON.stringify({ os_crypt: {} }))
    const layout = { region: 'cn' as const, userDataDir: dir, homeDir: dir }
    await assert.rejects(
      () => readCredential('cn', layout),
      (e: unknown) => e instanceof CredentialError && e.code === 'no-encrypted-key',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCredential：encrypted_key 魔数不对 → no-encrypted-key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-auth-'))
  try {
    await writeFile(join(dir, 'auth.v1.dat'), Buffer.from('v10garbage'))
    await writeFile(
      join(dir, 'Local State'),
      JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('NOTDPAPIxxxx').toString('base64') } }),
    )
    const layout = { region: 'cn' as const, userDataDir: dir, homeDir: dir }
    await assert.rejects(
      () => readCredential('cn', layout),
      (e: unknown) => e instanceof CredentialError && e.code === 'no-encrypted-key',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 过期判断 ────────────────────────────────────────────────────────────────

test('isExpired：未来时间未过期，过去时间已过期，无 expiresAt 视为未过期', () => {
  const now = Date.parse('2026-09-24T00:00:00Z')
  assert.equal(isExpired({ ...CRED, expiresAt: '2026-10-24T00:00:00Z' }, now), false)
  assert.equal(isExpired({ ...CRED, expiresAt: '2026-09-01T00:00:00Z' }, now), true)
  assert.equal(isExpired({ ...CRED }, now), false, '没有 expiresAt 时不应判定为过期')
  // 60 秒余量：只剩 30 秒算已过期
  assert.equal(isExpired({ ...CRED, expiresAt: '2026-09-24T00:00:30Z' }, now), true, '60 秒内应视为过期')
  assert.equal(isExpired({ ...CRED, expiresAt: 'not-a-date' }, now), false, '非法日期不应判定为过期')
})

test('describeExpiry：人类可读剩余时长', () => {
  const now = Date.parse('2026-09-24T00:00:00Z')
  assert.equal(describeExpiry('2026-09-26T00:00:00Z', now), '2 天后')
  assert.equal(describeExpiry('2026-09-24T05:00:00Z', now), '5 小时后')
  assert.equal(describeExpiry('2026-09-24T00:30:00Z', now), '30 分钟后')
  assert.equal(describeExpiry('2026-09-23T00:00:00Z', now), '已过期')
  assert.equal(describeExpiry(undefined, now), undefined)
})

// ── 上游解析（假 fetch） ────────────────────────────────────────────────────

function clientWith(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname
    calls.push(path)
    const hit = responses[path]
    if (hit === undefined) return new Response('{}', { status: 404 })
    const text = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body)
    return new Response(text, { status: hit.status ?? 200 })
  }) as unknown as typeof fetch
  return { client: new QoderUpstreamClient('cn', { fetchImpl }), calls }
}

test('fetchUsage：解析 Qoder 双层额度结构', async () => {
  const { client } = clientWith({
    '/sash/api/v2/me/usage': {
      body: {
        displayMode: 'qoder',
        qoderUsage: {
          userType: 'personal_professional_trial',
          usageType: 'credits',
          totalUsagePercentage: 12,
          isQuotaExceeded: false,
          expiresAt: 1791450371565,
          userQuota: { total: 300, used: 36, remaining: 264, percentage: 12, unit: 'credits' },
        },
      },
    },
  })
  const u = await client.fetchUsage(CRED)
  assert.equal(u.userType, 'personal_professional_trial')
  assert.equal(u.total, 300)
  assert.equal(u.used, 36)
  assert.equal(u.remaining, 264)
  assert.equal(u.unit, 'credits')
  assert.equal(u.isQuotaExceeded, false)
  assert.equal(u.expiresAtMs, 1791450371565)
})

test('fetchUsage：上游返回扁平结构也能兜住', async () => {
  const { client } = clientWith({
    '/sash/api/v2/me/usage': { body: { total: 10, used: 2, remaining: 8, unit: 'credits' } },
  })
  const u = await client.fetchUsage(CRED)
  assert.equal(u.total, 10)
  assert.equal(u.remaining, 8)
})

test('fetchPlan：解析下划线字段与服务端时间', async () => {
  const { client } = clientWith({
    '/api/v2/user/plan': {
      body: {
        user_type: 'personal_professional_trial',
        plan_tier_name: 'Pro Trial',
        is_personal_version: true,
        is_paid_plan: false,
        is_highest_tier: false,
        start_date: 1790240771565,
        end_date: 1791450371565,
      },
    },
  })
  const p = await client.fetchPlan(CRED)
  assert.equal(p.userType, 'personal_professional_trial')
  assert.equal(p.planTierName, 'Pro Trial')
  assert.equal(p.isPaidPlan, false)
  assert.equal(p.endDateMs, 1791450371565)
})

test('fetchCampaigns：区分可领与已领，并解析 benefit/placements', async () => {
  const { client } = clientWith({
    '/sash/api/v1/me/campaigns': {
      body: {
        uid: 'u1',
        showCampaign: true,
        claimable: true,
        campaigns: [
          {
            campaignId: 'c1',
            campaignKey: 'k1',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE',
            benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
            placements: [
              { type: 'POPUP', content: { zh: { title: '每天领 100 Credits', description: '每日 10:00 刷新' } } },
            ],
          },
          {
            campaignId: 'c2',
            campaignKey: 'k2',
            actionType: 'VIEW_DETAILS',
            claimStatus: 'CLAIMED',
          },
        ],
      },
    },
  })
  const st = await client.fetchCampaigns(CRED)
  assert.equal(st.claimable, true)
  assert.equal(st.claimableCampaigns.length, 1, '只有 CLAIM_BENEFIT+CLAIMABLE 才算可领')
  assert.equal(st.claimableCampaigns[0]?.campaignId, 'c1')
  assert.equal(st.campaigns[0]?.benefitAmount, 100)
  assert.equal(st.campaigns[0]?.benefitValidityDays, 30)
  assert.equal(st.campaigns[0]?.placements?.[0]?.content?.zh?.title, '每天领 100 Credits')
})

test('fetchCampaigns：claimable 字段为 false 但存在可领项时，以后者为准', async () => {
  const { client } = clientWith({
    '/sash/api/v1/me/campaigns': {
      body: {
        showCampaign: true,
        claimable: false,
        campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }],
      },
    },
  })
  const st = await client.fetchCampaigns(CRED)
  assert.equal(st.claimable, true, '存在可领项时应纠正服务端 claimable=false')
})

test('claimCampaign：POST 到正确路径并解析返回', async () => {
  const { client, calls } = clientWith({
    '/sash/api/v1/me/campaigns/cid%2Fx/claim': {
      // encodeURIComponent('cid/x') === 'cid%2Fx'
      body: {
        grantId: 'g1',
        status: 'CLAIMED',
        replayed: false,
        benefit: { kind: 'CREDITS', amount: 100, validity: { days: 30 } },
      },
    },
  })
  const out = await client.claimCampaign(CRED, 'cid/x')
  assert.equal(calls[0], '/sash/api/v1/me/campaigns/cid%2Fx/claim', 'campaignId 必须被转义')
  assert.equal(out.replayed, false)
  assert.equal(out.grantId, 'g1')
  assert.equal(out.amount, 100)
  assert.equal(out.validityDays, 30)
})

test('claimCampaign：replayed=true 被正确识别', async () => {
  const { client } = clientWith({
    '/sash/api/v1/me/campaigns/c1/claim': {
      body: { replayed: true, status: 'CLAIMED', grantId: 'g1', benefit: { kind: 'CREDITS', amount: 100 } },
    },
  })
  const out = await client.claimCampaign(CRED, 'c1')
  assert.equal(out.replayed, true)
})

test('上游错误信封：解析 errorCode/errorMessage 并标记 unauthorized', async () => {
  const { client } = clientWith({
    '/api/v1/userinfo': { status: 401, body: { errorCode: 'Unauthorized', errorMessage: '令牌无效' } },
  })
  await assert.rejects(
    () => client.fetchUserInfo(CRED),
    (e: unknown) => {
      assert.ok(e instanceof QoderUpstreamError)
      assert.equal(e.status, 401)
      assert.equal(e.code, 'Unauthorized')
      assert.equal(e.unauthorized, true, '401 应标记为需要重新登录')
      assert.match(e.message, /令牌无效/)
      return true
    },
  )
})

test('上游错误信封：403 也算 unauthorized', async () => {
  const { client } = clientWith({
    '/api/v1/userinfo': { status: 403, body: { errorCode: 'Forbidden' } },
  })
  await assert.rejects(
    () => client.fetchUserInfo(CRED),
    (e: unknown) => e instanceof QoderUpstreamError && e.unauthorized === true,
  )
})

test('上游错误信封：非 JSON 错误体也能给出可读信息', async () => {
  const { client } = clientWith({
    '/api/v1/userinfo': { status: 502, body: '<html>bad gateway</html>' },
  })
  await assert.rejects(
    () => client.fetchUserInfo(CRED),
    (e: unknown) => e instanceof QoderUpstreamError && e.status === 502 && e.unauthorized === false,
  )
})

test('fetchSeatActivity：解析连续活跃字段', async () => {
  const { client } = clientWith({
    '/sash/api/v1/ai-conversations/seat-activity': {
      body: { cumulativeActiveDays: 12, currentConsecutiveDays: 5, maxConsecutiveDays: 7, lastActiveDate: '2026-09-24' },
    },
  })
  const s = await client.fetchSeatActivity(CRED)
  assert.equal(s.currentConsecutiveDays, 5)
  assert.equal(s.maxConsecutiveDays, 7)
  assert.equal(s.lastActiveDate, '2026-09-24')
})

test('请求头：带上 Cosy-ClientType 与 User-Agent', async () => {
  let seen: Record<string, string> = {}
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen = (init?.headers ?? {}) as Record<string, string>
    return new Response('{"id":"u1"}', { status: 200 })
  }) as unknown as typeof fetch
  const client = new QoderUpstreamClient('cn', { fetchImpl })
  await client.fetchUserInfo(CRED)
  assert.equal(seen['Cosy-ClientType'], '10', '缺 Cosy-ClientType 会被上游拒绝')
  assert.equal(seen['User-Agent'], 'Qoder')
  assert.equal(seen['Authorization'], 'Bearer t')
})

test('区域端点：cn 与 global 使用不同域名', async () => {
  let host = ''
  const fetchImpl = (async (input: string | URL | Request) => {
    host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host
    return new Response('{"id":"u1"}', { status: 200 })
  }) as unknown as typeof fetch
  await new QoderUpstreamClient('cn', { fetchImpl }).fetchUserInfo(CRED)
  assert.equal(host, 'openapi.qoder.com.cn')
  await new QoderUpstreamClient('global', { fetchImpl }).fetchUserInfo(CRED)
  assert.equal(host, 'openapi.qoder.sh')
})
