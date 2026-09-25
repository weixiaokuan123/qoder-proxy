/**
 * qodercli 驱动层测试。
 *
 * 不真的启动 qodercli（那需要已登录 + 已安装），只测可确定的纯逻辑：
 * - 可执行入口解析（默认 + 环境变量覆盖）
 * - 可用性探测在入口不存在时返回 false
 * - 并发闸门的行为
 * - runCli 在入口缺失时给出明确错误而非抛异常
 *
 * 运行：node --test test/cli.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cliConcurrency, isCliAvailable, isStatusLoggedIn, resolveCliEntry, runCli } from '../src/cli.ts'

test('resolveCliEntry 默认指向内嵌 vendor 运行时', () => {
  const entry = resolveCliEntry()
  assert.match(entry, /vendor[\\/]node_modules[\\/]@qoder-ai[\\/]qodercli[\\/]bundle[\\/]qodercli\.js$/)
})

test('resolveCliEntry 支持 QODER_CLI_ENTRY 覆盖（自管运行时）', () => {
  const prev = process.env['QODER_CLI_ENTRY']
  try {
    process.env['QODER_CLI_ENTRY'] = 'C:\\custom\\qodercli.js'
    assert.equal(resolveCliEntry(), 'C:\\custom\\qodercli.js')
  } finally {
    if (prev === undefined) delete process.env['QODER_CLI_ENTRY']
    else process.env['QODER_CLI_ENTRY'] = prev
  }
})

test('isCliAvailable 在入口不存在时为 false', () => {
  const prev = process.env['QODER_CLI_ENTRY']
  try {
    process.env['QODER_CLI_ENTRY'] = 'C:\\definitely\\missing\\qodercli.js'
    assert.equal(isCliAvailable(), false)
  } finally {
    if (prev === undefined) delete process.env['QODER_CLI_ENTRY']
    else process.env['QODER_CLI_ENTRY'] = prev
  }
})

test('cliConcurrency 上报 limit 且初始无占用', () => {
  const stats = cliConcurrency()
  assert.equal(typeof stats.limit, 'number')
  assert.ok(stats.limit >= 1, '并发上限至少为 1')
  assert.equal(typeof stats.active, 'number')
  assert.equal(typeof stats.queued, 'number')
})

test('runCli 在入口缺失时返回结构化错误而非抛异常', async () => {
  const prev = process.env['QODER_CLI_ENTRY']
  try {
    process.env['QODER_CLI_ENTRY'] = 'C:\\definitely\\missing\\qodercli.js'
    const result = await runCli({ prompt: 'hello', timeoutMs: 5000 })
    assert.equal(result.ok, false)
    assert.equal(result.text, '')
    assert.match(String(result.error), /qodercli 未安装/)
    assert.equal(result.timedOut, false)
    // 闸门必须已释放，否则后续请求会永久排队
    assert.equal(cliConcurrency().active, 0)
  } finally {
    if (prev === undefined) delete process.env['QODER_CLI_ENTRY']
    else process.env['QODER_CLI_ENTRY'] = prev
  }
})

test('runCli 失败后并发闸门不泄漏', async () => {
  const prev = process.env['QODER_CLI_ENTRY']
  try {
    process.env['QODER_CLI_ENTRY'] = 'C:\\definitely\\missing\\qodercli.js'
    await Promise.all([
      runCli({ prompt: 'a', timeoutMs: 5000 }),
      runCli({ prompt: 'b', timeoutMs: 5000 }),
      runCli({ prompt: 'c', timeoutMs: 5000 }),
    ])
    assert.equal(cliConcurrency().active, 0, '全部失败后不应有占用残留')
    assert.equal(cliConcurrency().queued, 0, '全部失败后不应有排队残留')
  } finally {
    if (prev === undefined) delete process.env['QODER_CLI_ENTRY']
    else process.env['QODER_CLI_ENTRY'] = prev
  }
})

// --- isStatusLoggedIn：登录态判定 ---

// 未登录的真实输出
const NOT_LOGGED_IN = 'Version: 1.1.63\nAccount: Not logged in';

// 已登录的真实输出（实测，注意没有 Account 行）
const LOGGED_IN = [
  'Version: 1.1.63',
  'Username: efficient dignified',
  'Email: endlessworld17@gmail.com',
  'Avatar: https://qoder.com/users/01a0d2aa/default/avatars',
  'Login Method: browser',
  'Auth Source: local',
].join('\n');

test('isStatusLoggedIn：真实未登录输出判为 false', () => {
  assert.equal(isStatusLoggedIn(NOT_LOGGED_IN), false);
})

test('isStatusLoggedIn：真实已登录输出判为 true（无 Account 行）', () => {
  assert.equal(isStatusLoggedIn(LOGGED_IN), true);
})

test('isStatusLoggedIn：仅有 Email 也算已登录', () => {
  assert.equal(isStatusLoggedIn('Version: 1.1.63\nEmail: a@b.com'), true);
})

test('isStatusLoggedIn：仅有 Username 也算已登录', () => {
  assert.equal(isStatusLoggedIn('Version: 1.1.63\nUsername: someone'), true);
})

test('isStatusLoggedIn：空值行不误判为已登录', () => {
  assert.equal(isStatusLoggedIn('Version: 1.1.63\nUsername:\nEmail:'), false);
  assert.equal(isStatusLoggedIn('Version: 1.1.63\nUsername:   \nEmail:  '), false);
})

test('isStatusLoggedIn：未登录行后有其它输出仍判为 false', () => {
  assert.equal(isStatusLoggedIn('Version: 1.1.63\nAccount: Not logged in\nExtra'), false);
})

test('isStatusLoggedIn：缺少账号行判为 false', () => {
  assert.equal(isStatusLoggedIn('Version: 1.1.63'), false);
  assert.equal(isStatusLoggedIn(''), false);
})

test('isStatusLoggedIn：空值与仅空白判为 false', () => {
  assert.equal(isStatusLoggedIn('Account:'), false);
  assert.equal(isStatusLoggedIn('Account:   '), false);
  assert.equal(isStatusLoggedIn('Account: Not logged in '), false);
})

test('isStatusLoggedIn：大小写不敏感', () => {
  assert.equal(isStatusLoggedIn('account: NOT LOGGED IN'), false);
  assert.equal(isStatusLoggedIn('username: someone'), true);
  assert.equal(isStatusLoggedIn('EMAIL: someone@x.com'), true);
})
