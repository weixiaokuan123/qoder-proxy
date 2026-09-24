/**
 * qoder-proxy 进程入口。
 *
 * 启动两件事：
 * 1. HTTP 管理服务（/health /status /usage /signin /signin/claim）
 * 2. 每日签到调度器 —— 每个区域每天在本地 10:00–24:00 之间随机一个时刻执行签到
 *    （Qoder 官方说明：奖励每日 10:00（UTC+8）刷新）
 *
 * 调度器复用 self 目录下的通用实现（三个代理共用同一套逻辑）：
 * 计划时刻生成后立即持久化，重启不重摇；跨天自动重排。
 *
 * @module qoder-proxy/main
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeCredential } from './auth.ts'
import { SigninScheduler } from './scheduler.ts'
import { startServer } from './serve.ts'
import { QoderSigninService } from './signin.ts'
import { QoderUpstreamClient } from './upstream.ts'
import { QODER_PROXY_VERSION } from './version.ts'

/** 调度器检查间隔：每 10 分钟看一次是否到点。 */
const TICK_MS = 10 * 60 * 1000

/** 签到窗口：本地 10:00 起（Qoder 每日 10:00 UTC+8 刷新），到当日 24:00 前。 */
const SIGNIN_START_HOUR = Number(process.env['QODER_SIGNIN_START_HOUR'] ?? 10)
const SIGNIN_END_HOUR = Number(process.env['QODER_SIGNIN_END_HOUR'] ?? 24)

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(HERE, '..', 'state', 'signin.json')

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

async function main(): Promise<void> {
  log(`qoder-proxy v${QODER_PROXY_VERSION} 启动中…`)

  await mkdir(dirname(STATE_FILE), { recursive: true })

  const scheduler = new SigninScheduler({
    stateFile: STATE_FILE,
    startHour: SIGNIN_START_HOUR,
    endHour: SIGNIN_END_HOUR,
    log,
  })

  const regions = ['cn', 'global'] as const
  const clients: Record<string, QoderUpstreamClient> = {
    cn: new QoderUpstreamClient('cn'),
    global: new QoderUpstreamClient('global'),
  }

  // 每个区域一个签到目标；同一区域只有一份桌面端登录态。
  const tick = async (): Promise<void> => {
    for (const region of regions) {
      const target = `qoder-${region}`
      const plan = await scheduler.plan(target)
      if (plan.claimed) continue

      const probe = await probeCredential(region)
      if (!probe.ok) {
        // 未登录不算故障：跳过，等用户登录后自然恢复。
        continue
      }

      const svc = new QoderSigninService({ resolve: async () => probe.credential }, clients[region]!)
      const result = await scheduler.runIfDue(target, () => svc.claim())
      if (result.ran && result.entry !== undefined) {
        log(`[签到] ${region}: ${result.entry.result ?? ''}`)
      }
    }
  }

  // 启动后立刻检查一次（可能已过当天计划时刻），随后定时 tick。
  await tick().catch(error => log(`首次签到检查失败：${String(error)}`))
  const timer = setInterval(() => {
    void tick().catch(error => log(`签到检查失败：${String(error)}`))
  }, TICK_MS)
  timer.unref()

  const server = await startServer()
  log(`签到窗口：每日 ${SIGNIN_START_HOUR}:00 起随机时刻`)

  const shutdown = async (signal: string): Promise<void> => {
    log(`收到 ${signal}，正在关闭…`)
    clearInterval(timer)
    await server.close().catch(() => {})
    await scheduler.save().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// 仅在直接运行时启动（被 import 时保持静默，便于测试）。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`启动失败：${String(error)}\n`)
    process.exit(1)
  })
}
