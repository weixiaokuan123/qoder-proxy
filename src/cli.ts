/**
 * qodercli 子进程驱动。
 *
 * Qoder 的推理能力不在 REST 上（所有 /api/v1/chat/completions 类端点均返回 404），
 * 而是走官方 qodercli 的 SDK 私有协议（stdin/stdout 上的 JSONL + control_request）。
 * 本模块不逆向该协议，而是直接把 qodercli 当作子进程调用，走它的 `-p`（无头）模式，
 * 只消费它的最终文本输出。
 *
 * 设计要点：
 * - 每个请求一个短命子进程，跑完即退。官方文档明确「一个本地 session 由一个 qodercli
 *   进程独占」，所以不做常驻多路复用，避免会话状态串味。
 * - 并发用信号量限制（QODER_CLI_MAX_CONCURRENCY，默认 2），防止内存/CPU 打爆。
 * - 凭据不落到本模块：完全交给 qodercli 自己已登录的配置目录（`qodercli login`）。
 *   如需多账号隔离，用 QODER_CLI_CONFIG_DIR 指定 `--config-dir`。
 *
 * 安全边界：CLI 会自主读写文件、执行命令。本模块固定以「只读工具集 + 拒绝一切
 * 写操作」的权限模式运行，使其退化为纯对话推理，不产生副作用。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/** 内嵌的 qodercli 入口（相对项目根）。 */
const VENDOR_CLI = path.join(PROJECT_ROOT, 'vendor', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js');

/** 单次推理的默认超时（毫秒）。CLI 要起进程 + 握手 + 多轮工具，给足时间。 */
const DEFAULT_TIMEOUT_MS = 180_000;

/** 默认并发上限。每个进程约 100–200MB，别开太大。 */
const DEFAULT_MAX_CONCURRENCY = 2;

export interface CliRunOptions {
  /** 用户提示词。 */
  prompt: string;
  /** 模型名（qodercli 的 --model 取值，如 auto / performance / efficient / lite）。 */
  model?: string;
  /** 工作目录，CLI 在此目录内运行。 */
  cwd?: string;
  /** 超时毫秒数。 */
  timeoutMs?: number;
  /** 附加环境变量。 */
  env?: Record<string, string>;
}

export interface CliRunResult {
  /** 是否成功（进程退出码 0 且无错误）。 */
  ok: boolean;
  /** 模型最终文本输出。 */
  text: string;
  /** 失败时的错误说明。 */
  error?: string;
  /** 进程退出码。 */
  code: number | null;
  /** 耗时毫秒。 */
  durationMs: number;
  /** 是否因超时被杀。 */
  timedOut: boolean;
}

/** 简单信号量，限制同时在跑的 qodercli 进程数。 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  get stats(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** qodercli 的可执行入口；允许用环境变量覆盖以指向自管运行时。 */
export function resolveCliEntry(): string {
  const override = process.env.QODER_CLI_ENTRY?.trim();
  if (override) return override;
  return VENDOR_CLI;
}

/** qodercli 是否可用（内嵌运行时存在）。 */
export function isCliAvailable(): boolean {
  return existsSync(resolveCliEntry());
}

const MAX_CONCURRENCY = readPositiveInt(process.env.QODER_CLI_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY);
const gate = new Semaphore(MAX_CONCURRENCY);

/** 当前并发占用情况，供 /status 展示。 */
export function cliConcurrency(): { active: number; queued: number; limit: number } {
  return gate.stats;
}

/**
 * 从 qodercli 的 stdout 里抽出最终文本。
 *
 * `-p` 默认以纯文本输出（非 stream-json），但 CLI 仍可能在前面打印进度/警告行。
 * 这里做保守处理：优先取标记为最终结果的行，取不到就整体返回。
 */
function extractFinalText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';

  // 若上游给了 stream-json（--output-format stream-json），解析出 result 消息
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const lines = trimmed.split(/\r?\n/);
    let result = '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const obj = JSON.parse(s) as { type?: string; result?: unknown; subtype?: string };
        if (obj.type === 'result' && typeof obj.result === 'string') {
          result = obj.result;
        } else if (obj.type === 'assistant' && typeof obj.result === 'string') {
          result += obj.result;
        }
      } catch {
        // 不是 JSON 行，忽略
      }
    }
    if (result) return result.trim();
  }
  return trimmed;
}

