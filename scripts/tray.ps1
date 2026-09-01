# PennyWise tray daemon (runs under Windows PowerShell 5.1+, needs UTF-8 BOM for Chinese text).
# - Keeps the ledger server running in the background; restarts it automatically if it dies.
# - Tray icon (green yuan): open page / restart / stop / exit.
# - Single instance per Windows session.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root   = Split-Path -Parent $PSScriptRoot            # project root (this script lives in <root>\scripts)
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node.exe' }

# --- port from .env (default 8720) ---
$script:port = 8720
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $script:port = [int]$m.Matches[0].Groups[1].Value }
}
$script:baseUrl = 'http://localhost:' + $script:port

# --- single instance ---
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'PennyWiseTray', [ref]$created)
if (-not $created) { exit 0 }

$script:stopping    = $false
$script:lastAttempt = Get-Date '2000-01-01'   # last watchdog-triggered restart; old value = first restart is immediate
Set-Content -Path (Join-Path $root 'data\tray.pid') -Value $PID -Encoding Ascii   # marker for cleanup/debug
$outLog = Join-Path $logDir 'server.out.log'
$errLog = Join-Path $logDir 'server.err.log'

function Rotate-Log($p) {
  try {
    $f = Get-Item $p -ErrorAction SilentlyContinue
    if ($f -and $f.Length -gt 1MB) {
      Remove-Item ($p + '.old') -Force -ErrorAction SilentlyContinue
      Move-Item $p ($p + '.old') -Force -ErrorAction SilentlyContinue
    }
  } catch { }
}

function Test-Server {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $t = $c.BeginConnect('127.0.0.1', $script:port, $null, $null)
    if (-not $t.AsyncWaitHandle.WaitOne(1500)) { return $false }
    $c.EndConnect($t)
    return $true
  } catch { return $false } finally { $c.Close() }
}

function Start-Server {
  Rotate-Log $outLog
  Rotate-Log $errLog
  if (-not (Test-Path $nodeExe)) { return }
  # -WindowStyle Hidden: node gets its OWN hidden console. Do NOT use -NoNewWindow here —
  # a console inherited from the tray dies with the tray's parent console and takes node down.
  Start-Process -FilePath $nodeExe -ArgumentList ('"' + (Join-Path $root 'server\index.js') + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  # Refresh on EVERY start (initial boot, menu restart, watchdog): cooldown measures from the
  # real launch moment, so a slow-booting node is never mistaken for "down" and double-started.
  $script:lastAttempt = Get-Date
}

function Stop-Server {
  # Mirror scripts\stop.ps1: pid file first, then port-owner scan.
  # Never touches other Node programs (the match is PennyWise-specific).
  $pidFile = Join-Path $root 'data\server.pid'
  if (Test-Path $pidFile) {
    $p = 0
    [void][int]::TryParse((Get-Content $pidFile -First 1), [ref]$p)
    if ($p -gt 0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  $conns = Get-NetTCPConnection -LocalPort $script:port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $c.OwningProcess) -ErrorAction SilentlyContinue
    if ($owner -and ($owner.CommandLine -match 'pennywise|server\\index')) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

function Show-Balloon($msg) {
  $script:ni.BalloonTipTitle = 'PennyWise'
  $script:ni.BalloonTipText  = $msg
  $script:ni.ShowBalloonTip(3000)
}

# --- tray icon ---
$icoPath = Join-Path $PSScriptRoot 'pennywise.ico'
if (Test-Path $icoPath) { $icon = New-Object System.Drawing.Icon($icoPath) } else { $icon = [System.Drawing.SystemIcons]::Application }
$script:ni = New-Object System.Windows.Forms.NotifyIcon
$script:ni.Icon = $icon
$script:ni.Text = 'PennyWise 记账（后台守护中）'
$script:ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('打开记账页面', $null, { Start-Process $script:baseUrl })
[void]$menu.Items.Add('重新启动服务', $null, {
  Stop-Server
  Start-Sleep -Milliseconds 500
  Start-Server
  Show-Balloon '服务已重新启动'
})
[void]$menu.Items.Add('停止服务（本次开机内不再自动拉起）', $null, {
  $script:stopping = $true
  Stop-Server
  Show-Balloon '服务已停止。重新启动：托盘右键或双击桌面图标'
})
[void]$menu.Items.Add('-')
[void]$menu.Items.Add('退出托盘（并停止服务）', $null, {
  $script:stopping = $true
  Stop-Server
  $script:ni.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$script:ni.ContextMenuStrip = $menu
$script:ni.add_DoubleClick({ Start-Process $script:baseUrl })

# --- watchdog: restart the server if the port goes down ---
# Cooldown (30s) only paces CONSECUTIVE restart attempts; the first restart after a death is immediate.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({
  if ($script:stopping) { return }
  if (-not (Test-Server)) {
    if (((Get-Date) - $script:lastAttempt).TotalSeconds -ge 30) {
      $script:lastAttempt = Get-Date
      Start-Server
      Show-Balloon 'PennyWise 服务掉线，已在后台自动重启'
    }
  }
})
$timer.Start()

if (-not (Test-Server)) { Start-Server; Start-Sleep -Seconds 2 }
Show-Balloon ('PennyWise 已在后台运行：' + $script:baseUrl)

[System.Windows.Forms.Application]::Run()   # blocks until Application.Exit

$timer.Stop()
$script:ni.Visible = $false
$script:ni.Dispose()
$icon.Dispose()
Remove-Item (Join-Path $root 'data\tray.pid') -Force -ErrorAction SilentlyContinue
$mutex.ReleaseMutex()
