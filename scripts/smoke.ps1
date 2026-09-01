# PennyWise smoke test (ASCII-only so it runs under Windows PowerShell 5.1)
#
# Run after the server is up:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1
# Reads AUTH_TOKEN from .env, walks health/auth/capture/confirm/idempotency/
# manual-create/patch/delete/list/summary/static assets. Exit code 0 = all pass.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$base = 'http://127.0.0.1:8720'
$token = ''
Get-Content (Join-Path $root '.env') | ForEach-Object {
  if ($_ -match '^AUTH_TOKEN=(.+)$') { $token = $Matches[1].Trim('"').Trim("'") }
}
if (-not $token) { Write-Host 'FAIL: no AUTH_TOKEN found in .env'; exit 1 }

$pass = 0; $fail = 0
function Check($name, $cond, $detail = '') {
  if ($cond) { $script:pass++; Write-Host "PASS  $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "FAIL  $name $detail" -ForegroundColor Red }
}
function Call($method, $path, $body = $null, $withToken = $true) {
  $p = @{ Method = $method; Uri = "$base$path"; TimeoutSec = 90 }
  if ($withToken) { $p.Headers = @{ 'X-Auth-Token' = $token } }
  if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Compress -Depth 8) }
  Invoke-RestMethod @p
}
function StatusOf($method, $path, $body = $null, $baseUrl = $base) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method $method -Uri "$baseUrl$path" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 90 -ErrorAction Stop
    return $r.StatusCode
  } catch { return [int]$_.Exception.Response.StatusCode.value__ }
}

# 0. pre-clean leftovers from aborted runs (smoke- prefixed ids / test merchants)
try {
  $leftovers = @((Call GET '/api/transactions?limit=500').data.items | Where-Object { $_.client_id -like 'smoke-*' -or $_.uid -like 'smoke-*' -or $_.merchant -in @('FamilyMart', 'PendTest', 'SyncTest') })
  foreach ($l in $leftovers) { Call DELETE "/api/transactions/$($l.id)" | Out-Null }
  if ($leftovers.Count -gt 0) { Write-Host "INFO  pre-cleaned $($leftovers.Count) leftover test rows" -ForegroundColor Yellow }
} catch { }

# 1. endpoints: everything except /qr requires token (local or remote)
Check 'health requires token (401)' ((StatusOf GET '/api/health') -eq 401)
$h = Call GET '/api/health'
Check 'health endpoint' ($h.ok -eq $true)
Check 'config requires token (401)' ((StatusOf GET '/api/config') -eq 401)
Check 'config says token required' ((Call GET '/api/config').tokenRequired -eq $true)

# 1b. reachability (needs token) & cross-site protection
$rc = Call GET '/api/reachability'
Check 'reachability endpoint' ($rc.ok -eq $true -and $rc.port -eq 8720)
Check 'reachability lists addresses' (($rc.lan.Count + $rc.tailscale.Count) -ge 1)
$evil = curl.exe -s -o NUL -w '%{http_code}' -H 'Origin: http://example.com' "$base/api/health"
Check 'cross-site origin blocked (403)' ($evil -eq '403')
$evilAcao = curl.exe -s -i -H 'Origin: http://example.com' "$base/api/health" | Select-String 'Access-Control-Allow-Origin'
Check 'no ACAO for evil origin' ($null -eq $evilAcao)
$sameAcao = curl.exe -s -i -H "Origin: $base" "$base/api/health" | Select-String 'Access-Control-Allow-Origin'
Check 'same-origin ACAO echoed' ($null -ne $sameAcao)
$preEvil = curl.exe -s -o NUL -w '%{http_code}' -X OPTIONS -H 'Origin: http://example.com' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: X-Auth-Token' "$base/api/transactions"
Check 'evil preflight rejected (403)' ($preEvil -eq '403')
$preOk = curl.exe -s -o NUL -w '%{http_code}' -X OPTIONS -H "Origin: $base" -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: X-Auth-Token' "$base/api/transactions"
Check 'same-origin preflight 204' ($preOk -eq '204')

# 1c. QR pairing: /qr is the only public endpoint (text to SVG); connect-info always needs token
$qr = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/qr?text=test&size=100"
Check 'qr endpoint returns svg' ($qr.StatusCode -eq 200 -and $qr.Content -match '<svg')
Check 'connect-info rejected locally without token (401)' ((StatusOf GET '/api/connect-info') -eq 401)
$ci = Call GET '/api/connect-info'
Check 'connect-info available with token' ($ci.ok -and $ci.data.token -eq $token)

