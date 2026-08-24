# GevaExtract + CC2026 — Operations Manual

Full stack runbook: what's supposed to be running, how to check it, how to restart it,
and a log of incidents. Companion to [CLAUDE.md](CLAUDE.md) (which covers GevaExtract's own
code); this file covers the whole trading pipeline, including pieces that live outside
this repo. For bootstrapping this repo on a fresh machine, see
[RESTART_PROJECT.md](RESTART_PROJECT.md). For this repo's place alongside its sibling algo
projects (CC2026, Fetcher2026) from a higher-level coordinating session's point of view, see
[ORCHESTRATOR.md](ORCHESTRATOR.md).

---

## 1. System map

```
Facebook (Geva's group)
   │  extract.js (Playwright)
   ▼
geva.db  ──────────────────────────────────────────────┐
   │  trade-builder.js                                  │
   ▼                                                     │
GevaExtract server.js  ── :5005 ── dashboard + API       │  auto-geva-scheduled.ps1
   │  insert-commands.py (WAL-safe write)                │  (GevaAutoTrade scheduled task,
   ▼                                                      │   10:00 / 12:30 / 15:00 CT)
galao.db  (C:\Projects\CriticalCorallations2026\trader\data\galao.db)
   │
   ├── CC2026 broker.py    ──┐
   ├── CC2026 decider.py   ──┼── connect to IB Gateway :4002 (paper)
   └── CC2026 trading_dashboard.py ── :5003 (session status, used by both
                                             GevaExtract's status bar and the
                                             scheduler's health checks)

IB Gateway (via IBC, C:\IBC) ── :4002 PAPER / :4001 LIVE (not used)
```

Nothing here talks to IB directly except `broker.py` / `decider.py`. GevaExtract only
ever writes rows into `galao.db`; CC2026 owns execution.

---

## 2. Components — check / (re)start

### 2.1 GevaExtract server (port 5005)

```powershell
# Check
Invoke-WebRequest http://localhost:5005/api/prices -UseBasicParsing

# Restart
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "C:\Program Files\nodejs\node.exe" -ArgumentList "server.js" `
    -WorkingDirectory "C:\Projects\GevaExtract" -WindowStyle Hidden
```

### 2.2 CC2026 dashboard + broker + decider (port 5003)

```powershell
# Check
Invoke-WebRequest http://localhost:5003/api/session/status -UseBasicParsing
# → {"broker":"running","decider":"running","uptime_seconds":...}

# Start dashboard (spawns broker/decider itself once session is started)
Start-Process python -ArgumentList "back-trading/trading_dashboard.py" `
    -WorkingDirectory "C:\Projects\CriticalCorallations2026" -WindowStyle Hidden

# Start the broker/decider session (once dashboard is up)
Invoke-WebRequest -Method POST http://localhost:5003/api/session/start -UseBasicParsing
```

`auto-geva-scheduled.ps1` already does both of the above automatically on every scheduled
run, so this is mainly for manual recovery mid-day.

### 2.3 IB Gateway (port 4002, paper account) — via IBC

**This is the fragile link.** Nothing broker.py/decider.py do can work while this is down;
orders just pile up as `PENDING` with `ib_order_id: null` forever.

```powershell
# Check: is anything listening/connected on 4002?
Get-NetTCPConnection -LocalPort 4002 -ErrorAction SilentlyContinue

# Start (same invocation as the "IBC (Gateway)" desktop shortcut — see §4 for why
# the exact arguments matter)
Start-Process -FilePath "C:\IBC\StartGateway.bat" -ArgumentList "/INLINE","/COLOR" `
    -WorkingDirectory "C:\IBC"
