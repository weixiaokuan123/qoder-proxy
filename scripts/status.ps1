# qoder-proxy status: 端口、版本、各区域账号/额度/签到一览。
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Port = 39320
$PidFile = Join-Path $Root 'logs\proxy.pid'

function Test-Port([int]$P) {
  try { $t = New-Object System.Net.Sockets.TcpClient; $t.Connect('127.0.0.1', $P); $t.Close(); return $true }
  catch { return $false }
}

if (-not (Test-Port $Port)) {
  Write-Host "qoder-proxy: NOT RUNNING (port $Port closed)"
  exit 1
}

$procId = '?'
if (Test-Path $PidFile) { $procId = (Get-Content $PidFile -Raw).Trim() }
Write-Host "qoder-proxy: RUNNING  port=$Port  pid=$procId"
Write-Host ''

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 10
  Write-Host ("version  : {0}   uptime: {1}s" -f $health.version, $health.uptimeSec)
  Write-Host ''

  $st = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 45
  foreach ($r in $st.regions) {
    Write-Host ("── {0} ─────────────────────────" -f $r.region)
    if (-not $r.loggedIn) {
      Write-Host ("  未登录：{0}" -f $r.message)
      continue
    }
    $who = if ($r.email) { $r.email } elseif ($r.phone) { $r.phone } else { $r.name }
    Write-Host ("  账号   : {0}" -f $who)
    if ($r.name -and $who -ne $r.name) { Write-Host ("  昵称   : {0}" -f $r.name) }
    Write-Host ("  令牌   : {0}（{1}）" -f $r.tokenExpiresAt, $r.tokenExpiresIn)
    if ($r.plan) { Write-Host ("  套餐   : {0}（{1}）" -f $r.plan.planTierName, $r.plan.userType) }
    if ($r.usage) {
      Write-Host ("  额度   : {0}/{1} {2}（已用 {3}，超额={4}）" -f `
        $r.usage.remaining, $r.usage.total, $r.usage.unit, $r.usage.used, $r.usage.isQuotaExceeded)
    }
    if ($r.signin) {
      $s = $r.signin
      if ($s.todayCheckedIn) { $mark = '今日已领' }
      elseif ($s.claimable)   { $mark = ("可领 {0} 项（{1} {2}）" -f $s.claimableCampaigns.Count, $s.claimableAmount, 'CREDITS') }
      elseif ($s.hasBenefitCampaign) { $mark = '未到刷新时间' }
      else { $mark = '该区域无每日签到活动' }
      Write-Host ("  签到   : {0}   每日 {1} Credits" -f $mark, $s.dailyCredit)
      if ($s.streakDays) { Write-Host ("  连续   : {0} 天" -f $s.streakDays) }
    }
    Write-Host ''
  }
} catch {
  Write-Host ("读取状态失败：{0}" -f $_.Exception.Message)
  exit 1
}

# 今日签到计划
$stateFile = Join-Path $Root 'state\signin.json'
if (Test-Path $stateFile) {
  Write-Host '── 今日签到计划 ─────────────────'
  try {
    $j = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $j.PSObject.Properties) {
      $sec = [int]$p.Value.runAtSec
      $hh = [math]::Floor($sec / 3600).ToString('00')
      $mm = [math]::Floor(($sec % 3600) / 60).ToString('00')
      $done = if ($p.Value.claimed) { '已完成' } else { '待执行' }
      Write-Host ("  {0,-14} {1}:{2}  {3}   {4}" -f $p.Name, $hh, $mm, $done, $p.Value.result)
    }
  } catch {
    Write-Host '  （状态文件解析失败）'
  }
}