# 1d. security headers
$sec = curl.exe -s -i "$base/" | Select-String 'Content-Security-Policy|X-Content-Type-Options|X-Frame-Options'
Check 'security headers present' (($sec | Measure-Object).Count -ge 3)
Check 'health reports autoConfirm' ([double]$h.autoConfirm -ge 0 -and [double]$h.autoConfirm -le 1)
Check 'health reports modelStatus' ($null -ne $h.modelStatus -and $null -ne $h.modelStatus.text -and $null -ne $h.modelStatus.vision)
# 1e. AI agent endpoint: empty text must be 400 (no LLM call, zero cost)
$agent400 = $false
try {
  Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$base/api/agent" -Headers @{ 'X-Auth-Token' = $token } -ContentType 'application/json' -Body '{"text":""}' -ErrorAction Stop | Out-Null
} catch { $agent400 = ([int]$_.Exception.Response.StatusCode.value__ -eq 400) }
Check 'agent rejects empty text (400)' $agent400
$rp = Call GET '/api/report/preview?lite=1'
Check 'report preview builds' ($rp.ok -and $null -ne $rp.data.text -and $rp.data.text.Length -gt 20)
# 账单核验（空月份：无 LLM 调用、秒回）
$auCode = curl.exe -s -o NUL -w '%{http_code}' --max-time 30 "$base/api/audit?month=2000-01"
Check 'audit requires token (401)' ($auCode -eq '401')
$au = Call GET '/api/audit?month=2000-01'
Check 'audit endpoint (empty month)' ($au.ok -and $au.data.summary.billRows -eq 0)
# 理财健康度（空月份：income=0 → pct/rate/safeToday 均为 null）
$fin = Call GET '/api/finance?month=2000-01'
Check 'finance endpoint (empty month)' ($fin.ok -and $null -eq $fin.data.savings.rate -and $null -eq $fin.data.safeToday -and $fin.data.needs.target -eq 50)
$sh = curl.exe -s -o NUL -w '%{http_code}' -X POST "$base/share"
Check 'share fallback redirects (303)' ($sh -eq '303')
$ac = Call POST '/api/settings' @{ auto_confirm = 0.9 }
Check 'settings auto_confirm roundtrip' ($ac.ok -and $ac.data.autoConfirm -eq 0.9)

# 2. auth from another address (this machine's LAN IP): no token always rejected
$extBase = "http://$($rc.lan[0].ip):8720"
Check 'no token rejected (401)' ((StatusOf POST '/api/capture' @{ text = 'x' } $extBase) -eq 401)
Check 'bad token rejected (401)' ((StatusOf POST '/api/transactions' @{ amount = 1 } $extBase) -eq 401)
Check 'connect-info rejected remotely without token (401)' ((StatusOf GET '/api/connect-info' $null $extBase) -eq 401)
Check 'reachability requires token remotely (401)' ((StatusOf GET '/api/reachability' $null $extBase) -eq 401)
Check 'merchants endpoint works remotely (401)' ((StatusOf GET '/api/merchants' $null $extBase) -eq '401')

# 3. capture (LLM parses; high confidence auto-confirms, otherwise stays pending)
# record baseline (ledger may contain real data; assert by delta)
$baseSum = Call GET '/api/summary'
$baseExpense = $baseSum.data.expense
$basePending = $baseSum.data.pendingCount
$c = Call POST '/api/capture' @{ text = 'WeChat Pay: FamilyMart CNY 18.50'; client_id = "smoke-1-$([guid]::NewGuid())" }
Check 'capture creates record' ($c.ok -and ($c.data.transaction.status -eq 'pending' -or $c.data.transaction.status -eq 'confirmed'))
Check 'capture returns parse state' ($null -ne $c.data.parse.code)
$txId = $c.data.transaction.id

# 4. idempotency via client_id (offline outbox retry must not duplicate)
$dup = Call POST '/api/capture' @{ text = 'WeChat Pay: FamilyMart CNY 18.50'; client_id = "smoke-dup-$([guid]::NewGuid())" }
$dupId = $dup.data.transaction.id
$dup2 = Call POST '/api/capture' @{ text = 'WeChat Pay: FamilyMart CNY 18.50'; client_id = $dup.data.transaction.client_id }
Check 'outbox retry is idempotent' ($dup2.data.parse.code -eq 'duplicate')
Call DELETE "/api/transactions/$dupId" | Out-Null  # remove duplicate to keep summary assertions clean

# 5. register a custom category (also exercises the categories API; idempotent)
$catsBefore = (Call GET '/api/categories').data
if ($catsBefore.expense -notcontains 'Dining') { Call POST '/api/categories' @{ name = 'Dining'; kind = 'expense' } | Out-Null }
$catsAfter = (Call GET '/api/categories').data
Check 'register custom category' ($catsAfter.expense -contains 'Dining')

# 6. confirm with overrides
$cf = Call POST "/api/transactions/$txId/confirm" @{ overrides = @{ amount = 18.5; direction = 'expense'; merchant = 'FamilyMart'; category = 'Dining'; account = 'wechat'; note = 'smoke' } }
Check 'confirm with overrides' ($cf.ok -and $cf.data.status -eq 'confirmed' -and $cf.data.amount -eq 18.5)
Check 'confirm learns merchant rule' ($cf.ok -and $cf.data.category -eq 'Dining')

