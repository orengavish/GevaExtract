<#
  auto-geva-scheduled.ps1
  Runs at 10:00, 12:30, 15:00 CT (registered via Task Scheduler).
  Steps:
    1. Ensure GevaExtract server (:5005) is up — start if not
    2. Ensure CC2026 dashboard (:5003) is up — start if not
    3. Ensure broker+decider session is running — start if not
    4. Enable replenish
    5. Check today's lines — fetch from Facebook if absent
    6. Build trades (all brackets, MES+MNQ, minStrength=1)
    7. Submit (dedup + dual sanity check run server-side)
    8. Structured log to logs\auto-trade.log
#>

$GEVA_URL = "http://localhost:5005"
$CC_URL   = "http://localhost:5003"
$GEVA_DIR = "C:\Projects\GevaExtract"
$CC_DIR   = "C:\Projects\CriticalCorallations2026"
$LOG_FILE = Join-Path $GEVA_DIR "logs\auto-trade.log"

# Ensure log directory exists
$null = New-Item -ItemType Directory -Force (Split-Path $LOG_FILE)

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$ts | $msg"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

function HttpGet($url) {
    try {
        $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        $r.Content | ConvertFrom-Json
    } catch { $null }
}

function HttpPost($url, $bodyObj) {
    try {
        $json = if ($null -ne $bodyObj) { $bodyObj | ConvertTo-Json -Depth 10 -Compress } else { '{}' }
        $r = Invoke-WebRequest $url -Method POST -Body $json `
             -ContentType 'application/json' -UseBasicParsing -TimeoutSec 210 -ErrorAction Stop
        $r.Content | ConvertFrom-Json
    } catch { $null }
}

function WaitFor($url, [int]$sec) {
    $deadline = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $deadline) {
        if ($null -ne (HttpGet $url)) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

# ── 0. Banner ─────────────────────────────────────────────────────────────────
$runTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Log "===== AUTO GEVA START $runTime ====="

# ── 1. Ensure GevaExtract is up ───────────────────────────────────────────────
if ($null -eq (HttpGet "$GEVA_URL/api/prices")) {
    Log "GevaExtract not responding — starting server.js"
    Start-Process -FilePath "node" -ArgumentList "server.js" `
        -WorkingDirectory $GEVA_DIR -WindowStyle Hidden
    if (-not (WaitFor "$GEVA_URL/api/prices" 35)) {
        Log "ERROR: GevaExtract failed to start after 35s — aborting"
        exit 1
    }
    Log "GevaExtract started OK"
} else {
    Log "GevaExtract already up"
}

# ── 2. Ensure CC2026 dashboard is up ─────────────────────────────────────────
if ($null -eq (HttpGet "$CC_URL/api/session/status")) {
    Log "CC2026 not responding — starting trading_dashboard.py"
    Start-Process -FilePath "python" `
        -ArgumentList "back-trading/trading_dashboard.py" `
        -WorkingDirectory $CC_DIR -WindowStyle Hidden
    if (-not (WaitFor "$CC_URL/api/session/status" 50)) {
        Log "WARN: CC2026 still not responding — will continue without session control"
    } else {
        Log "CC2026 started OK"
    }
} else {
    Log "CC2026 already up"
}

# ── 3. Ensure broker + decider session running ────────────────────────────────
$sess = HttpGet "$CC_URL/api/session/status"
if ($null -ne $sess) {
    $brokerOk  = $sess.broker  -eq 'running'
    $deciderOk = $sess.decider -eq 'running'
    if (-not ($brokerOk -and $deciderOk)) {
        Log "Session not running (broker=$($sess.broker) decider=$($sess.decider)) — starting"
        $null = HttpPost "$CC_URL/api/session/start" $null
        $deadline = (Get-Date).AddSeconds(50)
        while ((Get-Date) -lt $deadline) {
            $sess = HttpGet "$CC_URL/api/session/status"
            if ($sess.broker -eq 'running' -and $sess.decider -eq 'running') { break }
            Start-Sleep -Seconds 5
        }
    }
    $sess = HttpGet "$CC_URL/api/session/status"
    Log "Session: broker=$($sess.broker) decider=$($sess.decider)"
} else {
    Log "WARN: CC2026 unreachable — skipping session check"
}

# ── 4. Enable replenish ───────────────────────────────────────────────────────
$rep = HttpPost "$GEVA_URL/api/replenish" @{ enabled = $true }
$repOk = if ($null -ne $rep -and $rep.ok) { "ON" } else { "FAILED" }
Log "Replenish: $repOk"

# ── 5. Check today's lines ────────────────────────────────────────────────────
$linesInfo = HttpGet "$GEVA_URL/api/today-lines"
$hasLines  = $null -ne $linesInfo -and $linesInfo.hasLines -eq $true
Log "Today lines: hasLines=$hasLines count=$($linesInfo.count) date=$($linesInfo.date)"

if (-not $hasLines) {
    # ── 6. Fetch from Facebook ────────────────────────────────────────────────
    Log "No lines for today — fetching from Facebook (timeout 3 min)..."
    $fetchResult = HttpPost "$GEVA_URL/fetch" $null
    if ($null -eq $fetchResult -or -not $fetchResult.ok) {
        $errMsg = if ($null -ne $fetchResult) { $fetchResult.msg } else { "no response" }
        Log "FETCH FAILED: $errMsg — no lines available, aborting"
        Log "===== AUTO GEVA DONE (no lines) ====="
        exit 0
    }
    Log "Fetch succeeded: $($fetchResult.msg)"

    # Re-check lines after fetch
    $linesInfo = HttpGet "$GEVA_URL/api/today-lines"
    $hasLines  = $null -ne $linesInfo -and $linesInfo.hasLines -eq $true
    if (-not $hasLines) {
        Log "Fetch returned OK but no lines parsed — not a trading day, aborting"
        Log "===== AUTO GEVA DONE (no lines) ====="
        exit 0
    }
    Log "Lines after fetch: count=$($linesInfo.count)"
}

# ── 7. Build trades ───────────────────────────────────────────────────────────
$allBrackets = @('b4','b8','b16','b32','b4/16','b16/4','b8/32','b32/8')
$buildBody   = [PSCustomObject]@{
    symbols     = @('MES','MNQ')
    brackets    = $allBrackets
    minStrength = 1
}
Log "Building trades (all brackets, MES+MNQ)..."
$buildResult = HttpPost "$GEVA_URL/api/trades/create" $buildBody

if ($null -eq $buildResult -or -not $buildResult.ok) {
    # Retry once after 38s — price poller runs every 30s, may not have fired yet
    $errMsg = if ($null -ne $buildResult) { $buildResult.msg } else { "no response" }
    Log "Build attempt 1 failed ($errMsg) — retrying in 38s"
    Start-Sleep -Seconds 38
    $buildResult = HttpPost "$GEVA_URL/api/trades/create" $buildBody
}

if ($null -eq $buildResult -or -not $buildResult.ok) {
    $errMsg = if ($null -ne $buildResult) { $buildResult.msg } else { "no response" }
    Log "BUILD FAILED: $errMsg — aborting"
    exit 1
}

$total  = $buildResult.total
$passed = $buildResult.passed
$sanF   = $buildResult.sanityFiltered
$dedup  = $buildResult.deduped
$srcMes = $buildResult.priceSource.MES
$srcMnq = $buildResult.priceSource.MNQ
Log "Build: total=$total passed=$passed sanityFiltered=$sanF deduped=$dedup price(MES=$srcMes MNQ=$srcMnq)"

if ($passed -eq 0) {
    Log "No candidates after filter/dedup — nothing to submit this run"
    Log "===== AUTO GEVA DONE (0 candidates) ====="
    exit 0
}

# ── 8. Submit ─────────────────────────────────────────────────────────────────
Log "Submitting $passed orders..."
$submitBody   = [PSCustomObject]@{ commands = $buildResult.candidates }
$submitResult = HttpPost "$GEVA_URL/api/submit-commands" $submitBody

if ($null -eq $submitResult -or -not $submitResult.ok) {
    $errMsg = if ($null -ne $submitResult) { $submitResult.msg } else { "no response" }
    Log "SUBMIT FAILED: $errMsg"
    exit 1
}

$dropped = if ($null -ne $submitResult.sanityDropped) { $submitResult.sanityDropped } else { 0 }
Log "SUBMITTED: inserted=$($submitResult.inserted) secondarySanityDropped=$dropped"
Log "===== AUTO GEVA DONE OK ====="
exit 0