/**
 * 调用 qodercli 做一次推理。
 *
 * 固定以只读、免交互的权限模式运行，使其退化为纯对话：
 * - `--tools ""`        禁用全部内置工具（不读文件、不跑命令）
 * - `-p`                非交互，输出即退出
 * - `--no-session-persistence`  不留会话，避免磁盘堆积
 */
export async function runCli(options: CliRunOptions): Promise<CliRunResult> {
  const entry = resolveCliEntry();
  if (!existsSync(entry)) {
    return {
      ok: false,
      text: '',
      error: `qodercli 未安装：找不到 ${entry}。请先运行 scripts/login-qodercli.ps1 或 npm install。`,
      code: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const timeoutMs = options.timeoutMs ?? readPositiveInt(process.env.QODER_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const cwd = options.cwd ?? process.cwd();
  const release = await gate.acquire();
  const startedAt = Date.now();

  const args = [
    entry,
    '-p',
    options.prompt,
    '--output-format',
    'text',
    '--permission-mode',
    'dont_ask',
    '--tools',
    '',
    '--no-session-persistence',
  ];
  if (options.model) args.push('--model', options.model);
  const configDir = process.env.QODER_CLI_CONFIG_DIR?.trim();
  if (configDir) args.push('--config-dir', configDir);

  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  // 防止外部残留的 PAT 变量覆盖已登录会话
  for (const k of ['QODER_PERSONAL_ACCESS_TOKEN', 'QODERCN_PERSONAL_ACCESS_TOKEN']) {
    if (!options.env?.[k]) delete env[k];
  }

  return await new Promise<CliRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(process.execPath, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (result: CliRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      resolve(result);
    };

    child.on('error', (err: Error) => {
      finish({
        ok: false,
        text: '',
        error: `无法启动 qodercli：${err.message}`,
        code: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });

    child.on('close', (code: number | null) => {
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        finish({
          ok: false,
          text: '',
          error: `qodercli 超时（${timeoutMs}ms）被终止`,
          code,
          durationMs,
          timedOut: true,
        });
        return;
      }
      if (code !== 0) {
        const detail = (stderr.trim() || stdout.trim()).split(/\r?\n/).slice(-6).join(' | ');
        finish({
          ok: false,
          text: '',
          error: `qodercli 退出码 ${code}：${detail || '(无输出)'}`,
          code,
          durationMs,
          timedOut: false,
        });
        return;
      }
      const text = extractFinalText(stdout);
      if (!text) {
        finish({
          ok: false,
          text: '',
          error: 'qodercli 未返回文本内容',
          code,
          durationMs,
          timedOut: false,
        });
        return;
      }
      finish({ ok: true, text, code, durationMs, timedOut: false });
    });
  });
}

/**
 * 读取 qodercli 的登录状态与可用模型清单。
 *
 * 用于 /status 展示，以及判断「已登录 / 未登录」。
 */
export interface CliProbeResult {
  /** CLI 可执行文件存在。 */
  installed: boolean;
  /** 已登录。 */
  loggedIn: boolean;
  /** `status` 命令的原始输出。 */
  statusText: string;
  /** 可用模型列表（`--list-models` 的解析结果）。 */
  models: string[];
}

/**
 * 解析 `qodercli status` 的输出，判断是否已登录。
 *
 * 未登录时输出形如 `Account: Not logged in`；已登录时为账号标识（邮箱/手机）。
 * 导出以便单测覆盖各种边角输入。
 */
export function isStatusLoggedIn(statusText: string): boolean {
  const line = statusText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith('account:'));
  if (!line) return false;
  const value = line.slice('account:'.length).trim();
  return value.length > 0 && value.toLowerCase() !== 'not logged in';
}

export async function probeCli(): Promise<CliProbeResult> {
  const entry = resolveCliEntry();
  if (!existsSync(entry)) {
    return { installed: false, loggedIn: false, statusText: '', models: [] };
  }

  const run = (args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      let out = '';
      const child = spawn(process.execPath, [entry, ...args], {
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: null, out });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });

  const status = await run(['status'], 60_000);
  const statusText = status.out.trim();
  const loggedIn = isStatusLoggedIn(statusText);

  let models: string[] = [];
  if (loggedIn) {
    const list = await run(['--list-models'], 120_000);
    models = list.out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^Failed|^Not logged/i.test(l))
      .filter((l) => /[\t| ]/.test(l) || /^[a-z0-9._-]+$/i.test(l))
      .slice(0, 40);
  }

  return { installed: true, loggedIn, statusText, models };
}