# 6. manual income + patch + delete
$m = Call POST '/api/transactions' @{ amount = 200; direction = 'income'; merchant = 'Mom'; account = 'alipay' }
Check 'manual create income' ($m.ok -and $m.data.status -eq 'confirmed')
$p = Call PATCH "/api/transactions/$($m.data.id)" @{ note = 'allowance' }
Check 'patch edit' ($p.data.note -eq 'allowance')
$d = Call DELETE "/api/transactions/$($m.data.id)"
Check 'delete' ($d.ok -and $d.data.deleted -eq $m.data.id)

# 7. list / summary
$list = Call GET '/api/transactions'
Check 'list returns items' ($list.ok -and $list.data.total -ge 1)
$sum = Call GET '/api/summary'
Check 'summary expense correct' ([math]::Abs($sum.data.expense - ($baseExpense + 18.5)) -lt 0.001)

# 8. categories include seeded values
$cats = (Call GET '/api/categories').data
Check 'seeded expense categories present' ($cats.expense.Count -ge 5)

# 9. static PWA assets
foreach ($p in '/', '/app.js', '/styles.css', '/sw.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png') {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "$base$p" -ErrorAction SilentlyContinue
  Check "static $p" ($null -ne $r -and $r.StatusCode -eq 200)
}

# 10. sync protocol (two-way sync: pull deltas, push changes, tombstones)
$s0 = Call GET '/api/sync?since=0'
Check 'sync pull returns rev' ($s0.ok -and $s0.data.rev -ge 1)
$syncUid = 'smoke-sync-' + [guid]::NewGuid().ToString('N')
$push = Call POST '/api/sync' @{ changes = @( @{ uid = $syncUid; type = 'put'; updated_at = '2099-01-01T00:00:00.000Z'; data = @{ ts = '2099-01-01T00:00:00.000Z'; amount = 9.9; direction = 'expense'; merchant = 'SyncTest'; category = 'Dining'; account = 'other'; source = 'manual'; status = 'confirmed' } } ) }
Check 'sync push applied' ($push.ok -and ($push.data.applied -contains $syncUid))
$pull2 = Call GET "/api/sync?since=$($s0.data.rev)"
$foundPut = $pull2.data.changes | Where-Object { $_.uid -eq $syncUid -and $_.type -eq 'put' }
Check 'sync pull contains pushed change' ($null -ne $foundPut)
$del = Call POST '/api/sync' @{ changes = @( @{ uid = $syncUid; type = 'del'; updated_at = '2099-01-02T00:00:00.000Z' } ) }
Check 'sync delete applied' ($del.ok -and ($del.data.applied -contains $syncUid))
$pull3 = Call GET "/api/sync?since=$($pull2.data.rev)"
$foundDel = $pull3.data.changes | Where-Object { $_.uid -eq $syncUid -and $_.type -eq 'del' }
Check 'sync tombstone propagated' ($null -ne $foundDel)

# 10b. deterministic pending record via sync push (no LLM involved)
$pendUid = 'smoke-pend-' + [guid]::NewGuid().ToString('N')
$pendPush = Call POST '/api/sync' @{ changes = @( @{ uid = $pendUid; type = 'put'; updated_at = (Get-Date).ToUniversalTime().ToString('o'); data = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); amount = 5; direction = 'expense'; merchant = 'PendTest'; category = 'Dining'; account = 'other'; source = 'text'; status = 'pending' } } ) }
Check 'sync push pending applied' ($pendPush.ok -and ($pendPush.data.applied -contains $pendUid))
$sum2 = Call GET '/api/summary'
Check 'summary has pending count' ($sum2.data.pendingCount -ge ($basePending + 1))
Call POST '/api/sync' @{ changes = @( @{ uid = $pendUid; type = 'del'; updated_at = (Get-Date).ToUniversalTime().AddSeconds(1).ToString('o') } ) } | Out-Null

# 10c. budgets roundtrip (Firefly-style category limits)
$bUp = Call PUT '/api/budgets' @{ month = '2026-08'; category = 'Dining'; limit = 100 }
Check 'budget upsert' ($bUp.ok -and $bUp.data.limit -eq 100)
$bList = Call GET '/api/budgets?month=2026-08'
$bRow = $bList.data.list | Where-Object { $_.category -eq 'Dining' }
Check 'budget list with spent' ($bList.ok -and $null -ne $bRow -and $bRow.limit -eq 100 -and $bRow.spent -ge 0)
$bDel = Call DELETE '/api/budgets?month=2026-08&category=Dining'
Check 'budget delete' ($bDel.ok)

# 11. cleanup: remove rows and the custom category created by this run (keeps the test idempotent)
Call DELETE "/api/transactions/$txId" | Out-Null
Call DELETE '/api/categories/Dining' | Out-Null
$final = Call GET '/api/summary'
Check 'cleanup restores empty ledger' ([math]::Abs($final.data.expense - $baseExpense) -lt 0.001)

Write-Host ''
Write-Host "Result: $pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 }
