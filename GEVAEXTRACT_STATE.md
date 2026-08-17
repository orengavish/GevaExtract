# GevaExtract — Complete State Document
**Version**: v11 | **Port**: 5005 | **Runtime**: Node.js v24 | **Date**: 2026-07-21
**Git**: `C:\Projects\GevaExtract` — branch `main` — remote: GitHub (push allowed)
**Claude permissions**: allow all (no sandbox, no confirm prompts)

---

## 1. PURPOSE

GevaExtract scrapes Geva's daily S&P 500 support/resistance levels from a private Facebook group, parses them into structured price levels, builds bracket orders, and inserts them as PENDING rows into `galao.db` — the shared database owned by CriticalCorallations2026's live broker/decider. GevaExtract itself does **not** talk to IB directly; it only writes to the DB.

---

## 2. DISK LAYOUT

```
C:\Projects\GevaExtract\
  server.js              Main HTTP server — all routes, HTML generation, API handlers
  extract.js             Playwright Facebook scraper (spawned as child process)
  trade-builder.js       Bracket order calculator — buildOrdersForLevel(), BRACKETS
  galao-db.js            Read-only sql.js access to galao.db
  price-feed.js          Yahoo Finance poller (MES=F, MNQ=F, 30s interval)
  insert-commands.py     WAL-safe Python write bridge for galao.db
  db.js                  Local SQLite (geva.db) — stores scraped posts and parsed lines
  version.json           {"v": 11}  — bump on every release
  fb-profile/            Playwright persistent browser profile (Facebook login state)
  output/                JSON + TXT daily scraped files (archive)
  logs/                  Playwright scraper logs

Shared DB (read + write):
  C:\Projects\CriticalCorallations2026\trader\data\galao.db   (WAL mode)

Local DB:
  C:\Projects\GevaExtract\geva.db                              (local SQLite)
```

---

## 3. RUNTIME DEPENDENCIES

| Package      | Purpose                              |
|-------------|--------------------------------------|
| playwright   | Headless Chromium — Facebook scrape |
| sql.js       | Pure-JS SQLite — galao.db read-only  |
| (built-in)   | http, fs, path, child_process, crypto|
| python 3.x   | insert-commands.py write bridge      |

Start server: `node server.js` (runs on port 5005, auto-starts price poller)
Facebook login: `node save-auth.js` (one-time, saves to fb-profile/)

---

## 4. API ENDPOINTS

| Method | URL                     | Description                                               |
|--------|-------------------------|-----------------------------------------------------------|
| POST   | `/fetch`                | Spawns extract.js, scrapes Facebook, saves to geva.db     |
| GET    | `/api/prices`           | Returns `{MES:{price,ts}, MNQ:{price,ts}}` from cache    |
| POST   | `/api/trades/create`    | Builds bracket candidates from latest lines + live prices |
| POST   | `/api/submit-commands`  | Writes selected commands to galao.db via Python bridge    |
| GET    | `/api/submitted`        | Reads geva_extract commands from galao.db                 |
| GET    | `/api/pnl`              | Full P&L snapshot: open, closed, counts, prices, session  |
| POST   | `/api/replenish`        | Sets REPLENISH_ENABLED in galao.db system_state           |
| POST   | `/api/cancel-all`       | Cancels PENDING/SUBMITTING/SUBMITTED geva_extract rows in DB; also calls CC2026 visualizer port 5001 reqGlobalCancel |

**Session status**: GevaExtract polls `http://localhost:5003/api/session/status` (CC2026 trading dashboard) every 15 s to show broker/decider liveness.

---

## 5. DATA FLOW

```
Facebook group (private, Hebrew)
       ↓ Playwright (extract.js, fb-profile/ session)
   geva.db  (local)
       ↓ buildOrdersForLevel() in trade-builder.js
   Bracket candidates (32 per S/R level × N lines)
       ↓ sanity filter: entry ≥ 4 ticks from market
   Filtered candidates shown in Trades tab
       ↓ user selects + clicks Submit (or Auto GO)
   insert-commands.py → galao.db commands table (PENDING, source='geva_extract')
       ↓ CC2026 broker picks up PENDING rows
   IB PAPER (port 4002) — orders submitted, filled, TP/SL managed
       ↓ galao.db updated by broker (FILLED, CLOSED, pnl_points, etc.)
   GevaExtract Monitor/Auto tabs read galao.db and display live P&L
```

---

## 6. FACEBOOK SCRAPER (extract.js)

- Group URL: `https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY`
- Uses Playwright Chromium with persistent profile (`fb-profile/`) — Facebook login is preserved across runs
- Scrolls up to 40 times (2800 ms pause each) looking for today's Geva post
- Detects date from **Hebrew weekday name in post text** (not DOM metadata — Facebook date metadata is unreliable)
- Parses support lines (`קווי תמיכה`) and resistance lines (`קווי התנגדות`) from post text
- Saves raw post + parsed levels to geva.db
- Strength indicators: `!` = strong (1), blank = normal (2), `?` = weak (3)
- Line types: `sup` → `SUPPORT`, `res` → `RESISTANCE` in galao.db

