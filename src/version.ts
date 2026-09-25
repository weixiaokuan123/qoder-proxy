/**
 * qoder-proxy 版本号。
 *
 * 本项目的凭据读取（Electron safeStorage / Chromium v10 解密）、签到调度器
 * 复用自同目录下的 workbuddy-proxy（MIT），上游协议为对 Qoder 官方客户端的
 * 独立观察实现。
 *
 * 推理面通过官方 @qoder-ai/qodercli 子进程实现（见 src/cli.ts），不逆向私有协议。
 *
 * 发布规则：只 bump PATCH，不 bump MINOR/MAJOR。
 */

export const QODER_PROXY_VERSION = '0.1.4'
