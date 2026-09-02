# PennyWise ghost manager: runs from Task Scheduler every 30 minutes (hidden, exits in ~2s).
# - Server down + PC idle (no user input >= 15min, CPU < 40%, free RAM >= 2GB)
#     -> start the server silently (ensure-server.ps1), it refreshes bill imports off-hours.
#     Respects a 4h cooldown after an auto-stop so an idle machine does not churn start/stop.
# - Server up + nobody looked at it for >= 24h (no HTTP requests, no live connections)
#     and no import in flight and uptime >= 1h -> stop it again. Almost zero presence.
# Logs: data\logs\ghost.log (rotated at 256KB). ASCII-only for PS 5.1.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'data\logs\ghost.log'
$lastStopFile = Join-Path $root 'data\ghost-last-stop.txt'
$actFile = Join-Path $root 'data\last-activity.txt'
$port = 8720
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

function Write-Ghost($msg) {
  try {
    $f = Get-Item $log -ErrorAction SilentlyContinue
    if ($f -and $f.Length -gt 256KB) {
      Remove-Item ($log + '.old') -Force -ErrorAction SilentlyContinue
      Move-Item $log ($log + '.old') -Force
    }
    Add-Content -Path $log -Value ('{0} {1}' -f (Get-Date -Format 'MM-dd HH:mm'), $msg) -Encoding UTF8
  } catch { }
}

function Test-Port {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $t = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $t.AsyncWaitHandle.WaitOne(2500)) { return $false }
    $c.EndConnect($t)
    return $true
  } catch { return $false } finally { $c.Close() }
}

if (Test-Port) {
  # ---- running: maybe auto-stop after 24h of nobody looking ----
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $owner = $null
  if ($listener) { $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue }
  if ($owner -and $owner.ProcessName -eq 'node') {
    $minUp = ((Get-Date) - $owner.StartTime).TotalHours -ge 1
    $est = @(Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $owner.Id })
    $lastAct = 0
    try { $lastAct = [int64](Get-Content $actFile -First 1) } catch { }
    $idleH = 999
    if ($lastAct -gt 0) { $idleH = ((Get-Date) - [DateTimeOffset]::FromUnixTimeMilliseconds($lastAct).LocalDateTime).TotalHours }
    # import in flight? a node burning > 1.5s CPU in 2s means real work -> never kill it
    $c1 = $owner.TotalProcessorTime.TotalMilliseconds
    Start-Sleep -Seconds 2
    $owner.Refresh()
    $busy = ($owner.TotalProcessorTime.TotalMilliseconds - $c1) -gt 1500
    if ($minUp -and -not $busy -and $est.Count -eq 0 -and $idleH -ge 24) {
      Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
      Remove-Item (Join-Path $root 'data\server.pid') -Force -ErrorAction SilentlyContinue
      Set-Content -Path $lastStopFile -Value (Get-Date).ToString('o') -Encoding Ascii
      Write-Ghost ('auto-stop: {0:N1}h no visit, no live connection' -f $idleH)
    } else {
      Write-Ghost ('running: idle={0:N1}h est={1} busy={2} up1h={3}' -f $idleH, $est.Count, $busy, $minUp)
    }
  }
} else {
  # ---- down: start only when the PC is idle AND has resources to spare ----
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GhostIdle {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint IdleSeconds() {
    var li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) return uint.MaxValue;
    uint now = (uint)Environment.TickCount;
    return now >= li.dwTime ? (now - li.dwTime) / 1000 : 0;
  }
}
'@
  $idleSec = [GhostIdle]::IdleSeconds()
  $load = $null
  try { $load = (Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average } catch { }
  $freeMB = 0
  try { $freeMB = [int]((Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory / 1KB) } catch { }
  $cooldownOk = $true
  try {
    $ls = Get-Content $lastStopFile -ErrorAction Stop
    if (((Get-Date) - [DateTime]::Parse($ls)).TotalHours -lt 4) { $cooldownOk = $false }
  } catch { }
  if ($cooldownOk -and $idleSec -ge 900 -and ($null -eq $load -or $load -lt 40) -and $freeMB -ge 2048) {
    & (Join-Path $PSScriptRoot 'ensure-server.ps1')
    Write-Ghost ('idle-start: user idle {0}s, cpu {1}%, free ram {2}MB' -f $idleSec, $load, $freeMB)
  } else {
    Write-Ghost ('skip-start: user idle {0}s, cpu {1}%, free ram {2}MB, cooldown-ok {3}' -f $idleSec, $load, $freeMB, $cooldownOk)
  }
}
exit 0
