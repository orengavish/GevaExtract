# RESTART_PROJECT — Bootstrapping GevaExtract on a Fresh PC

> **Canonical whole-ecosystem version:** `CriticalCorallations2026\RESTART_PROJECT.md` covers
> all three sibling repos (CC2026, Fetcher2026, GevaExtract) plus the shared IB Gateway in one
> place, and is kept in sync as the source of truth for cross-project setup steps (IBC
> install, `config.ini`, Task Scheduler principal, the `StartIBC.bat` Java-detection fix).
> **This file is the GevaExtract-scoped subset** — follow it standalone if the rest of the
> stack (CC2026, Fetcher2026, IB Gateway/IBC) already exists on the target machine and you
> only need GevaExtract itself working; otherwise start from CC2026's doc and use this one
> for the GevaExtract-specific detail it doesn't repeat.

---

## 0. What GevaExtract needs to run

| Need | Source | In git? |
|---|---|---|
| Node.js (LTS) | https://nodejs.org | — (system install) |
| This repo | `git clone https://github.com/orengavish/GevaExtract` | — |
| npm packages (`sql.js`, `playwright`) | `npm install` | `package.json`/`package-lock.json` yes |
| Chromium browser | `npx playwright install chromium` | no (downloaded binary) |
| Python 3.11 | https://www.python.org/downloads/release/python-3119/ | — (system install) |
| A **shared, already-running** `galao.db` at `C:\Projects\CriticalCorallations2026\trader\data\galao.db` | CriticalCorallations2026 repo | that repo's own concern |
| A **shared, already-running** IB Gateway on port 4002 (via IBC, `C:\IBC`) | see CC2026's `RESTART_PROJECT.md` §5 | outside all repos |
| Facebook session (`fb-profile/`) | `node save-auth.js` (manual, interactive) | **no — gitignored** |
| `geva.db` (local scraped-post history) | copy from old machine, or rebuild via `backfill.js` | **no — not committed** |

GevaExtract does **not** need its own Python virtualenv for trading — `insert-commands.py`
only needs the stdlib `sqlite3` module (built into any Python 3.11 install), not `ib-insync`
or any of CC2026/Fetcher2026's heavier dependencies. The `requirements.txt` in this repo
(`ib_insync>=0.9.70`) is a leftover from an earlier design and is not actually imported by
anything currently in this repo — don't spend time installing it unless something changes
that.

---

## 1. Install prerequisites

```powershell
# Node.js: download LTS installer from nodejs.org, then verify
node --version

# Python 3.11: download from the link above, check "Add Python to PATH" during install
python --version   # should show 3.11.x

# Git: https://git-scm.com/download/win, accept defaults
git --version
```

---

## 2. Clone and install

```powershell
git clone https://github.com/orengavish/GevaExtract.git C:\Projects\GevaExtract
cd C:\Projects\GevaExtract
npm install
npx playwright install chromium
```

**Path matters.** `galao-db.js` and `insert-commands.py` hardcode
`C:\Projects\CriticalCorallations2026\trader\data\galao.db` as an absolute path, and the
dashboard's cross-dashboard 🔗 menu and `/api/cancel-all` hardcode `localhost` URLs for CC2026
(`:5003`) and its legacy visualizer (`:5001`). Clone GevaExtract itself anywhere you like, but
CriticalCorallations2026 must be at exactly `C:\Projects\CriticalCorallations2026` unless
you're prepared to grep-and-fix these paths (see `galao-db.js`, `insert-commands.py`,
`server.js`).

---

## 3. Facebook session (required before any scrape works)

```powershell
node save-auth.js
```

This opens a real (non-headless) Chromium window. Log into Facebook manually, navigate to
where you can see the Geva group, then close the window — the session persists to
`fb-profile/` (gitignored, machine-specific). Every scrape (`extract.js`, `/fetch`,
`auto-geva-scheduled.ps1`) depends on this being valid; if Facebook logs it out, redo this
step.

---

## 4. Local data — `geva.db`

Not in git. Two options:

- **Migrating from an existing machine**: copy `geva.db` directly into
  `C:\Projects\GevaExtract\`.
- **Starting fresh**: `extract.js` creates the DB automatically on first run (`node
  extract.js` or a `/fetch` call). To seed it with history without touching Facebook at all,
  run `node migrate.js` first — it imports the 12 `output/Geva_2026-07-*.{json,txt}` files
  that **are** committed to this repo. For anything further back, `node backfill.js` pulls
  history via Facebook's in-group search (slower, needs the FB session from step 3).

`output/geva_lines.csv` (the latest CSV export) **is** committed, but it's a snapshot, not a
substitute for the actual DB.

---

## 5. Verify the shared dependencies are reachable

GevaExtract itself doesn't start IB Gateway or CC2026 — it expects them already running (see
CC2026's `RESTART_PROJECT.md` for full setup of those). Before starting GevaExtract, confirm:

```powershell
Get-NetTCPConnection -LocalPort 4002 -State Listen -ErrorAction SilentlyContinue   # IB Gateway
Invoke-WebRequest http://localhost:5003/api/session/status -UseBasicParsing        # CC2026
Test-Path "C:\Projects\CriticalCorallations2026\trader\data\galao.db"              # shared DB file exists
```

If any of these are missing, GevaExtract will still start and serve its dashboard, but
`/api/trades/create`, `/api/submit-commands`, `/api/pnl`, and the status bar will
error/show-dead until they're up.

---

## 6. Start GevaExtract

```powershell
cd C:\Projects\GevaExtract
node server.js
```

Verify: `Invoke-WebRequest http://localhost:5005/api/prices -UseBasicParsing`, then open
http://localhost:5005 in a browser.

