# GevaExtract — Galgo2027 Handoff Document
> Complete briefing for a fresh Claude instance. No prior context needed.
> Written: 2026-07-21 | Version at time of writing: v11 (server.js) / v9 (git log)

> **Superseded as of 2026-08-18.** The Galgo2027 consolidation this doc was written for
> never completed (`C:\Projects\side_projects\Galgo2027\` is incomplete/stale — see
> `CriticalCorallations2026\ORCHESTRATOR.md` §5 for the current status). For a fresh-instance
> briefing that reflects what's actually running today, use, in order: [CLAUDE.md](CLAUDE.md)
> (architecture + daily workflow), [OPERATIONS.md](OPERATIONS.md) (start/stop/health-check +
> incident history), [RESTART_PROJECT.md](RESTART_PROJECT.md) (fresh-machine bootstrap), and
> [ORCHESTRATOR.md](ORCHESTRATOR.md) (this repo's place alongside its siblings). Kept below
> for historical reference only.

---

## 1. PURPOSE

GevaExtract scrapes daily S&P 500 support/resistance levels from a private Hebrew Facebook group
(Geva's posts), parses them into structured price levels, builds bracket orders, and inserts them
as PENDING rows into `galao.db` — the shared database owned by CC2026's live broker/decider.

GevaExtract does **not** connect to IB directly. It only writes to the DB. The actual order
submission and fill tracking is done by CC2026's broker.py.

---

## 2. DISK LAYOUT

```
C:\Projects\GevaExtract\
  server.js              MAIN SERVER — all routes, HTML generation, API handlers
  extract.js             Playwright Facebook scraper (spawned as child process)
  trade-builder.js       Bracket order calculator (buildOrdersForLevel, BRACKETS)
  galao-db.js            Read-only sql.js access to galao.db
  price-feed.js          Yahoo Finance poller (MES=F, MNQ=F, 30s interval)
  insert-commands.py     WAL-safe Python write bridge for galao.db (ALWAYS use this for writes)
  db.js                  Local SQLite (geva.db) — scraped posts and parsed lines
  version.json           {"v": 11} — bump on every release
  package.json           Node.js dependencies (playwright, sql.js)
  fb-profile/            Playwright persistent browser profile (Facebook session state)
  output/                JSON + TXT daily scrape archives (historical record)
  logs/                  Playwright scraper logs
  run-daily.bat          Batch launcher (scheduled via Task Scheduler)
  setup-scheduler.bat    Task Scheduler setup helper (one-time)

Shared DB (read + write):
  C:\Projects\CriticalCorallations2026\trader\data\galao.db   (WAL mode)

Local DB:
  C:\Projects\GevaExtract\geva.db                              (local SQLite)
```

---

## 3. RUNTIME

| Component | Runtime | Version |
|-----------|---------|---------|
| server.js, extract.js, trade-builder.js, etc. | Node.js | v24 |
| insert-commands.py | Python | 3.11 |
| Chromium browser | Playwright (bundled) | auto |

```
Node path:    C:\Program Files\nodejs\node.exe
Python path:  C:\Users\galsh\AppData\Local\Programs\Python\Python311\python.exe
Port:         5005
Start:        node server.js   (from C:\Projects\GevaExtract)
```

---

## 4. API ENDPOINTS

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/` | Serve full HTML app |
| POST | `/fetch` | Spawn extract.js, scrape Facebook, save to geva.db |
| GET | `/api/prices` | `{MES:{price,ts}, MNQ:{price,ts}}` from Yahoo Finance cache |
| POST | `/api/trades/create` | Build bracket candidates from latest lines + live prices |
| POST | `/api/submit-commands` | Write selected commands to galao.db via Python bridge |
| GET | `/api/submitted` | Read geva_extract commands from galao.db |
| GET | `/api/pnl` | Full P&L snapshot: open, closed, counts, prices, session status |
| POST | `/api/replenish` | Set REPLENISH_ENABLED in galao.db system_state |
| POST | `/api/cancel-all` | Cancel PENDING/SUBMITTING/SUBMITTED geva_extract rows in DB + reqGlobalCancel |

**Session status** (cross-project): GevaExtract polls `http://localhost:5003/api/session/status`
every 15s to show broker/decider liveness in its status bar.

---

## 5. DATA FLOW

```
Facebook group (private, Hebrew)
       ↓ extract.js (Playwright Chromium, fb-profile/ session)
   geva.db  (local — posts + parsed lines)
       ↓ buildOrdersForLevel() in trade-builder.js
   Bracket candidates (32 per S/R level × N lines)
       ↓ sanity filter: |entry - market| ≥ 4 ticks (1.0 pt)
   Filtered candidates shown in Trades tab
       ↓ user selects + clicks Submit  (or Auto GO button)
   insert-commands.py → galao.db.commands (PENDING, source='geva_extract')
       ↓ CC2026's broker.py polls PENDING rows every 5s
   IB Paper (port 4002) — orders submitted, filled, TP/SL managed by broker
       ↓ galao.db updated by broker (FILLED, CLOSED, pnl_points, etc.)
   GevaExtract Monitor/Auto tabs read galao.db — show live P&L
```

---

## 6. FACEBOOK SCRAPER (extract.js)

- **Group URL:** `https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY`
- **Session:** Playwright Chromium with persistent profile (`fb-profile/`) — login preserved across runs
- **Scroll depth:** Up to 40 scrolls (2800ms pause each) to find today's post
- **Date detection:** Hebrew weekday name in post TEXT (not DOM metadata — Facebook metadata is unreliable)
- **Parsing:** Hebrew keywords:
  - `קווי תמיכה` → support lines
  - `קווי התנגדות` → resistance lines
  - `!` = strong (strength 1), blank = normal (strength 2), `?` = weak (strength 3)
- **Output:** raw post + parsed levels saved to geva.db; also JSON/TXT in output/

**Re-authentication (when Facebook logs out):**
```
node save-auth.js    # manual one-time — opens browser, log in, saves fb-profile/
```

---

## 7. BRACKET ORDER BUILDER (trade-builder.js)

### Toggle rule (matches CC2026's order_builder.py exactly)
```
current_price >= line_price:
  BUY  = LMT at linePrice        (wait for pullback)
  SELL = STP at linePrice        (break above)
current_price < line_price:
  BUY  = STP at linePrice + 0.25 (break above)
  SELL = LMT at linePrice        (wait for rally)
```

### Entry prices
- BUY LMT / SELL LMT: `entry = linePrice`
- BUY STP: `entry = linePrice + 0.25` (1 tick above)
- SELL STP: `entry = linePrice - 0.25` (1 tick below)

### Bracket sizes (8 combinations)
```
b4      TP=4t   SL=4t       (1 pt / 1 pt)
b8      TP=8t   SL=8t       (2 pt / 2 pt)
b16     TP=16t  SL=16t      (4 pt / 4 pt)
b32     TP=32t  SL=32t      (8 pt / 8 pt)
b4/16   TP=4t   SL=16t      (tight TP, wide SL)
b16/4   TP=16t  SL=4t       (wide TP, tight SL)
b8/32   TP=8t   SL=32t
b32/8   TP=32t  SL=8t
```
(1 tick = 0.25 points)

### Symbols
- MES (multiplier $5/pt)
- MNQ (multiplier $2/pt) — line price proportionally scaled from MES using live ratio

### Sanity filter (v11)
`|entry_price - current_price| >= 4 × 0.25` — drops any order within 1 point of market.
If ALL of a day's Geva levels are within 1 pt of current price → 0 candidates shown.

**Per S/R level: 32 commands** (8 brackets × 2 directions × 2 symbols)

---

## 8. GALAO.DB ACCESS

**Read (galao-db.js):** sql.js loads entire file into memory — pure JS, never writes. Safe with WAL.

**Write (insert-commands.py):** Python subprocess with `sqlite3`, WAL-aware, 10s timeout.
ALWAYS use this for writes — never open galao.db as writeable from Node.js.

```python
# Insert PENDING commands (stdin JSON)
python insert-commands.py < commands.json

# Upsert system_state
python insert-commands.py --state KEY VALUE

# Cancel all geva_extract PENDING/SUBMITTING/SUBMITTED
python insert-commands.py --cancel
```

### galao.db tables used by GevaExtract
| Table | Access | Purpose |
|-------|--------|---------|
| `commands` | read+write | Orders: PENDING→SUBMITTED→FILLED→CLOSED |
| `system_state` | read+write | REPLENISH_ENABLED toggle |
| `prices` | read | Last IB prices (populated by CC2026 broker) |
| `verified_trades` (view) | read | Closed trades for P&L display |

---

## 9. GUI — TABS AND FUNCTIONALITY

Browser: `http://localhost:5005`

### Global Status Bar (always visible, polls every 15s)
```
MES [price]  MNQ [price]  Pending [n]  Submitted [n]  Filled [n]  Closed today [n]  P&L [$]  Replenish [ON/OFF]  Broker [status]
```
Color-coded: green = running, red = dead/error.

### Header
- Title: `Geva S/R v{VERSION}`
- Live MES + MNQ prices from Yahoo Finance (delayed ~15 min during hours, last-close after hours)
- `↓ Fetch` button — triggers Facebook scrape with full-screen loading overlay
- 🔗 Cross-dashboard menu: CC2026 (5003), Fetcher2026 (5050), GevaExtract (5005)
  - Uses `location.hostname` — works from localhost/LAN/Tailscale

### Tab: Posts
Scraped Facebook posts — date, day, raw support text, raw resistance text. Newest first.

### Tab: Lines
Parsed S/R levels grouped by date. Support chips (green), resistance chips (red).
Strength markers: `!` = strong, `?` = weak, `*` = other.

### Tab: Trades
1. Filter bar: symbol checkboxes (MES/MNQ), bracket checkboxes (8 types), min strength (1–3)
2. "Create Trades" → calls `/api/trades/create` → candidate table with preview entry/TP/SL
3. Per-row checkboxes + "Select All"
4. "Submit N" → calls `/api/submit-commands` → writes to galao.db

### Tab: Submitted
All geva_extract commands from galao.db (all statuses).
Color-coded status pills. Replenish toggle. Auto-refresh toggle (every 5s).

### Tab: Monitor
Broker + Decider status badges. Replenish checkbox.
Open positions table with live unrealized P&L.
Closed-today table with realized P&L. Auto-refresh every 10s.

### Tab: ▶ Auto
- **▶ GO**: 4-step automatic flow — (1) Fetch from Facebook, (2) Build all orders MES+MNQ all
  brackets strength≥1, (3) Submit to broker, (4) Live monitor with 5s polling
- **⊠ Cancel All**: confirm dialog → cancel all geva_extract PENDING/SUBMITTING/SUBMITTED in DB
  + calls CC2026 cancel-all endpoint for IB reqGlobalCancel
- Step indicators: ○ idle → spinner → ✓ ok / ✗ error

---

## 10. SCHEDULER (Windows Task Scheduler)

| Task | Path | Trigger | Status |
|------|------|---------|--------|
| `\GevaExtract\DailyExtract` | `C:\Projects\GevaExtract\run-daily.bat` | Daily 09:00 | Ready |

Daily extract runs automatically at 09:00. Fetches today's Geva post from Facebook.

---

## 11. RULES AND INVARIANTS

1. **Never write galao.db from Node.js.** Always use `insert-commands.py` for writes. WAL safety.
2. **Yahoo Finance prices are delayed.** ~15 min delay during market hours. Not suitable for
   execution price — only used for bracket distance filter and display.
3. **Facebook session must be active.** If Facebook logs out the fb-profile/, run `node save-auth.js`
   to re-authenticate. Without this, extract.js fails silently.
4. **Sanity filter is mandatory.** 4-tick minimum from market prevents immediate fills on market orders.
5. **32 commands per level.** 8 brackets × 2 directions × 2 symbols. This is by design — user selects
   which subset to submit from the Trades tab.
6. **source='geva_extract'** on all DB inserts. CC2026's broker processes ALL PENDING rows regardless
   of source — but GevaExtract filters its own view by source for the Submitted/Monitor tabs.
7. **Cancel All sends reqGlobalCancel to CC2026.** It calls `localhost:5001/api/cancel-all` (CC2026
   legacy visualizer port). This is a known hardcoded dependency. In Galgo2027, route to the unified
   cancel endpoint instead.

---

## 12. KNOWN GOTCHAS

- **Template literal escape rule.** All browser JS inside `buildHtml()`'s backtick template needs
  double-backslash: `\n` → newline (breaks string), `\\n` → literal `\n`. Confirmed bugs in past:
  sessionStorage querySelector, fetchModal close button, cancelAll confirm string.

- **Early-click stub.** A small IIFE at top of `<body>` queues onclick calls that arrive before
  the main `<script>` at body-bottom parses. This exists because heavy DB rows delay script parsing.
  After main script loads, real function declarations overwrite the stubs. Don't remove this.

- **Yahoo Finance can go down.** If it does, `/api/prices` returns stale data and trade creation
  is blocked (price too old). Fallback: use CC2026's `prices` table in galao.db (from IB).

- **Cancel All hardcodes port 5001.** The CC2026 legacy visualizer at port 5001 is normally not
  running. The cancel-all flow will fail silently on the IB reqGlobalCancel part. The DB
  cancellation (via insert-commands.py --cancel) still works. Fix in Galgo2027.

- **MNQ price scaling.** MNQ line price = MES price × (live MNQ / live MES). If either price
  feed is stale, MNQ brackets are wrong. The 4-tick sanity filter may catch some cases.

- **version.json** must be bumped manually on every release. No automation for this.

---

## 13. PERMISSIONS (Claude Code settings)

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "allow": ["Bash(*)", "PowerShell(*)", "Write(*)", "Edit(*)"]
  }
}
```
**For Galgo2027: allow all, no confirmation prompts.**

---

## 14. GIT

```
Repo:    C:\Projects\GevaExtract
Remote:  origin → GitHub (push allowed)
Branch:  main
User:    Oren Gavish
```

---

## 15. WHAT TO ARCHIVE (DO NOT CARRY INTO GALGO2027 AS-IS)

| Item | Action |
|------|--------|
| `output/*.json`, `output/*.txt` | Archive as historical record — not needed in Galgo2027 runtime |
| `run-daily.bat`, `setup-scheduler.bat` | Replace with Galgo2027 unified scheduler |
| `geva_critical_lines_automation.md` | Old planning doc — delete |
| `GevaExtract as standalone project` | Merge into Galgo2027 |
| Hardcoded port 5001 in Cancel All | Fix: route to Galgo2027 unified cancel endpoint |

**Keep (port to Galgo2027):**
- `extract.js` — Facebook scraper logic, proven
- `trade-builder.js` — bracket builder algorithm
- `insert-commands.py` — WAL-safe write bridge (keep as-is)
- `price-feed.js` — Yahoo Finance poller (or replace with IB price from CC2026)
- `fb-profile/` — active Facebook session state (copy to new location)
- `geva.db` — historical scraped posts

---

## 16. FIT INTO GALGO2027

GevaExtract contributes these to Galgo2027:

1. **Facebook scraper** (`extract.js`) — call as subprocess or port to async module
2. **Bracket builder** (`trade-builder.js`) — core algorithm, language-agnostic
3. **Write bridge** (`insert-commands.py`) — keep as-is (WAL safety requires Python)
4. **Price feed** — replace Yahoo Finance with IB live prices already in galao.db `prices` table
5. **UI**: merge Posts/Lines/Trades/Submitted/Monitor/Auto tabs into Galgo2027 unified dashboard (port 5000)
6. **Cancel All** — route to Galgo2027's unified cancel endpoint (not the legacy port 5001)
7. **Daily scheduler** — replace Task Scheduler DailyExtract task with Galgo2027 supervisor

---

## 17. QUICK RESTART REFERENCE

```powershell
# Kill and restart GevaExtract
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "C:\Program Files\nodejs\node.exe" -ArgumentList "server.js" `
    -WorkingDirectory "C:\Projects\GevaExtract" -WindowStyle Hidden

# Check it's up
Invoke-WebRequest http://localhost:5005 -UseBasicParsing | Select -Expand StatusCode

# Syntax-check browser JS before release
$html = (Invoke-WebRequest http://localhost:5005 -UseBasicParsing).Content
$s = ([regex]::Matches($html,'(?s)<script>(.*?)</script>'))[1].Groups[1].Value
$s | Out-File $env:TEMP\ge_check.js -Encoding utf8
& "C:\Program Files\nodejs\node.exe" --check $env:TEMP\ge_check.js

# Re-authenticate Facebook
cd C:\Projects\GevaExtract
node save-auth.js

# Manual daily fetch
Invoke-WebRequest -Method POST http://localhost:5005/fetch -UseBasicParsing
```
