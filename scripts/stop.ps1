# PennyWise stop script (ASCII-only so it runs under Windows PowerShell 5.1).
# Stops the ledger server: first by data/server.pid, then by scanning port 8720 as fallback.
# Other Node programs (e.g. the agent harness) are never touched.
$ErrorActionPreference = 'SilentlyContinue'
$port = 8720
$stopped = $false
$pidFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\server.pid'
if (Test-Path $pidFile) {
  $p = [int](Get-Content $pidFile)
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) { Stop-Process -Id $p -Force; Write-Host "PennyWise stopped (pid $p)"; $stopped = $true }
  Remove-Item $pidFile
}
# fallback: whoever is listening on the port is the ledger server
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($c in $conns) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction SilentlyContinue
    if ($owner -and $owner.CommandLine -match 'pennywise|server\\index') {
      Stop-Process -Id $c.OwningProcess -Force
      Write-Host "PennyWise stopped by port scan (pid $($c.OwningProcess))"
      $stopped = $true
    }
  }
}
if (-not $stopped) { Write-Host 'PennyWise is not running' }
