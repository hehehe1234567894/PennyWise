# PennyWise ensure-server: start the ledger server if (and only if) it is not already running.
# Used by open.vbs (manual open) and ghost.ps1 (idle auto-start). Ghost mode has no tray.
# - Double-checks the port owner before spawning: on a busy machine a TCP probe can time out
#   while the old server is still alive -> without this check we would double-start
#   (server.err.log already caught one such "port occupied" conflict).
# - Starts node at BelowNormal priority so background imports never stutter the desktop.
# - ASCII-only so it runs under Windows PowerShell 5.1 without BOM concerns.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$port = 8720
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
$outLog = Join-Path $root 'data\logs\server.out.log'
$errLog = Join-Path $root 'data\logs\server.err.log'

function Test-Port {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $t = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $t.AsyncWaitHandle.WaitOne(1500)) { return $false }
    $c.EndConnect($t)
    return $true
  } catch { return $false } finally { $c.Close() }
}

if (-not (Test-Port)) {
  # Busy-machine false negative guard: a live listener means the server is fine, just slow.
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) {
    $nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (-not (Test-Path $nodeExe)) { $nodeExe = 'node.exe' }
    # V8 compile cache: subsequent cold starts skip recompiling express/xlsx/... (Node >= 22.1)
    $env:NODE_COMPILE_CACHE = Join-Path $root 'data\compile-cache'
    foreach ($p in @($outLog, $errLog)) {
      try {
        $f = Get-Item $p -ErrorAction SilentlyContinue
        if ($f -and $f.Length -gt 1MB) {
          Remove-Item ($p + '.old') -Force -ErrorAction SilentlyContinue
          Move-Item $p ($p + '.old') -Force
        }
      } catch { }
    }
    $proc = Start-Process -FilePath $nodeExe -ArgumentList ('"' + (Join-Path $root 'server\index.js') + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    if ($proc) { try { $proc.PriorityClass = 'BelowNormal' } catch { } }
  }
}
exit 0
