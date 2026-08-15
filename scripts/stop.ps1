# PennyWise stop script (ASCII-only so it runs under Windows PowerShell 5.1).
# Stops exactly the ledger server process recorded in data/server.pid.
# Other Node programs (e.g. the agent harness) are never touched.
$ErrorActionPreference = 'SilentlyContinue'
$pidFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\server.pid'
if (Test-Path $pidFile) {
  $p = [int](Get-Content $pidFile)
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) { Stop-Process -Id $p -Force; Write-Host "PennyWise stopped (pid $p)" }
  Remove-Item $pidFile
} else {
  Write-Host 'PennyWise is not running (server.pid not found)'
}
