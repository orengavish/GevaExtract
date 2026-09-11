# auto-geva-scheduled.ps1
# Runs at 16:25 / 20:30 / 23:00 IL = 08:25 / 12:30 / 15:00 CT
# 2026-09-10: first run moved 18:00 -> 16:25 IL so the FB fetch lands before the 16:30 IL
# market open, not ~18:30 after execution delay (too late for same-day lines).
# 2026-09-10: steps 7-8 (build+submit via GevaExtract's own /api/trades/create and
# /api/submit-commands) replaced with a call to CC2026's own /api/geva/import-manual-lines --
# GevaExtract's execution pipeline is blocked (2026-09-09 incident, broker.py Gate 0 cancels
# anything source='geva_extract' anyway, so those two calls were pure waste). This only reads
# geva.db (already fetched above) and inserts into CC2026's own critical_lines as
# source='geva_manual' + a matched control, which decider.py's existing pipeline then trades.
# Steps: ensure services up -> session running -> replenish -> check/fetch lines -> import into CC2026 -> log

$GEVA_URL = "http://localhost:5005"
$CC_URL   = "http://localhost:5003"
$GEVA_DIR = "C:\Projects\GevaExtract"
$CC_DIR   = "C:\Projects\CriticalCorallations2026"
$LOG_FILE = "C:\Projects\GevaExtract\logs\auto-trade.log"
$NODE_EXE = "C:\Program Files\nodejs\node.exe"

$null = New-Item -ItemType Directory -Force "C:\Projects\GevaExtract\logs"

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
    } catch {
        $null
    }
}

function HttpPost($url, $bodyObj) {
    try {
        $json = if ($null -ne $bodyObj) { $bodyObj | ConvertTo-Json -Depth 10 -Compress } else { '{}' }
        $r = Invoke-WebRequest $url -Method POST -Body $json `
             -ContentType 'application/json' -UseBasicParsing -TimeoutSec 210 -ErrorAction Stop
        $r.Content | ConvertFrom-Json
    } catch {
        $null
    }
}

function WaitFor($url, [int]$sec) {
    $deadline = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $deadline) {
        if ($null -ne (HttpGet $url)) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

Log "===== AUTO GEVA START ====="

# Step 1: Ensure GevaExtract is up
if ($null -eq (HttpGet "$GEVA_URL/api/prices")) {
    Log "GevaExtract not responding - starting server.js"
    Start-Process -FilePath $NODE_EXE -ArgumentList "server.js" -WorkingDirectory $GEVA_DIR -WindowStyle Hidden
    if (-not (WaitFor "$GEVA_URL/api/prices" 40)) {
        Log "ERROR: GevaExtract failed to start - aborting"
        exit 1
    }
    Log "GevaExtract started OK"
} else {
    Log "GevaExtract already up"
}

# Step 2: Ensure CC2026 dashboard is up
if ($null -eq (HttpGet "$CC_URL/api/session/status")) {
    Log "CC2026 not responding - starting trading_dashboard.py"
    Start-Process -FilePath "python" -ArgumentList "back-trading/trading_dashboard.py" `
        -WorkingDirectory $CC_DIR -WindowStyle Hidden
    if (-not (WaitFor "$CC_URL/api/session/status" 50)) {
        Log "WARN: CC2026 still not responding - continuing without session control"
    } else {
        Log "CC2026 started OK"
    }
} else {
    Log "CC2026 already up"
}

# Step 3: Ensure broker + decider session running
$sess = HttpGet "$CC_URL/api/session/status"
if ($null -ne $sess) {
    if ($sess.broker -ne 'running' -or $sess.decider -ne 'running') {
        Log "Session not running (broker=$($sess.broker) decider=$($sess.decider)) - starting"
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
    Log "WARN: CC2026 unreachable - skipping session check"
}

# Step 4: Enable replenish
$rep = HttpPost "$GEVA_URL/api/replenish" @{ enabled = $true }
$repOk = if ($null -ne $rep -and $rep.ok) { "ON" } else { "FAILED" }
Log "Replenish: $repOk"

# Step 5: Check today's lines
$linesInfo = HttpGet "$GEVA_URL/api/today-lines"
$hasLines  = ($null -ne $linesInfo) -and ($linesInfo.hasLines -eq $true)
Log "Today lines: hasLines=$hasLines count=$($linesInfo.count) date=$($linesInfo.date)"

# Fallback snapshot: /api/today-lines reports the latest stored post's date/count even
# when it's stale (hasLines=false), so this is available to fall back to if today's
# fetch attempt fails outright, rather than blocking trading over a late/failed post.
$staleFallback = $linesInfo

if (-not $hasLines) {
    # Step 6: Fetch from Facebook
    Log "No lines for today - fetching from Facebook (timeout 3 min)..."
    $fetchResult = HttpPost "$GEVA_URL/fetch" $null
    if ($null -eq $fetchResult -or -not $fetchResult.ok) {
        $errMsg = if ($null -ne $fetchResult) { $fetchResult.msg } else { "no response" }
        if ($null -ne $staleFallback -and $staleFallback.count -gt 0) {
            Log "FETCH FAILED: $errMsg - falling back to latest stored post (date=$($staleFallback.date) count=$($staleFallback.count))"
        } else {
            Log "FETCH FAILED: $errMsg - no lines available, aborting"
            Log "===== AUTO GEVA DONE (no lines) ====="
            exit 0
        }
    } else {
        Log "Fetch succeeded: $($fetchResult.msg)"
        $linesInfo = HttpGet "$GEVA_URL/api/today-lines"
        $hasLines  = ($null -ne $linesInfo) -and ($linesInfo.hasLines -eq $true)
        if (-not $hasLines) {
            if ($null -ne $staleFallback -and $staleFallback.count -gt 0) {
                Log "Fetch OK but no lines parsed for today - falling back to latest stored post (date=$($staleFallback.date) count=$($staleFallback.count))"
            } else {
                Log "Fetch OK but no lines parsed - not a trading day, aborting"
                Log "===== AUTO GEVA DONE (no lines) ====="
                exit 0
            }
        } else {
            Log "Lines after fetch: count=$($linesInfo.count)"
        }
    }
}

# Step 7: Import today's real Geva lines into CC2026 (source='geva_manual' + a matched
# control) -- CC2026's own decider.py trades them from there via its normal pipeline.
# GevaExtract's own /api/trades/create + /api/submit-commands are deliberately NOT called
# here anymore -- that pipeline is blocked at broker.py Gate 0 (2026-09-09), so calling it
# only ever produced churn that got cancelled.
Log "Importing today's Geva lines into CC2026..."
$importResult = HttpPost "$CC_URL/api/geva/import-manual-lines" $null

if ($null -eq $importResult -or -not $importResult.ok) {
    $errMsg = if ($null -ne $importResult) { $importResult.error } else { "no response" }
    Log "IMPORT FAILED: $errMsg"
    exit 1
}

if ($importResult.skipped_reason) {
    Log "Import skipped: $($importResult.skipped_reason)"
} else {
    Log "Imported: real=$($importResult.real_inserted) control=$($importResult.control_inserted) restarted_decider=$($importResult.restarted_decider)"
}
Log "===== AUTO GEVA DONE OK ====="
exit 0