```

- Config: `C:\Users\galsh\Documents\IBC\config.ini` — `TradingMode=paper`, login `gavishoren`.
  (There is also a `configLive.ini` in the same folder — **not** the one `StartGateway.bat`
  uses by default. Do not point `StartGateway.bat` at it without explicit intent.)
- Login is normally silent (IBC auto-fills credentials from `config.ini`). If IBKR prompts
  for 2FA, it shows as an "Authenticating..." window and needs a manual approve on the
  IBKR Mobile app — nothing here can do that for you.
- Log file: `C:\IBC\Logs\IBC-3.24.0_GATEWAY-1048_<DAYOFWEEK>.txt` (one file per weekday,
  overwritten weekly). Success looks like a `PAPER 4002` window appearing and
  `addLogConsole Client <id>` lines as broker/decider attach.
- Gateway auto-restart time is configured for 10:30 PM (IBC setting, not something this
  repo controls).

### 2.4 GevaAutoTrade scheduled task

```powershell
Get-ScheduledTask -TaskName GevaAutoTrade | Get-ScheduledTaskInfo
```

Runs `auto-geva-scheduled.ps1` at 18:00 / 20:30 / 23:00 Israel time (= 10:00 / 12:30 / 15:00
CT). Steps: ensure GevaExtract up → ensure CC2026 up → ensure broker/decider running →
enable replenish → check/fetch today's lines → build all MES+MNQ brackets → submit. Logs to
`C:\Projects\GevaExtract\logs\auto-trade.log`.

It does **not** start IB Gateway itself — see §5.2.

---

## 3. Full health check (all components)

```powershell
Invoke-WebRequest http://localhost:5005/api/prices -UseBasicParsing | Out-Null; echo "GevaExtract OK"
Invoke-WebRequest http://localhost:5003/api/session/status -UseBasicParsing
Get-NetTCPConnection -LocalPort 4002 -ErrorAction SilentlyContinue
Get-Content C:\Projects\GevaExtract\logs\auto-trade.log -Tail 15
```

If `broker`/`decider` show `running` but port 4002 has no `Established` connections, IB
Gateway is down or was just restarted — broker/decider will keep retrying on their own
poll interval, no action needed once gateway comes back up.

---

## 4. Incident log

### 2026-08-17 (later same day) — full cross-project health check, all green except the stale-lines bug below

Ran the full §3 health check plus port/process verification across all three sibling
projects (CC2026, Fetcher2026, GevaExtract) and IB Gateway. Confirmed live:

- IB Gateway: up, 5 established connections on :4002.
- CC2026 dashboard (:5003) + broker/decider session: both `running`.
- GevaExtract server (:5005): responding.
- Fetcher2026 dashboard (:5050) and its separate bars-fetch pipeline (:5004): both up
  (the bars pipeline's `5s` stage was found stuck idle for ~19 days on a stale scheduler
  weight and was fixed — see `Fetcher2026\BARS1S_STATUS.md` §0n, not a GevaExtract issue).
- `GevaAutoTrade` scheduled task: `LastTaskResult=0`, next run on schedule.

**The "Open issue" below (stale `hasLines` check) is still live and unfixed** — confirmed
via `logs\auto-trade.log`: every scheduled run from 2026-08-15 through 2026-08-16 23:00
still reports `date=2026-08-13` and `passed=0`, i.e. the auto-trade pipeline has been
building candidate orders off 4-day-old Geva lines and submitting zero trades for going on
3 days, silently (task "succeeds" every time — 0 candidates isn't treated as a failure).
Not fixed here either — same reason as before, it changes live trading-decision logic and
the proposed fix needs explicit sign-off first.

### 2026-08-17 — IB Gateway down since ~2026-08-15, root-caused and fixed

**Symptom:** `broker.py` / `decider.py` reported `running`, but had zero established
connections on port 4002 (`SYN_SENT` only). Orders from 2026-08-15 were stuck at
`PENDING` with `ib_order_id: null`. No `java.exe` process existed at all — IB Gateway
had not started.

**Root cause:** `C:\IBC\scripts\StartIBC.bat` detects the installed Java version with:

```bat
pushd "%JAVA_PATH%"
for /f ... in (`java.exe -XshowSettings:properties 2^>^&1 ^| findstr /C:"java.version ="`) do set java_version=%%B
popd
```

This relies on `cmd.exe` resolving the bare name `java.exe` via the current directory.
On this machine's current Windows build, `cmd.exe` no longer searches the current
directory for a bare executable name at all (confirmed with an unrelated test binary,
not Java-specific — `NoDefaultCurrentDirectoryInExePath` isn't even set, so this is a
platform default change, not a registry policy). The `for /f` loop silently returned
nothing, `java_version` stayed empty, and the next line
(`if not "%java_version:1.8=%"=="%java_version%" ...`) then failed to parse
(`set was unexpected at this time`), aborting before Java Gateway ever launched. This
would have failed identically whether launched by automation or by double-clicking the
desktop shortcut — it was not specific to how the launch was triggered.

Using the fully-qualified path directly inside the same `for /f` (`"%JAVA_PATH%\java.exe"`)
was tried and also fails — a separate, pre-existing `for /f` + backtick-pipe + quoted-path
parsing bug (the original script author's own comment on that line already flags this).

**Fix applied** (`C:\IBC\scripts\StartIBC.bat`, the `java_version` detection block):
redirect `java.exe`'s output to a temp file using its full path (a plain redirect, not
inside a `for /f` backtick), then read the version out of the file with a separate
`for /f`:

```bat
"%JAVA_PATH%\java.exe" -XshowSettings:properties > "%TEMP%\ibc_java_version.txt" 2>&1
for /f "tokens=1,2 delims== usebackq" %%A in (`findstr /C:"java.version =" "%TEMP%\ibc_java_version.txt"`) do set java_version=%%B
del "%TEMP%\ibc_java_version.txt" >nul 2>&1
```

**Not version-controlled:** `C:\IBC` is not a git repository, so this fix lives only on
disk. If IBC is ever reinstalled/upgraded, this same patch will need to be reapplied
(look for the `java_version` detection block in `scripts\StartIBC.bat`, same fix as above).

**Verified:** launched via `StartGateway.bat /INLINE /COLOR` (same args as the working
desktop shortcut — a plain `Start-Process ... -ArgumentList "paper"` takes a different
code path inside `StartGateway.bat` that spawns a nested `start`, which is *also* broken
independent of the Java bug above; use `/INLINE /COLOR` for any future manual/automated
launch). Gateway logged in with no 2FA prompt, `PAPER 4002` window opened, 3 established
connections on port 4002 confirmed (broker, decider, and one more client).

### Issue found during this incident — FIXED 2026-08-23

`GET /api/today-lines` in `server.js` (~line 1156) used to set `hasLines = lines.length > 0` —
true if *any* row exists in `geva.db`, not specifically for today. `auto-geva-scheduled.ps1`
only fetched from Facebook when `hasLines` was false, so once at least one post had ever
been saved, the scheduler never re-fetched. Confirmed live on 2026-08-17: both the 06:00
daily scrape and a manual `/fetch` trigger still returned Geva's **2026-08-13** post — either
Geva hadn't posted in 4 days, or the scraper was matching a stale post; unconfirmed, needed
a human check of the Facebook group. Either way, the scheduler had been building/submitting
trades off 4-day-old S/R levels since 2026-08-15 (0 candidates passed the sanity filter
each run, so no bad orders went out — but this defeated the purpose of the daily fetch).

**Fix applied 2026-08-23** (signed off as part of a broader fix-all-known-bugs effort):
`hasLines` now treats lines as current only when the most-recent row's `date` equals
today (`server.js:1164`, `lines[0].date === today` — `getAllLines()` is already
`ORDER BY date DESC` so `lines[0]` is the newest row). `auto-geva-scheduled.ps1` still
only re-fetches from Facebook when `hasLines` is false, which now correctly means "no
same-day fetch yet" instead of "never ever fetched." Added the fallback the draft called
for: if a same-day fetch attempt is *attempted but fails* (network error, scrape failure,
or a successful fetch that parses no lines), the scheduler falls back to the latest stored
post (whatever date it is) rather than aborting outright, so trading isn't blocked just
because today's post hasn't landed yet (`auto-geva-scheduled.ps1`, around the Step 5/6
fetch block). Self-check: `check_haslines.js`.
