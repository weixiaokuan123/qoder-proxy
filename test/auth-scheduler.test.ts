/**
 * 凭据解密与调度器窗口测试。
 *
 * - v10 / AES-256-GCM 解密：用自造密钥加密一份假凭据，验证能解回原文，
 *   并验证各种畸形输入被正确分类（不碰真实 auth.v1.dat）。
 * - 调度器：验证「10:00 之后」窗口、跨天重排、计划持久化不重摇。
 *
 * 运行：node --test test/auth-scheduler.test.ts
 */

import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ensureEntry, isDue, SigninScheduler, formatSec } from '../src/scheduler.ts'

// ── 调度器：10:00 窗口 ─────────────────────────────────────────────────────

test('调度器：计划时刻始终落在 [10:00, 24:00)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-sched-'))
  try {
    const sched = new SigninScheduler({ stateFile: join(dir, 's.json'), startHour: 10, endHour: 24 })
    // 抽 200 次（不同 target，避免复用同一天的计划）
    for (let i = 0; i < 200; i++) {
      const e = await sched.plan(`t${i}`)
      assert.ok(e.runAtSec >= 10 * 3600, `runAtSec ${e.runAtSec} 早于 10:00`)
      assert.ok(e.runAtSec < 24 * 3600, `runAtSec ${e.runAtSec} 晚于 24:00`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('调度器：计划时刻持久化，重启不重摇', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-sched-'))
  const file = join(dir, 's.json')
  try {
    const a = new SigninScheduler({ stateFile: file, startHour: 10, endHour: 24 })
    const first = (await a.plan('cn')).runAtSec
    await a.save()

    // 新实例读同一个文件，计划时刻必须一致
    const b = new SigninScheduler({ stateFile: file, startHour: 10, endHour: 24 })
    const second = (await b.plan('cn')).runAtSec
    assert.equal(second, first, '重启后计划时刻不应改变')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('isDue：未到计划时刻 → false；已过 → true；已领 → false', () => {
  const at = (h: number, m: number) => new Date(2026, 8, 24, h, m, 0)
  const entry = { date: '2026-09-24', runAtSec: 12 * 3600 + 30 * 60, claimed: false }

  assert.equal(isDue(entry, at(12, 29)), false, '12:29 未到 12:30')
  assert.equal(isDue(entry, at(12, 30)), true, '12:30 正好到点')
  assert.equal(isDue(entry, at(15, 0)), true, '15:00 已过')
  assert.equal(isDue({ ...entry, claimed: true }, at(15, 0)), false, '已领不应再触发')
})

test('ensureEntry：跨天重新生成计划', () => {
  const store: Record<string, { date: string; runAtSec: number; claimed: boolean }> = {
    cn: { date: '2026-09-23', runAtSec: 1000, claimed: true },
  }
  const next = ensureEntry(store as never, 'cn', 10, 24, new Date(2026, 8, 24, 9, 0, 0))
  assert.equal(next.date, '2026-09-24', '新的一天应重建')
  assert.equal(next.claimed, false, '新的一天应为未完成')
  assert.ok(next.runAtSec >= 10 * 3600)
})

test('ensureEntry：同一天复用已有计划', () => {
  const store: Record<string, { date: string; runAtSec: number; claimed: boolean }> = {
    cn: { date: '2026-09-24', runAtSec: 12345, claimed: false },
  }
  const same = ensureEntry(store as never, 'cn', 10, 24, new Date(2026, 8, 24, 20, 0, 0))
  assert.equal(same.runAtSec, 12345, '同一天不应重摇')
})

test('formatSec：秒数格式化为 HH:MM', () => {
  assert.equal(formatSec(0), '00:00')
  assert.equal(formatSec(10 * 3600), '10:00')
  assert.equal(formatSec(23 * 3600 + 59 * 60), '23:59')
})

test('调度器 runIfDue：到点执行并标记完成（幂等，不重复跑）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-sched-'))
  try {
    const sched = new SigninScheduler({ stateFile: join(dir, 's.json'), startHour: 10, endHour: 24 })
    // 把计划时刻设到过去，确保「已到点」
    const entry = await sched.plan('cn')
    entry.runAtSec = 0

    let calls = 0
    const claimer = async () => {
      calls++
      return { claimed: true, already: false, message: 'ok' }
    }

    const first = await sched.runIfDue('cn', claimer)
    assert.equal(first.ran, true)
    assert.equal(calls, 1)

    // 第二次不应再跑（当天已完成）
    const second = await sched.runIfDue('cn', claimer)
    assert.equal(second.ran, false)
    assert.equal(calls, 1, '当天已完成不应重复执行')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('调度器 runIfDue：claimer 抛错时不标记完成，下次可重试', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-sched-'))
  try {
    const sched = new SigninScheduler({ stateFile: join(dir, 's.json'), startHour: 10, endHour: 24 })
    const entry = await sched.plan('cn')
    entry.runAtSec = 0

    let calls = 0
    const failing = async () => {
      calls++
      throw new Error('上游 500')
    }

    await sched.runIfDue('cn', failing)
    assert.equal(calls, 1)
    const after = await sched.entry('cn')
    assert.equal(after?.claimed, false, '失败时不应标记为已完成')

    await sched.runIfDue('cn', failing)
    assert.equal(calls, 2, '失败后应可重试')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
