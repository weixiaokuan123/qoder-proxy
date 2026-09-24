/**
 * Qoder 桌面端登录态读取（只读）。
 *
 * Qoder 桌面端把登录凭据存在 Electron userData 目录下的 `auth.v1.dat`，
 * 写入方式是 Electron `safeStorage.encryptString()`。在 Windows 上该函数
 * 产生的是 Chromium 的 `v10` 密文：
 *
 *     "v10" || nonce(12) || ciphertext || tag(16)
 *
 * 解密用的 32 字节主密钥存放在同目录 `Local State` 的
 * `os_crypt.encrypted_key` 里（base64，解出后以 `DPAPI` 五字节开头），
 * 需要经 Windows DPAPI（当前用户作用域）解保护后才能使用。
 *
 * 因此完整链路是：
 *
 *     DPAPI(encrypted_key) → AES-256-GCM 主密钥 → 解 auth.v1.dat → 凭据 JSON
 *
 * 明文结构（已实测）：
 *
 *     { schemaVersion: 1, token, refreshToken, expiresAt,
 *       refreshTokenExpiresAt?, user: { id, name, email, phone, avatarUrl } }
 *
 * 本模块**只读**，绝不写回 auth.v1.dat —— 账号状态的归属权始终在官方客户端。
 *
 * @module qoder-proxy/auth
 */

import { execFile } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Qoder 区域：国际版走 qoder.com/.sh，国内版走 qoder.com.cn。 */
export type QoderRegion = 'global' | 'cn'

/** 从 auth.v1.dat 读出的凭据。 */
export interface QoderCredential {
  region: QoderRegion
  /** 账号唯一 ID（user.id）。 */
  uid: string
  /** 显示名（user.name）。 */
  name?: string
  /** 邮箱（user.email）。 */
  email?: string
  /** 手机号，国际版通常为 null。 */
  phone?: string | null
  avatarUrl?: string
  /** 访问令牌（Bearer）。 */
  token: string
  /** 刷新令牌。 */
  refreshToken: string
  /** 访问令牌过期时刻（ISO 字符串）。 */
  expiresAt?: string
  /** 刷新令牌过期时刻（ISO 字符串）。 */
  refreshTokenExpiresAt?: string
}

/** 单个区域的目录布局。 */
export interface QoderLayout {
  region: QoderRegion
  /** Electron userData 目录（含 auth.v1.dat 与 Local State）。 */
  userDataDir: string
  /** 端点缓存目录（~/.qoder 或 ~/.qoder-cn）。 */
  homeDir: string
}

/**
 * 默认区域目录。
 *
 * 国际版 userData 用 `com.qoder.app.stable`，国内版用 `com.qodercn.app.stable`；
 * 两者都是「Electron 应用名 + 渠道」的默认拼接结果（已在本机实测确认）。
 * 允许通过环境变量覆盖，便于测试与非常规安装位置。
 */
export function defaultLayout(region: QoderRegion): QoderLayout {
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  const home = homedir()
  if (region === 'cn') {
    return {
      region,
      userDataDir: process.env['QODER_CN_USER_DATA'] ?? join(appData, 'com.qodercn.app.stable'),
      homeDir: process.env['QODER_CN_HOME'] ?? join(home, '.qoder-cn'),
    }
  }
  return {
    region,
    userDataDir: process.env['QODER_USER_DATA'] ?? join(appData, 'com.qoder.app.stable'),
    homeDir: process.env['QODER_HOME'] ?? join(home, '.qoder'),
  }
}

/** 凭据读取失败的分类，供上层给出可读提示。 */
export type CredentialErrorCode =
  | 'no-auth-file'
  | 'no-local-state'
  | 'no-encrypted-key'
  | 'dpapi-failed'
  | 'decrypt-failed'
  | 'bad-schema'

export class CredentialError extends Error {
  readonly code: CredentialErrorCode