---

## 7. BRACKET ORDER BUILDER (trade-builder.js)

**Toggle rule** (matches CC2026's order_builder.py):
- `current >= line` → BUY = LMT (wait for pullback), SELL = STP (break above)
- `current < line`  → BUY = STP (break above line), SELL = LMT (wait for rally)

**Entry prices**:
- BUY LMT / SELL LMT: `entry = linePrice`
- BUY STP: `entry = linePrice + 0.25` (1 tick above)
- SELL STP: `entry = linePrice - 0.25` (1 tick below)

**Brackets** (8 combinations, user-selectable):
```
b4     TP=4t   SL=4t
b8     TP=8t   SL=8t
b16    TP=16t  SL=16t
b32    TP=32t  SL=32t
b4/16  TP=4t   SL=16t
b16/4  TP=16t  SL=4t
b8/32  TP=8t   SL=32t
b32/8  TP=32t  SL=8t
```
(1 tick = 0.25 points)

**Symbols**: MES (multiplier $5/pt), MNQ (multiplier $2/pt)
MNQ line price is proportionally scaled from MES line price using live ratio.

**Sanity filter** (added v11): `|entry_price - current_price| >= 4 * 0.25` — drops any order within 1 point of market to prevent immediate fills.

Per S/R level: **32 commands** (8 brackets × 2 directions × 2 symbols).

---

## 8. GALAO.DB ACCESS

**Read** (galao-db.js): sql.js loads the file into memory, never writes. Safe with WAL mode.
**Write** (insert-commands.py): Python subprocess with `sqlite3`, WAL-aware, 10s timeout.

```python
# insert modes:
python insert-commands.py < commands.json          # bulk insert PENDING commands
python insert-commands.py --state KEY VALUE        # upsert system_state
python insert-commands.py --cancel                 # mark geva_extract PENDING/SUBMITTING/SUBMITTED → CANCELLED
```

**galao.db tables used**:
- `commands` — trading orders (PENDING/SUBMITTING/SUBMITTED/FILLED/EXITING/CLOSED/CANCELLED/ERROR)
- `system_state` — key/value config (REPLENISH_ENABLED)
- `prices` — last known IB prices per symbol (populated by CC2026 broker)

---

## 9. GUI — TABS AND FUNCTIONALITY

Browser: `http://localhost:5005`

### Global Status Bar (always visible)
`MES [price]  MNQ [price]  Pending [n]  Submitted [n]  Filled [n]  Closed today [n]  P&L [$]  Replenish [ON/OFF]  Broker [status]`
Polls `/api/pnl` every 15 s. Color-coded: green=running, red=dead/error.

### Header
- Title: `Geva S/R v{VERSION}`
- Live price display (MES + MNQ from Yahoo Finance)
- `↓ Fetch` button — triggers Facebook scrape with full-screen loading overlay
- Cross-dashboard menu (🔗): CC2026 Dashboard (5003), Fetcher2026 (5050), GevaExtract (5005)

### Tab: Posts
Table of scraped Facebook posts — date, day, raw support text, raw resistance text, source.
Newest first.

### Tab: Lines
Parsed S/R levels grouped by date. Support chips (green) and resistance chips (red).
Strength markers: `!`=strong, `?`=weak, `*`=other.

### Tab: Trades
1. Filter bar: symbol checkboxes (MES/MNQ), bracket checkboxes (8 types), min strength (1–3)
2. "Create Trades" button → calls `/api/trades/create` → shows candidate table with preview of entry/TP/SL
3. Per-row checkboxes + "Select All"
4. "Submit N" button → calls `/api/submit-commands` → writes to galao.db

### Tab: Submitted
Table of all geva_extract commands from galao.db (all statuses).
Color-coded status pills. Replenish toggle checkbox.
Auto-refresh toggle (every 5 s).

### Tab: Monitor
Broker + Decider status badges. Replenish checkbox.
Open positions table with live unrealized P&L.
Closed-today table with realized P&L.
Auto-refresh every 10 s.

### Tab: ▶ Auto
Two buttons:
- **▶ GO**: 4-step automatic flow — (1) Fetch from Facebook, (2) Build all orders MES+MNQ all brackets strength≥1, (3) Submit to broker, (4) Live monitor with 5 s polling
- **⊠ Cancel All**: confirm dialog → cancels all geva_extract PENDING/SUBMITTING/SUBMITTED in DB + calls CC2026 visualizer cancel-all for IB reqGlobalCancel

Step indicators: ○ idle → spinner → ✓ ok / ✗ error

---

## 10. CC2026 INTEGRATION POINTS

| CC2026 endpoint/resource         | Used by GevaExtract for                        |
|----------------------------------|------------------------------------------------|
| `galao.db` (WAL SQLite)          | Read orders/P&L, write PENDING commands        |
| `localhost:5003/api/session/status` | Broker/Decider liveness in status bar       |
| `localhost:5001/api/cancel-all`  | IB reqGlobalCancel + full DB cancel            |
| IB ports: 4001 LIVE, 4002 PAPER  | GevaExtract does NOT connect — CC2026 owns IB  |

---

## 11. KNOWN ISSUES / GOTCHAS

1. **Template literal escape rule**: All JS meant for the browser inside `buildHtml()`'s backtick template must use double-backslash for any intended escape. `\n` → newline (breaks string), `\\n` → literal `\n`. `\'` → `'` (breaks string), `\\'` → `\'`. Confirmed bugs fixed: sessionStorage querySelector, fetchModal close button, cancelAll confirm string.

2. **Early-click stub**: A small IIFE at top of `<body>` queues onclick calls that arrive before the main `<script>` at body-bottom parses. After main script loads, function declarations overwrite the stubs. This exists because page content (many DB rows) delays script parsing.

3. **Sanity filter drops orders near market**: 4-tick minimum. If all of a day's Geva levels are within 1 pt of current price, you'll get 0 candidates.

4. **Price feed is Yahoo Finance** (delayed ~15 min during market hours, last-close after hours). If Yahoo is down, trade creation is blocked.

5. **Facebook scraper needs active session**: If Facebook logs out the profile, `node save-auth.js` must be run manually to re-authenticate.

6. **galao.db WAL**: Never open galao.db with a write-capable SQLite connection from Node.js. Always use insert-commands.py for writes.

---

## 12. WHAT TO ARCHIVE (pre-Galgo2027)

| Item                        | Reason                                              |
|-----------------------------|-----------------------------------------------------|
| `output/*.json`, `output/*.txt` | Historical scrapes — keep for record, not needed in new system |
| `backfill.js`, `migrate.js`, `to-csv.js`, `debug.js` | One-time utility scripts |
| `run-daily.bat`, `setup-scheduler.bat` | Windows Task Scheduler approach — replaced by unified runner |
| `geva_critical_lines_automation.md` | Old planning doc — superseded by this file |
| GevaExtract as standalone project | Merge scraper + UI into Galgo2027 |

Keep: `extract.js` logic, `trade-builder.js`, `insert-commands.py`, `fb-profile/`

---

## 13. FIT INTO GALGO2027

GevaExtract contributes these components to Galgo2027:

1. **Facebook scraper** (`extract.js`) — unchanged, call as subprocess or port to async module
2. **Bracket order builder** (`trade-builder.js`) — core algorithm, language-agnostic, port or import
3. **galao.db write bridge** (`insert-commands.py`) — keep as-is (WAL safety requires Python)
4. **Price feed** (`price-feed.js`) — Yahoo Finance poller, consider replacing with IB live feed from CC2026
5. **UI concepts**: status bar, tabs, Auto flow, Cancel All — merge into Galgo2027 unified dashboard

Galgo2027 should own galao.db (or its successor) and expose a single unified UI port (suggest 5000) replacing 5003 + 5005 + 5050.

---

## 14. PERMISSIONS AND CONFIG

```
Claude permissions:  allow all — no sandbox, no human-in-loop confirmation needed
Node.js path:        C:\Program Files\nodejs\node.exe
Python path:         C:\Users\galsh\AppData\Local\Programs\Python\Python311\python.exe (or `python` on PATH)
Port:                5005
Start command:       cd C:\Projects\GevaExtract && node server.js
Git remote:          origin (GitHub) — push allowed, branch: main
OS:                  Windows 11 Home 10.0.26200
Shell:               PowerShell primary, Bash (Git Bash) also available
```

---

## 15. QUICK REFERENCE — RESTART

```powershell
# Kill and restart GevaExtract
Get-Process -Name node | Stop-Process -Force
Start-Process "C:\Program Files\nodejs\node.exe" -ArgumentList "server.js" -WorkingDirectory "C:\Projects\GevaExtract" -WindowStyle Hidden

# Check it's up
Invoke-WebRequest http://localhost:5005 -UseBasicParsing | Select -Expand StatusCode

# Syntax-check browser JS before release
$html = (Invoke-WebRequest http://localhost:5005 -UseBasicParsing).Content
$s = ([regex]::Matches($html,'(?s)<script>(.*?)</script>'))[1].Groups[1].Value
$s | Out-File $env:TEMP\ge_check.js -Encoding utf8
& "C:\Program Files\nodejs\node.exe" --check $env:TEMP\ge_check.js
```