---

## 7. Windows Task Scheduler (daily automation)

Two tasks, both documented working as of 2026-08-18 (see
`CriticalCorallations2026\RESTART_PROJECT.md` §7 for the full cross-project task inventory):

```powershell
# Daily 09:00 Facebook scrape (extract.js + to-csv.js via run-daily.bat) — this one is
# created by setup-scheduler.bat, which does exactly this:
schtasks /Create /TN "GevaExtract\DailyExtract" /TR "C:\Projects\GevaExtract\run-daily.bat" `
    /SC DAILY /ST 09:00 /RU "%USERNAME%" /RL HIGHEST /F
```

```powershell
# Full auto-trade flow, 3x/day (10:00 / 12:30 / 15:00 CT = 18:00 / 20:30 / 23:00 IL).
# GevaAutoTrade is NOT created by any script in this repo — it was registered by hand and
# must be recreated the same way on a new machine. As the INTERACTIVE user, not SYSTEM
# (see ORCHESTRATOR.md golden rule #7 cross-ref: a SYSTEM-context task can't see the
# interactive user's IBC config.ini and will thrash IB Gateway trying and failing to
# restart it — this is the exact bug that caused Fetcher2026's 19-day outage).
$action  = New-ScheduledTaskAction -Execute "PowerShell.exe" `
    -Argument '-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Projects\GevaExtract\auto-geva-scheduled.ps1"'
$trigger = @(
    New-ScheduledTaskTrigger -Daily -At 18:00
    New-ScheduledTaskTrigger -Daily -At 20:30
    New-ScheduledTaskTrigger -Daily -At 23:00
)
Register-ScheduledTask -TaskName "GevaAutoTrade" -Action $action -Trigger $trigger `
    -User "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest
```

`setup-scheduler.bat` only creates `DailyExtract` — it predates `GevaAutoTrade` and doesn't
need changes for the second task above.

---

## 8. Smoke-test

```powershell
Invoke-WebRequest http://localhost:5005/api/prices -UseBasicParsing
Invoke-WebRequest http://localhost:5005/api/today-lines -UseBasicParsing
Invoke-WebRequest -Method POST http://localhost:5005/fetch -UseBasicParsing   # live Facebook scrape, ~10-30s
```

Full day-to-day health check (this repo plus its dependencies): `OPERATIONS.md` §3.

---

## 9. Gotchas found while writing this doc

- `server.js` spawns the Python write-bridge with a bare `python` on PATH (no full
  interpreter path), 10s timeout — the same class of footgun documented ecosystem-wide in
  `CriticalCorallations2026\ORCHESTRATOR.md` golden rule #4. If `python` resolves to the
  Windows Store stub or an unrelated interpreter on a fresh machine, `/api/submit-commands`
  and the replenish/cancel-all endpoints fail (usually silently-ish, via the JSON-parse
  fallback). Make sure a real Python 3.11 is first on PATH before relying on this.
- All four Playwright scripts (`extract.js`, `backfill.js`, `save-auth.js`, `debug.js`)
  launch a **headed** (non-headless) browser — no headless flag exists anywhere. Any
  scheduled task that runs them needs to run in an interactive/logged-on session, not a
  headless service context.
- `requirements.txt` (`ib_insync>=0.9.70`) is vestigial — nothing in this repo imports it.
  `insert-commands.py` only needs the Python stdlib. Don't spend setup time on it.
- `geva.db` was historically untracked *and not gitignored* (showed as a permanent `??` in
  `git status`) — now added to `.gitignore` explicitly to make the "not committed" design
  intentional rather than an accident waiting to `git add -A` someone's local scrape history.

---

## Summary checklist

- [ ] Node.js + Python 3.11 + Git installed
- [ ] `git clone` to `C:\Projects\GevaExtract`
- [ ] `npm install` + `npx playwright install chromium`
- [ ] `node save-auth.js` — Facebook session created
- [ ] `geva.db` restored or rebuilding via `backfill.js`
- [ ] CriticalCorallations2026 cloned at `C:\Projects\CriticalCorallations2026` and its own
      `RESTART_PROJECT.md` followed (IBC/Gateway, `galao.db`, dashboard/broker/decider)
- [ ] `node server.js` running, http://localhost:5005 responding
- [ ] `GevaExtract\DailyExtract` and `GevaAutoTrade` scheduled tasks installed as the
      interactive user
- [ ] Smoke-test passed
