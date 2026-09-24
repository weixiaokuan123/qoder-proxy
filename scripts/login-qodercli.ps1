# Qoder CLI 一次性准备与登录
#
# 做两件事：
#   1. 确保内嵌 qodercli 运行时已安装（vendor/）
#   2. 打开浏览器完成 OAuth 登录（qodercli 自行保管凭据）
#
# 双击运行，或右键「使用 PowerShell 运行」。

$ErrorActionPreference = 'Stop'
$vendor = Join-Path (Split-Path -Parent $PSScriptRoot) 'vendor'
$cli    = Join-Path $vendor 'node_modules\@qoder-ai\qodercli\bundle\qodercli.js'

Write-Host ""
Write-Host "=== Qoder CLI 准备 ===" -ForegroundColor Cyan

# 1) 安装运行时
if (-not (Test-Path $cli)) {
    Write-Host "[1/2] 未检测到 qodercli，正在安装（约 68MB，请稍候）..." -ForegroundColor Yellow
    Push-Location $vendor
    try {
        if (-not (Test-Path (Join-Path $vendor 'package.json'))) {
            '{"name":"qoder-proxy-vendor","private":true,"version":"1.0.0"}' |
                Set-Content -Path (Join-Path $vendor 'package.json') -Encoding UTF8
        }
        npm install @qoder-ai/qodercli --no-audit --no-fund
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $cli)) {
        Write-Host "安装失败：找不到 $cli" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
    Write-Host "[1/2] 安装完成。" -ForegroundColor Green
} else {
    Write-Host "[1/2] qodercli 已安装，跳过。" -ForegroundColor Green
}

# 2) 登录
Write-Host ""
Write-Host "[2/2] 即将打开浏览器完成授权登录。" -ForegroundColor Yellow
Write-Host "      若已登录，可直接回车跳过（重复登录会覆盖凭据）。" -ForegroundColor DarkGray
$ans = Read-Host "      要现在登录吗？(Y/n)"
if ($ans -eq '' -or $ans -match '^[Yy]') {
    Push-Location $vendor
    try {
        node $cli login
    } finally {
        Pop-Location
    }
}

# 3) 结果
Write-Host ""
Write-Host "=== 当前状态 ===" -ForegroundColor Cyan
Push-Location $vendor
try {
    node $cli status
    Write-Host ""
    Write-Host "--- 可用模型 ---" -ForegroundColor Cyan
    node $cli --list-models
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "完成。若已登录，可重启 qoder-proxy 后访问 /cli/status 验证。" -ForegroundColor Green
Read-Host "按回车关闭"