  constructor(code: CredentialErrorCode, message: string) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

/** Chromium v10 密文的固定前缀长度（"v10"）。 */
const V10_PREFIX_LEN = 3
/** AES-GCM nonce 长度。 */
const NONCE_LEN = 12
/** AES-GCM 认证标签长度。 */
const TAG_LEN = 16
/** DPAPI 包装前的 `DPAPI` 魔数长度。 */
const DPAPI_MAGIC_LEN = 5

/**
 * 用 Windows DPAPI 解保护一段数据（当前用户作用域）。
 *
 * 走 PowerShell + `ProtectedData.Unprotect`，避免引入原生模块依赖 ——
 * 本项目与另外三个代理一样保持零依赖。DPAPI 只能在当前用户会话解开，
 * 这也意味着凭据天然无法在别的机器/账户上复用。
 */
async function dpapiUnprotect(blob: Buffer): Promise<Buffer> {
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$blob = [Convert]::FromBase64String('${blob.toString('base64')}')`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($plain)',
  ].join('; ')

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    )
    return Buffer.from(stdout.trim(), 'base64')
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CredentialError('dpapi-failed', `DPAPI 解保护失败：${detail}`)
  }
}

/**
 * 读取该区域的主密钥：解 `Local State` 的 `os_crypt.encrypted_key`。
 *
 * 该键是 base64(`DPAPI` + DPAPI blob)，去掉魔数后交给 DPAPI 得到 32 字节 AES 密钥。
 */
async function readMasterKey(layout: QoderLayout): Promise<Buffer> {
  const localStatePath = join(layout.userDataDir, 'Local State')
  let raw: string
  try {
    raw = await readFile(localStatePath, 'utf8')
  } catch {
    throw new CredentialError('no-local-state', `找不到 Local State：${localStatePath}`)
  }

  let parsed: { os_crypt?: { encrypted_key?: string } }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    throw new CredentialError('no-encrypted-key', 'Local State 不是合法 JSON')
  }

  const encoded = parsed.os_crypt?.encrypted_key
  if (typeof encoded !== 'string' || encoded === '') {
    throw new CredentialError('no-encrypted-key', 'Local State 里没有 os_crypt.encrypted_key')
  }

  const wrapped = Buffer.from(encoded, 'base64')
  if (wrapped.length <= DPAPI_MAGIC_LEN) {
    throw new CredentialError('no-encrypted-key', 'encrypted_key 长度异常')
  }
  const magic = wrapped.subarray(0, DPAPI_MAGIC_LEN).toString('latin1')
  if (magic !== 'DPAPI') {
    throw new CredentialError('no-encrypted-key', `encrypted_key 魔数异常：${magic}`)
  }

  const key = await dpapiUnprotect(wrapped.subarray(DPAPI_MAGIC_LEN))
  if (key.length !== 32) {
    throw new CredentialError('dpapi-failed', `主密钥长度应为 32，实际 ${key.length}`)
  }
  return key
}

/**
 * 解一段 Chromium v10 密文。
 *
 * 布局：`"v10" || nonce(12) || ciphertext || tag(16)`，算法 AES-256-GCM。
 */
function decryptV10(key: Buffer, blob: Buffer): string {
  const prefix = blob.subarray(0, V10_PREFIX_LEN).toString('latin1')
  if (prefix !== 'v10') {
    throw new CredentialError('decrypt-failed', `未知的密文前缀：${JSON.stringify(prefix)}`)
  }
  const body = blob.subarray(V10_PREFIX_LEN)
  if (body.length < NONCE_LEN + TAG_LEN) {
    throw new CredentialError('decrypt-failed', '密文长度不足，无法容纳 nonce 与 tag')
  }
  const nonce = body.subarray(0, NONCE_LEN)
  const tag = body.subarray(body.length - TAG_LEN)
  const ciphertext = body.subarray(NONCE_LEN, body.length - TAG_LEN)

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CredentialError('decrypt-failed', `AES-GCM 解密失败：${detail}`)
  }
}

/** auth.v1.dat 的落盘结构。 */
interface AuthFileShape {
  schemaVersion?: number
  token?: string
  refreshToken?: string
  expiresAt?: string
  refreshTokenExpiresAt?: string
  user?: {
    id?: string
    name?: string
    email?: string
    phone?: string | null
    avatarUrl?: string
  }
}

/** 把 auth.v1.dat 明文转成凭据对象；结构不符时抛 bad-schema。 */
function parseCredential(region: QoderRegion, plaintext: string): QoderCredential {
  let data: AuthFileShape
  try {
    data = JSON.parse(plaintext) as AuthFileShape
  } catch {
    throw new CredentialError('bad-schema', 'auth.v1.dat 解密结果不是合法 JSON')
  }

  const uid = data.user?.id
  if (typeof data.token !== 'string' || data.token === '') {
    throw new CredentialError('bad-schema', 'auth.v1.dat 缺少 token')
  }
  if (typeof data.refreshToken !== 'string' || data.refreshToken === '') {
    throw new CredentialError('bad-schema', 'auth.v1.dat 缺少 refreshToken')
  }
  if (typeof uid !== 'string' || uid === '') {
    throw new CredentialError('bad-schema', 'auth.v1.dat 缺少 user.id')
  }

  const credential: QoderCredential = {
    region,
    uid,
    token: data.token,
    refreshToken: data.refreshToken,
  }
  if (typeof data.expiresAt === 'string') credential.expiresAt = data.expiresAt
  if (typeof data.refreshTokenExpiresAt === 'string') credential.refreshTokenExpiresAt = data.refreshTokenExpiresAt
  if (typeof data.user?.name === 'string') credential.name = data.user.name
  if (typeof data.user?.email === 'string') credential.email = data.user.email
  if (data.user?.phone !== undefined) credential.phone = data.user.phone
  if (typeof data.user?.avatarUrl === 'string') credential.avatarUrl = data.user.avatarUrl
  return credential
}

/**
 * 读取该区域的登录凭据。
 *
 * 全程只读；Qoder 桌面端未登录时抛 `no-auth-file`。
 */
export async function readCredential(region: QoderRegion, layout = defaultLayout(region)): Promise<QoderCredential> {
  const authPath = join(layout.userDataDir, 'auth.v1.dat')
  let blob: Buffer
  try {
    blob = await readFile(authPath)
  } catch {
    throw new CredentialError('no-auth-file', `找不到登录凭据：${authPath}（该区域尚未登录）`)
  }

  const key = await readMasterKey(layout)
  const plaintext = decryptV10(key, blob)
  return parseCredential(region, plaintext)
}

/**
 * 只读探针：判断该区域桌面端是否已登录，不抛错。
 *
 * 用于启动日志与 /status 的「未登录」展示，避免把正常的「没登录」当成故障。
 */
export async function probeCredential(
  region: QoderRegion,
  layout = defaultLayout(region),
): Promise<{ ok: true; credential: QoderCredential } | { ok: false; code: CredentialErrorCode; message: string }> {
  try {
    const credential = await readCredential(region, layout)
    return { ok: true, credential }
  } catch (error: unknown) {
    if (error instanceof CredentialError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return {
      ok: false,
      code: 'decrypt-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 访问令牌是否已过期（留 60 秒余量）。无法解析 expiresAt 时视为未过期。 */
export function isExpired(credential: QoderCredential, nowMs = Date.now()): boolean {
  if (credential.expiresAt === undefined) return false
  const at = Date.parse(credential.expiresAt)
  if (Number.isNaN(at)) return false
  return at - 60_000 <= nowMs
}

/** 人类可读的剩余有效期（如「29 天后」），供 /status 展示。 */
export function describeExpiry(expiresAt: string | undefined, nowMs = Date.now()): string | undefined {
  if (expiresAt === undefined) return undefined
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return undefined
  const ms = at - nowMs
  if (ms <= 0) return '已过期'
  const days = Math.floor(ms / 86_400_000)
  if (days >= 1) return `${days} 天后`
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 1) return `${hours} 小时后`
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟后`
}
