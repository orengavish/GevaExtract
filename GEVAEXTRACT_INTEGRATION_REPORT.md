# GevaExtract — Integration/Inventory Report

> Written for a future "larger trading platform" rebuild. **Investigation only — no code
> was changed to produce this report.** Every claim below is traced to a real file/function;
> where something is inferred rather than directly observed, it's marked as such.
> Companion doc: `GEVAEXTRACT_INTEGRATION_REPORT` in the sibling `CriticalCorallations2026`
> repo covers the execution/algorithm side (`CORRELATIONCRITICAL_INTEGRATION_REPORT.md`).

---

## 1. Executive summary

GevaExtract is a small, single-purpose Node.js service. It does exactly one novel thing well:
scrape a specific person's (Geva's) daily Hebrew-language support/resistance post from a
private Facebook group, turn that free text into structured numeric price levels, and hand
those levels off. Everything past that point (bracket-order math, a local dashboard, and a
write-bridge into a shared trading database) is comparatively simple, mechanical code built
on top of the scrape.

**The valuable, hard-to-reproduce part is narrow and well-isolated**: `extract.js` +
`backfill.js` (Facebook scraping) and `parse-lines.js` (Hebrew text → price levels). This
code has survived real anti-scraping friction (invisible Unicode injection, unreliable
timestamp metadata, DOM structure that requires multi-selector fallback) and should be
preserved close to as-is. The rest — the Express-less raw-`http` dashboard server, the
bracket-order calculator, the galao.db write bridge — is straightforward and easy to either
keep, wrap, or reimplement, in that order of preference.

**GevaExtract has no execution/broker logic of its own.** It is a data producer and an order
*proposer*. It writes candidate orders into a shared SQLite database
(`CriticalCorallations2026`'s `galao.db`) and a separate system (CC2026's `broker.py`)
decides what to do with them. This is the cleanest possible integration seam: GevaExtract's
job ends at "propose a row," and nothing here needs to know about IB, fills, or P&L to keep
doing its job.

**Biggest risk for a rebuild**: the double sanity filter (`server.js` §7 below) is the only
thing standing between "candidate order" and "market order that fills instantly at whatever
price is live." It's simple (a distance check) but easy to accidentally drop or weaken in a
rewrite, and there's no test covering it.

---

## 2. Architecture / code map

### 2.1 Executable entry points

| Command | File | What it does |
|---|---|---|
| `node server.js` | `server.js` | HTTP server on **:5005** — dashboard UI + the entire JSON API. The only long-running process. |
| `node extract.js [YYYY-MM-DD]` | `extract.js` | One-shot: scrape today's (or the given anchor date's) Geva post, save to `geva.db`. Exits on completion/failure — not a daemon. |
| `node backfill.js` | `backfill.js` | One-shot: scroll Facebook's in-group search results for `קווי תמיכה` until exhausted, save every post found that isn't already in `geva.db`. |
| `node save-auth.js` | `save-auth.js` | One-shot, **interactive, manual**: opens a headed browser, human logs into Facebook, session persists to `fb-profile/`. The only entry point that requires a human. |
| `node to-csv.js` | `to-csv.js` | One-shot: dump all `posts` rows to `output/geva_lines.csv`. |
| `node migrate.js` | `migrate.js` | One-shot: import the 6 committed `output/Geva_*.json` snapshots into `geva.db` (skips dates already present). |
| `node reparse.js` | `reparse.js` | One-shot: re-run `parse-lines.js` against every stored post's raw text and rewrite the `lines` table. Run after changing parsing rules. |
| `node debug.js` | `debug.js` | One-shot diagnostic: dumps DOM selector/structure info to `debug.txt` when Facebook's markup changes and the scraper needs re-tuning. Not part of any automated flow. |
| `python insert-commands.py [...]` | `insert-commands.py` | Invoked *only* as a subprocess of `server.js` (never run standalone in normal operation) — the sole write path into `galao.db`. |
| `run-daily.bat` | — | `node extract.js` then `node to-csv.js`, both logged to `logs/extract.log`. Runs under the `GevaExtract\DailyExtract` scheduled task, daily 09:00. |
| `auto-geva-scheduled.ps1` | — | Full auto-trade orchestration (fetch → build → submit), run under the `GevaAutoTrade` scheduled task, 3×/day. Calls `server.js`'s HTTP API — not a separate code path into GevaExtract's internals. |

### 2.2 How fetching is started

Three ways, all converging on the same `extract.js` logic:
1. **Scheduled**: `run-daily.bat` → `node extract.js` (daily 09:00, no date arg → anchors to
   "today").
2. **Dashboard button**: browser → `POST /fetch` → `server.js:runExtract()` (server.js:839-856)
   → spawns `node extract.js` as a child process with a **180s hard timeout** and a
   `fetchRunning` boolean mutex (server.js:841-842) that rejects a second concurrent `/fetch`
   with `{ok:false, msg:'already running'}` instead of racing two scrapes.
3. **Auto-trade scheduler**: `auto-geva-scheduled.ps1` → `POST /fetch` (same path as #2) →
   only called if `GET /api/today-lines` reports no lines (see §9 known gap on this check).

`backfill.js` is never invoked automatically by anything — always a manual, deliberate run.

### 2.3 External data sources

| Source | Used by | Auth | Notes |
|---|---|---|---|
| Facebook (private group `222428877934828`) | `extract.js`, `backfill.js`, `save-auth.js`, `debug.js` | Persistent Chromium session (`fb-profile/`), human-established | **The only real data source.** No official API — pure browser scraping. |
| Yahoo Finance chart API (`query1.finance.yahoo.com`) | `price-feed.js` | None (unauthenticated public endpoint) | Fallback/secondary price source, ~15min delayed. |
| `galao.db` (CriticalCorallations2026, external SQLite) | `galao-db.js` | Filesystem access only | **Preferred** live-price source when available (real IB prices via CC2026's broker) — see §2.10. Also the destination for order writes. |

GevaExtract has **no connection of any kind to IB/TWS/IB Gateway**. It never imports
`ib_insync`/`ibapi`, never opens a socket to port 4001/4002. Confirmed by grep — no such
import exists anywhere in this repo.

### 2.4 Instruments/contracts supported

- The scraped content itself is **S&P 500 futures** support/resistance levels — confirmed by
  Geva's own disclaimer text baked into every post: *"קווי התמיכה וההתנגדות נקבעים (על חוזה
  עתידי s&p500)..."* ("support/resistance lines are set on the S&P 500 futures contract...").
- Stored in `geva.db` under a fixed, hardcoded symbol: `lines.sym` is always `'ES'`
  (`parse-lines.js:5`, `SYM = 'ES'`). There is no per-contract-month/expiry handling
  anywhere — `ES` here means "the S&P 500 futures concept," not a specific expiring contract.
- At the trading layer (`trade-builder.js`), the `ES` price level is used to derive orders on
  exactly two tradable instruments: **MES** (Micro E-mini S&P 500, $5/point,
  `MULTIPLIER.MES = 5.0`) directly at the scraped price, and **MNQ** (Micro E-mini Nasdaq,
  $2/point, `MULTIPLIER.MNQ = 2.0`) at a price *proportionally scaled* by the live MES/MNQ
  ratio (`trade-builder.js:60-61`: `mnqLinePrice = mnqPrice * (linePrice / mesPrice)`).
- **No contract-roll logic exists anywhere.** If the front-month MES/MNQ contract changes,
  nothing in this repo adjusts for it — this is a real gap (see §9).

### 2.5 Historical vs realtime fetching

Both exist, cleanly separated, same underlying parse logic:
- **Realtime/daily**: `extract.js` — one post per run, "today" (or a given anchor date).
- **Historical/backfill**: `backfill.js` — Facebook's in-group text search for
  `קווי תמיכה`, scrolled until 6 consecutive no-new-content scrolls (`NO_NEW_LIMIT = 6`,
  `backfill.js:25`), deduplicated by post-body text (`seenBodies` Set,
  `backfill.js:126,134-135`), dates resolved by counting weekday-name occurrences
  newest-first (`backfill.js:161-173` — see §2.6).

There is no "live tick/price" fetching in GevaExtract at all — the only "price" concept here
is Geva's static daily support/resistance levels, not a market-data feed. (Realtime *market
prices*, as opposed to Geva's levels, come from `price-feed.js`/Yahoo or `galao-db.js`/IB —
see §2.10 — and exist only to evaluate the sanity filter and display, never stored/exported.)

### 2.6 Resolutions/timeframes supported

None, in the OHLCV-bar sense — this is not a bar/tick fetcher (that's the sibling
`Fetcher2026` repo's job). GevaExtract's only "time" granularity is **one post per calendar
trading day**. The `posts` table has exactly one row per `date` (`UNIQUE NOT NULL`,
`db.js:11`).

### 2.7 Timestamp / timezone handling

This is one of the more intricate, non-obvious parts of the codebase:
- **Facebook no longer exposes usable post-timestamp metadata** (comment, `extract.js:31-34`)
  — no reliable `data-utime`, and visible "time ago" text is deliberately obfuscated by
  Facebook to resist scraping.
- `detectPostDate()` (extract.js:162-199) still *tries* 3 DOM-based strategies in order
  (`data-utime` epoch attribute → `aria-label` parsed as a date string → `title` attribute
  parsed as a date string) but this is treated as a **secondary/cross-check** signal, not the
  source of truth.
- **The real signal is the Hebrew weekday name Geva writes into the post body** (e.g. `יום
  שלישי` = "Tuesday"), resolved via `resolveDateFromWeekday()` (extract.js:36-43): walk
  backward day-by-day from an anchor date until the weekday matches. This is why `extract.js`
  takes an optional `YYYY-MM-DD` anchor argument — it's the search starting point, not the
  result.
- If the DOM-based date and the weekday-derived date disagree, a `WARNING` is logged
  (extract.js:291-293) but **the weekday-derived date always wins** — the DOM date is never
  used to override it, only to flag a discrepancy in the log file (nothing else consumes this
  warning — no UI indicator, no alert).
- All dates are plain `YYYY-MM-DD` strings (`toDateStr()`, both files) — **no time-of-day, no
  timezone offset stored anywhere.** `capturedAt` is the only true timestamp
  (`new Date().toISOString()`, UTC, millisecond precision) and it's scrape-time metadata, not
  the post's actual publish time (which is unknowable per the above).
- In `backfill.js`, the same weekday-resolution idea is applied differently: because search
  results appear newest-first without reliable relative ordering *within* a weekday name,
  `resolveDate()` (backfill.js:50-57) counts *occurrences* of a given weekday name in
  encounter order and subtracts `7 × occurrenceIndex` days from the most recent occurrence of
  that weekday. This assumes Geva posts on that weekday every week without gaps — a
  vacation/skipped week would silently misdate everything before the gap. **Not validated
  anywhere** — worth flagging as a real historical-accuracy risk if backfill is ever re-run
  over a period with skipped weeks.

### 2.8 Market-session handling

None. GevaExtract has no concept of market open/close, pre/post-market, or session windows.
The daily scrape just runs on a wall-clock schedule (09:00 via Task Scheduler); the sanity
filter (§2.11) is the only place "is this a sane time to trade" logic loosely lives, and even
that's a price-distance check, not a session-time check.

### 2.9 Reconnect/retry logic

Deliberately thin — worth being explicit about what does *not* exist:
- **No network-failure retry** in `extract.js`/`backfill.js` themselves — a failed
  `page.goto()` (45s timeout, `extract.js:265`) throws, is caught by the top-level `try/catch`
  in `main()`, logged as `FATAL`, and the process exits 1. One attempt, no automatic retry.
- The `scroll` loops in both files (up to `MAX_SCROLLS = 40` in extract.js, `200` in
  backfill.js) are **not** retry logic — they're "wait for content to render / keep looking
  for the target post" loops, paced at `SCROLL_PAUSE_MS = 2800`ms specifically to look
  human and avoid Facebook's bot detection (comment intent, not stated outright, but the
  pacing plus the invisible-Unicode-stripping in §2.11 both point at anti-detection design).
- **The one real retry lives one layer up**, in `auto-geva-scheduled.ps1` (not this repo's
  Node/Python code, but part of the operational system): if `POST /api/trades/create` fails
  once, it waits 38s and retries exactly once before giving up
  (`auto-geva-scheduled.ps1:139-144`, per earlier session notes — verify against current file
  if reusing this logic, it lives outside GevaExtract's own code).
- No reconnect logic exists for the Playwright browser session itself — if the persistent
  context / `fb-profile/` session gets logged out mid-scrape, the run just fails (checked
  explicitly: `extract.js:270-273` detects a `login`/`checkpoint` URL and exits 1 rather than
  trying to recover) and needs a human to re-run `save-auth.js`.

### 2.10 Duplicate handling

Three independent, purpose-specific dedup mechanisms — see §7 for the full reliability
inventory; summarized here as part of the architecture map:
1. **`posts` table**: `date UNIQUE` + `ON CONFLICT(date) DO UPDATE` (db.js:47-58) — re-scraping
   the same date overwrites cleanly, never duplicates.
2. **`lines` table**: `UNIQUE(date, line_type, price)` + `INSERT OR IGNORE` (db.js:22-29,64-69)
   — and `upsertPost` explicitly `DELETE`s all of that date's lines before re-inserting
   (db.js:62), so re-parsing never leaves stale rows behind.
3. **`backfill.js`**: `seenBodies` Set (backfill.js:126) dedups by exact post-body text during
   the scroll-collection phase, since the same post can appear in multiple scroll snapshots.

### 2.11 Missing-data handling

- `support`/`resistance` are independently nullable (`extractLines()`, extract.js:236-237 —
  each regex match is optional via `?.[0] ?? null`) — if Geva's post is missing one section,
  the other still saves.
- `postUrl` can be `null` if none of the 4 href-pattern candidates match
  (`detectPostUrl()`, extract.js:203-218).
- If **no post at all** is found after all 40 scrolls, `extract.js` logs an explicit error
  distinguishing "not published yet" from "Facebook loaded differently today" (extract.js:279-280)
  and exits 1 — no silent empty save.
- `expandSeeMore()` (extract.js:139-158) tries 4 selector variants for the "See more" /
  "ראה עוד" expand button and simply logs "not found" and continues if none match — a
  post that's already fully expanded doesn't block extraction.
- `parseEntryPrices()` (parse-lines.js:17-28) explicitly discards anything parsing to a price
  `< 100` as noise (line 24) — a floor sanity check against the regex accidentally matching
  a stray digit.

### 2.12 Data normalization

`parse-lines.js` — the whole file is normalization. Key behaviors, all worth preserving
exactly:
- Strips parenthetical Hebrew annotations before parsing prices (e.g. `(קרוב מאוד למחיר
  השוק)` = "very close to market price" — `parseEntryPrices()` line 19) — **this
  discards semantically meaningful trader annotations**; they survive only in the raw
  `full_text`/`support`/`resistance` string columns, never in structured `lines` rows (see
  §4 known anomaly).
- A comma-separated "entry" like `"7532.25! - 7529.50!"` (a range) or `"7664.00? 7673.50!"`
  (two space-separated levels) both get exploded into **multiple independent `lines` rows**
  via a single `matchAll` regex pass (parse-lines.js:22) — there is no structural "this is a
  range" concept preserved; each bound becomes its own unconnected price-level row.
- Strength markers: `!` → `'!'` (strong), `?` → `'?'` (weak), empty → `''` (normal), anything
  else (e.g. the real observed value `*?!`, a multi-char marker) → `'other'`
  (`classifyStrength()`, parse-lines.js:13-15). This `'other'` bucket is real, observed data
  (see §4 example), not a hypothetical edge case.
- `extractLines()` exists in **two separate, non-shared implementations** —
  `extract.js:233-239` and `backfill.js:42-48` — with a subtly different resistance-section
  end boundary and support-section start anchor between them (backfill's version searches
  from the *last* occurrence of `בוקר טוב` in the text; extract's operates on
  already-body-trimmed text). This duplication is a real WRAP/REWORK candidate (§5).

### 2.13 Storage/database/files used

| File | Format | Owner | Committed to git? |
|---|---|---|---|
| `geva.db` | SQLite (sql.js pure-JS binary format) | GevaExtract, exclusive | **No** (gitignored as of this report; previously untracked-but-not-ignored) |
| `output/geva_lines.csv` | CSV | GevaExtract | Yes — latest snapshot export |
| `output/Geva_YYYY-MM-DD.{json,txt}` | JSON/plaintext | GevaExtract | Yes — 6 historical snapshots, `migrate.js`'s seed data |
| `fb-profile/` | Playwright Chromium user-data dir | GevaExtract, exclusive | No (gitignored), 484MB |
| `logs/*.log` | Plaintext, append-only | GevaExtract | No (gitignored) |
| `C:\Projects\CriticalCorallations2026\trader\data\galao.db` | SQLite, WAL mode | **External — CC2026 owns this**, GevaExtract is a guest writer | N/A, not this repo |

### 2.14 Update/incremental-fetch mechanisms

- `extract.js` is naturally idempotent per-date via the `ON CONFLICT(date) DO UPDATE` upsert
  (§2.10 #1) — safe to re-run for the same day any number of times.
- `migrate.js:19` and `backfill.js:179` both call `db.postExists(date)` (db.js:72-75) before
  writing, explicitly to make re-running either script over already-imported dates a cheap
  no-op rather than redundant work.
- There is **no incremental "since last fetch" cursor/checkpoint** — `backfill.js` always
  scrolls from the top of search results and relies purely on the `postExists`/`seenBodies`
  dedup to skip old data; there's no stored "last backfilled date" to resume from
  efficiently.

### 2.15 Logging

Simple, consistent, hand-rolled (no logging library):
- `extract.js:47-54`, `backfill.js:33-40` — identical pattern: timestamped
  `[ISO8601] message` line, `console.log` + best-effort append to `logs/{extract,backfill}.log`
  (directory auto-created, write failures silently swallowed via empty `catch {}`).
- `debug.js` writes a separate diagnostic dump to `debug.txt` (not under `logs/`).
- `server.js` has no persistent logging beyond the one startup line
  (`console.log` in `startServer()`, server.js:1234) — API request handling is not logged
  anywhere; the only durable trail of `/fetch`/`/api/submit-commands` activity is whatever
  `extract.js`'s own log captures plus `auto-geva-scheduled.ps1`'s separate
  `logs/auto-trade.log` (written by the PS1 script, not by GevaExtract's own code).

### 2.16 Configuration

There is no config file (no `.env`, `config.yaml`/`.json`, no config-loader module). All
configuration is either:
- **Hardcoded constants** in each file (`GROUP_URL`, `PORT = 5005`, `MAX_SCROLLS`,
  `SCROLL_PAUSE_MS`, `GALAO_DB` path, `MIN_ENTRY_TICKS = 8`, `MULTIPLIER`, `BRACKETS`, etc.)
- **Request-body parameters** for the few things that are runtime-configurable (`symbols`,
  `brackets`, `minStrength` in `POST /api/trades/create`; `enabled` in `POST
  /api/replenish`).
- **`version.json`** — the single external "config" file, just `{"v": 11}`, read
  synchronously at server boot (server.js:11) — a missing/malformed file prevents the server
  from starting at all.

### 2.17 Credentials/environment variables

**No environment variables are read anywhere in this repo** (`process.env` does not appear
in any `.js`/`.py` file). The only credential-shaped artifact is the Facebook session itself,
held entirely inside `fb-profile/`'s browser storage (cookies etc.) — established once via
the interactive `save-auth.js`, never expressed as a string/token GevaExtract's own code ever
touches or logs. No API keys, tokens, or `.env` files exist in this repo (confirmed by a
prior full-repo grep — see `RESTART_PROJECT.md` §"data that must be re-created").

### 2.18 Important dependencies

| Package | Declared | Actually used for |
|---|---|---|
| `playwright` (`^1.45.0`, resolved 1.61.1) | package.json | Headed Chromium automation — `extract.js`, `backfill.js`, `save-auth.js`, `debug.js`. **All four launch non-headless** (`headless: false` everywhere) — no headless code path exists. |
| `sql.js` (`^1.12.0`, resolved 1.14.1) | package.json | Pure-JS SQLite for **both** `geva.db` (read/write, `db.js`) and read-only access to the external `galao.db` (`galao-db.js`) — no native SQLite binding anywhere, deliberately (portable, no build step). |
| Python stdlib only (`sqlite3`, `argparse`, `json`, `pathlib`, `datetime`) | `insert-commands.py` | The `requirements.txt` (`ib_insync>=0.9.70`) is **vestigial — nothing in this repo imports it.** Don't carry it forward as a real dependency. |
| Node built-ins (`http`, `fs`, `path`, `child_process`, `crypto`, `https`, `readline`) | throughout | No web framework (raw `http.createServer`), no ORM, no ODM. |

Node ≥18 is the real floor (Playwright's own `engines` requirement); this repo's own
`package.json` declares no `engines` field. Current dev machine runs Node v24.

---

## 3. Complete fetch flow (one full trace)

Trigger: a human clicks "↓ Fetch" in the dashboard, or the daily 09:00 scheduled task fires.

```
run-daily.bat  (or:  browser → POST http://localhost:5005/fetch)
      │
      ▼
server.js : POST /fetch handler (server.js:1144-1148)
      │  await runExtract()
      ▼
server.js : runExtract()  (server.js:839-856)
      │  guards on in-memory `fetchRunning` boolean — refuses a second concurrent call
      │  spawn(process.execPath, ['extract.js'], { cwd: __dirname, timeout: 180_000 })
      ▼
extract.js : main()  (extract.js:244-326)
      │
      ├─ anchorDate = argv[2] ? new Date(argv[2]) : new Date()          [configuration]
      ├─ guard: fs.existsSync(PROFILE_DIR) — else log + process.exit(1) [credential check]
      ├─ db = await openDb()                                            [db.js:40-103]
      ├─ browser = chromium.launchPersistentContext(PROFILE_DIR, {...}) [connection — Playwright]
      ├─ page.goto(GROUP_URL, {waitUntil:'domcontentloaded', timeout:45000})   [request]
      ├─ guard: url includes 'login'/'checkpoint' → exit(1)             [auth-failure detection]
      │
      ├─ article = await findMatchingPost(page)     (extract.js:86-135) [request — scroll+search loop]
      │     loop up to 40×: page.evaluate(...) runs entirely IN-BROWSER,
      │     tries 3 candidate CSS selectors, textContent-matches both
      │     SEARCH_SUPPORT ('קווי תמיכה') and SEARCH_RESISTANCE ('קווי התנגדות')
      │     strings against every candidate post element; scrolls + waits
      │     (2800ms pace) between attempts if not found
      │
      ├─ await expandSeeMore(article)                (extract.js:139-158) [request, best-effort]
      ├─ fullText = await extractPostBody(article)    (extract.js:222-229) [received data]
      │     article.evaluate(el => el.innerText) → regex-trim to the
      │     "בוקר טוב ... בלבד." body span
      ├─ { support, resistance } = extractLines(fullText) (extract.js:233-239) [normalization, coarse]
      │
      ├─ domDate    = await detectPostDate(article)   (extract.js:162-199) [normalization — date, secondary]
      ├─ weekdayDate = resolveDateFromWeekday(fullText, anchorDate) (extract.js:36-43) [normalization — date, primary]
      ├─ postDate = weekdayDate ?? domDate ?? toDateStr(anchorDate)      [fallback chain]
      ├─ postUrl  = await detectPostUrl(article)       (extract.js:203-218) [received data]
      │
      ├─ data = { date, day, support, resistance, fullText, postUrl,
      │           groupUrl, capturedAt: new Date().toISOString() }      [DATA STRUCTURE — the scrape result]
      │
      ▼
db.upsertPost({ ...data, source: 'daily' })     (db.js:47-70)           [validation + storage]
      │
      ├─ INSERT INTO posts (...) VALUES (...) ON CONFLICT(date) DO UPDATE ...   [storage: coarse text]
      │
      └─ const lines = parseLinesFromPost(row)         (parse-lines.js:30-49) [normalization, fine-grained]
             │  for support/resistance strings:
             │    strip the "קווי תמיכה:"/"קווי התנגדות:" prefix
             │    split on ','
             │      for each comma-segment:
             │        parseEntryPrices(entry)  (parse-lines.js:17-28)    [validation: price >= 100]
             │          strip "(...)" parenthetical notes
             │          matchAll numeric-price + trailing-marker pairs
             │          classifyStrength(marker) → '!' | '?' | '' | 'other'
             │    → rows: { sym:'ES', date, line_type:'sup'|'res', price, strength }
             │
             ├─ DELETE FROM lines WHERE date = ?                         [storage: clear stale rows]
             └─ for each row: INSERT OR IGNORE INTO lines (...)          [storage: fine-grained levels]
      │
db.save()   (db.js:95-97)  →  fs.writeFileSync(geva.db, db.export())    [storage: flush to disk]
      │
      ▼
extract.js exits 0  →  server.js's spawn 'close' handler resolves {ok:true, msg:'Success'}
      │
      ▼
Response to caller: {"ok":true,"msg":"Success"}
```

**Key data structures in this flow**:
- `data` object in `extract.js:301-310` — the scrape result before storage (matches the
  `posts` table shape 1:1 plus a `source` field added at the call site).
- `row` objects returned by `parseLinesFromPost()` — `{sym, date, line_type, price,
  strength}` — matches the `lines` table shape exactly.
- The in-memory `db` handle returned by `openDb()` is a closure over a live `sql.js`
  `Database` object — **not** a connection pool or ORM instance; every `openDb()` call loads
  the *entire* `geva.db` file into memory fresh (`fs.readFileSync`, db.js:42) and every
  `.save()` call serializes the *entire* database back to disk (`db.export()`, db.js:96).
  Fine at current data volume (hundreds of rows); would not scale to a large historical
  archive without a real SQLite driver.

---

## 4. Data contract

### 4.1 `geva.db` → `posts` table

One row per trading day Geva posted about.

| Field | Type | Meaning | Nullable | Notes |
|---|---|---|---|---|
| `id` | INTEGER | Autoincrement surrogate PK | No | Not semantically meaningful — use `date` |
| `date` | TEXT | `YYYY-MM-DD`, the resolved post date | No | **Unique.** See §2.7 for how it's derived — not the actual Facebook post timestamp, a weekday-name-matched date |
| `day` | TEXT | Hebrew weekday name, e.g. `יום חמישי` | Yes | Derived from `date`, purely display/redundant |
| `support` | TEXT | Raw Hebrew support-lines string, e.g. `קווי תמיכה: 7592.50! - 7588.25, ...` | Yes | Human-readable, not machine-parsed further at this layer |
| `resistance` | TEXT | Raw Hebrew resistance-lines string | Yes | Same shape as `support` |
| `full_text` | TEXT | Entire post body (Hebrew), `"בוקר טוב"..."בלבד."` span | Yes | Includes disclaimer text and the book-promo line; the only place parenthetical annotations survive |
| `post_url` | TEXT | Facebook permalink | Yes | 1-of-4 href pattern match; may be `null` |
| `captured_at` | TEXT | ISO8601 UTC scrape timestamp | Yes | **Not** the post's publish time — see §2.7 |
| `source` | TEXT | `'daily'` \| `'backfill'` \| `'daily'` (default) | No (has DB default `'daily'`) | Distinguishes normal vs backfilled rows |

Primary/unique key: `date`. Ordering: `getAllPosts()` returns `ORDER BY date ASC`
(db.js:79); dashboard/UI code may re-sort for display.

### 4.2 `geva.db` → `lines` table

One row per individual price level (the fine-grained, machine-usable output).

| Field | Type | Meaning | Units | Nullable | Notes |
|---|---|---|---|---|---|
| `id` | INTEGER | Autoincrement surrogate PK | — | No | |
| `sym` | TEXT | **Always `'ES'`** | — | No, default `'ES'` | Not a real per-contract symbol — see §2.4 |
| `date` | TEXT | `YYYY-MM-DD`, FK-like to `posts.date` (not enforced) | — | No | |
| `line_type` | TEXT | `'sup'` \| `'res'` | — | No | Lowercase, 3-char — **different convention** from `galao.db`'s `SUPPORT`/`RESISTANCE` (mapped in `trade-builder.js:30`) |
| `price` | REAL | S&P 500 futures index price level | index points | No | e.g. `7592.5` |
| `strength` | TEXT | `'!'` (strong) \| `'?'` (weak) \| `''` (normal) \| `'other'` (unrecognized marker combo) | — | No, default `''` | `'other'` is real observed data, not hypothetical — see example below |

Primary/unique key: composite `(date, line_type, price)` — enforced via `UNIQUE` constraint
+ `INSERT OR IGNORE`, so a re-parse of the same date/type/price is a no-op, not an error.
Ordering: `getAllLines()` returns `ORDER BY date DESC, line_type ASC, price ASC` (db.js:88).

**Known anomalies**:
- A textual "range" (`"7532.25! - 7529.50!"`) or a compound multi-level entry
  (`"7664.00? 7673.50!"`) both decompose into **multiple unconnected rows** — no structural
  link between them is preserved (§2.12).
- Parenthetical trader annotations (e.g. *"very close to market price"*) attached to a
  specific level in the source text are **discarded entirely** at this layer — recoverable
  only by re-parsing `posts.support`/`posts.resistance` text yourself.
- `strength = 'other'` is a real bucket, not theoretical — e.g. observed real value `*?!`
  from `output/Geva_2026-07-16.json`'s resistance line `7628.75*?!`.

### 4.3 `output/Geva_YYYY-MM-DD.json` (committed snapshot files, `migrate.js`'s seed format)

Same shape as the `data` object built in `extract.js:301-310`, i.e. a flattened `posts` row
plus `groupUrl`:

```json
{
  "date": "2026-07-16",
  "day": "יום חמישי",
  "support": "קווי תמיכה: 7592.50! - 7588.25, 7570.25!, 7552.50?, 7532.25! - 7529.50!, 7507.75?, 7469.00!, 7409.00! - 7398.50",
  "resistance": "קווי התנגדות: 7628.75*?! (קרוב מאוד למחיר השוק), 7648.25!, 7664.00? 7673.50!, 7692.50! - 7700.25",
  "fullText": "בוקר טוב לסוחרים, יום חמישי,\nקווי תמיכה: ...\nקווי התנגדות: ...\nסימן קריאה - ...\n*עדיין לא קראתם...*\nhttps://www.gevatrade.com/?p=2543\nשימו לב - קווי התמיכה וההתנגדות נקבעים (על חוזה עתידי s&p500) בשעות הבוקר עבור יום המסחר הנוכחי ויש להתייחס אליהם לצורך מידע לימודי בלבד.",
  "postUrl": "https://www.facebook.com/photo/?fbid=...",
  "groupUrl": "https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY",
  "capturedAt": "2026-07-16T08:01:07.057Z"
}
```

### 4.4 `output/geva_lines.csv`

Header: `date,day,support,resistance,post_url,source` — a flat export of the `posts` table
(not `lines`), RFC-4180-style quoted/escaped (`to-csv.js:10-14`). One row per day.

### 4.5 What GevaExtract writes into `galao.db` (candidate orders — the actual cross-project contract)

**`galao.db`'s `commands` table schema is owned by CriticalCorallations2026, not this repo**
— GevaExtract only knows the columns it writes via `insert-commands.py:36-56`. This is the
real "output data contract" for another project to consume, since it's the one durable,
cross-repo artifact GevaExtract produces from its trade-building logic:

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `symbol` | TEXT | `'MES'` \| `'MNQ'` | |
| `line_price` | REAL | The Geva price level this order derives from (MNQ-scaled for MNQ rows) | |
| `line_type` | TEXT | `'SUPPORT'` \| `'RESISTANCE'` | Note: uppercase, differs from `geva.db.lines.line_type` |
| `line_strength` | INTEGER | `1` (strong) \| `2` (normal) \| `3` (weak) | Note: **inverted-looking mapping** vs `geva.db` — `'!' → 1`, `'' → 2`, `'?' → 3`, `'other' → 2` (`trade-builder.js:27`) |
| `direction` | TEXT | `'BUY'` \| `'SELL'` | |
| `entry_type` | TEXT | `'LMT'` \| `'STP'` | Determined by current-price-vs-line-price toggle rule, `trade-builder.js:36-39` |
| `entry_price`, `tp_price`, `sl_price` | REAL | All tick-rounded (`rt()`, `trade-builder.js:32-34`, nearest `0.25`) | |
| `bracket_size` | REAL | TP distance in points — metadata for CC2026's own replenishment logic, not consumed further by GevaExtract | |
| `source` | TEXT | Always `'geva_extract'` (hardcoded in `insert-commands.py:41`) | The single-writer tag — see integration notes §5 |
| `quantity` | INTEGER | Always `1` (hardcoded, `insert-commands.py:39`) | Not currently configurable anywhere |
| `status` | TEXT | Always inserted as `'PENDING'` | GevaExtract never transitions this — CC2026's `broker.py` owns the state machine from here |
| `created_at`, `updated_at` | TEXT | ISO8601 UTC | Both set to the same "now" at insert time |

**Not persisted, computed but discarded before insert** (`server.js:1018-1029`'s `clean`
mapping strips these): `_group_id` (a `randomUUID()` tying one Geva line's MES+SELL/BUY/MNQ
32-command family together, `trade-builder.js:59`), `_bracket` (the bracket label like
`b4/16`), `_line_date`. **This means the logical grouping of "these N orders all came from
the same Geva price level" exists only transiently in server memory and the dashboard UI —
it is not recoverable from `galao.db` after submission.** Worth fixing in a rebuild if
per-line grouping/analysis is wanted downstream (see §9).

Per Geva price level: exactly **32 candidate commands** (8 brackets × 2 directions × 2
symbols, `trade-builder.js:66-67` nested loop over `BRACKETS` and `['BUY','SELL']`, doubled
for MES+MNQ).

---

## 5. KEEP / WRAP / REWORK

Conservative by design — reliable fetching logic defaults to KEEP or WRAP.

### KEEP AS-IS

| Item | Why |
|---|---|
| `extract.js` — `resolveDateFromWeekday()`, `detectPostDate()`, `findMatchingPost()`, `expandSeeMore()`, `extractPostBody()`, `extractLines()`, `detectPostUrl()`, `clean()` | The hard-won anti-scraping/date-resolution logic. No known bugs, handles real observed edge cases (missing metadata, invisible Unicode, DOM variance). Rewriting this from scratch means re-discovering the same Facebook quirks the hard way. |
| `parse-lines.js` (`parseEntryPrices`, `classifyStrength`, `parseLinesFromPost`) | Small, self-contained, handles real observed data shapes (ranges, compound entries, the `'other'` strength bucket). No external dependencies. |
| `db.js` schema (`posts`/`lines` table DDL) and upsert semantics | Correct dedup/idempotency behavior (§2.10), simple, proven. |
| `trade-builder.js` (`buildOrdersForLevel`, `calcPrices`, `entryType`, `rt`, `BRACKETS`) | Pure functions, no I/O, matches CC2026's own toggle-rule convention exactly (stated in the file's own header comment) — this is a shared-vocabulary contract with the execution side, changing it unilaterally would desync from CC2026. |
| The double sanity filter (`MIN_ENTRY_TICKS` check in both `handleTradesCreate` and `handleSubmitCommands`, server.js:958-973, 1007-1014) | Simple but load-bearing — the only thing preventing near-market STP/LMT orders from behaving like market orders. See §7, §9. |
| `insert-commands.py`'s WAL-safe write pattern (`get_con()`, `PRAGMA journal_mode=WAL`) | Correct, minimal, avoids the well-known "don't write SQLite WAL files from two runtimes carelessly" trap. |

### WRAP

| Item | Why | Suggested interface shape |
|---|---|---|
| `extract.js`/`backfill.js` as a whole | Currently only invocable as `node extract.js [date]` (spawn a whole Node process, scrape a whole browser session) or via the `/fetch` HTTP endpoint. A larger platform will want to call this as a library function, not shell out to a CLI. | An async `fetchTodaysPost(anchorDate?) -> {date, day, support, resistance, fullText, postUrl, capturedAt}` that the current `main()` becomes a thin CLI wrapper around — internals (all the functions listed under KEEP) stay untouched, just stop being unexported top-level statements in a script. |
| `db.js` | Solid schema/semantics, but the sql.js "load entire file, mutate in memory, `export()` the whole thing back to disk on every save" pattern (§3's closing note) is a scaling wrapper concern, not a logic concern. | Same public shape (`openDb()`, `upsertPost`, `getAllPosts`, `getAllLines`), different storage backend underneath if the future project needs concurrent access or a bigger archive. |
| `galao-db.js` read path | Correct, safe (never calls `.save()`), but hardcodes the absolute path to a sibling repo (§6) and re-loads the whole external DB file on every call. | Keep the query surface (`getGevaOpenCommands`, `getPrice`, `getSystemState`, etc.) as the interface; make the DB path injectable and consider a connection kept open with periodic reload instead of full reload per call. |
| `trade-builder.js` invocation surface | The pure math (KEEP, above) is fine; its only consumer today is `server.js`'s HTTP handlers with inline sanity-filter/dedup logic mixed in. | Extract `handleTradesCreate`'s sanity+dedup filtering (server.js:960-973) into a named, testable function separate from the HTTP glue — same logic, cleaner seam. |

### REWORK

| Item | Why |
|---|---|
| `extractLines()` duplicated between `extract.js:233-239` and `backfill.js:42-48` | Two independently-maintained copies of the same regex logic with subtly different boundary conditions (§2.12) — a fix to one won't propagate to the other. Should become one shared function. |
| `clean()` (invisible-Unicode stripper) duplicated between `extract.js:60-75` and inlined inside `backfill.js:61-72`'s `page.evaluate()` closure | Same duplication problem; harder to fix since one copy runs inside a serialized browser-context closure (can't just `require()` a shared module there without Playwright's `addInitScript`/exposed-function machinery). Worth doing, not urgent. |
| `server.js`'s bare `python` spawn (server.js:862, no fully-qualified interpreter path) | Same footgun documented ecosystem-wide (see `ORCHESTRATOR.md` in this repo) — works today by accident of PATH ordering, not by design. Trivial fix, real fragility. |
| The raw hand-rolled HTTP router in `server.js` (`if (req.method === ... && url === ...)` chain, server.js:1141-1231) plus the giant inline HTML-string dashboard (`buildHtml()` et al., server.js:171-838) | Not unreliable, just not something a "larger platform" should absorb wholesale — 838 lines of template-literal HTML generation with a documented double-backslash-escaping footgun (see this repo's own `CLAUDE.md` §"Known issues"). If the future platform has its own UI framework, this is the part to actually replace rather than integrate. |
| `GET /api/today-lines`'s staleness check (server.js:1156-1173, `hasLines = lines.length > 0`) | Known, already-documented bug (see this repo's `OPERATIONS.md` incident log) — doesn't check that the "latest" date is actually today, so the auto-trade scheduler can silently run for days off a stale post. Real logic bug, not an infrastructure judgment call — flagged here again because it directly affects "does the fetch layer actually keep data fresh," which is exactly this report's concern. |
| `_group_id`/`_bracket` metadata being computed then discarded before `galao.db` insert (§4.5) | Not broken, but a real design gap for any future analysis that wants to know "which orders came from the same Geva line" — currently unrecoverable after submission. |

**Explicitly not classified as an "algorithm to evaluate for profitability"**: nothing in
this repo makes a trading decision beyond "translate a human's manually-drawn price level
into a mechanical bracket order." There is no signal-generation, no backtesting, no
strategy logic here — that's entirely on the CC2026 side. This repo's KEEP items are
**data-pipeline reliability**, not "proven strategy" claims.

---

## 6. Dependencies and coupling

What GevaExtract currently expects to exist, and what the new parent project needs to
provide:

| Dependency | Type | Hardcoded where | What the new project needs |
|---|---|---|---|
| `C:\Projects\CriticalCorallations2026\trader\data\galao.db` | External SQLite file, WAL mode | `galao-db.js:8-10`, `insert-commands.py:17` | Either the real CC2026 repo present at that exact path, or these two path constants updated to point at wherever the new platform's shared order DB lives |
| `galao.db`'s `commands` table schema (specific column names/types) | Implicit schema contract, not owned by this repo | `insert-commands.py:36-56`, `galao-db.js` query strings | The `commands` table (or its replacement) must accept exactly the columns in §4.5 |
| `localhost:5003/api/session/status` (CC2026's dashboard) | HTTP dependency | `server.js:13,882-892` | CC2026's dashboard running, or this URL/response shape reimplemented — used only for a status-bar badge, GevaExtract degrades gracefully (returns `null`) if unreachable |
| `localhost:5001/api/cancel-all` (CC2026's legacy visualizer) | HTTP dependency | `server.js:1096` | A real, documented **hard dependency** for the Cancel-All → IB `reqGlobalCancel` relay — CC2026's own docs mark port 5001 "do not start" elsewhere in the ecosystem, a genuine cross-project footgun already flagged in this repo's `ORCHESTRATOR.md` |
| `python` on PATH | Executable dependency | `server.js:862` | A working Python 3.11+ interpreter reachable via bare `python` in whatever environment `server.js` runs in — stdlib only, no pip packages actually required despite `requirements.txt` |
| IB Gateway (port 4002, paper) — **indirect** | Not connected to directly, but `galao-db.js`'s preferred price source (`getPrice('MES'/'MNQ')`) only has data when CC2026's broker has written it there | `handleTradesCreate`, server.js:918-927 | If absent, GevaExtract silently falls back to Yahoo Finance prices (§2.3) — degrades, doesn't fail |
| Facebook (network + logged-in session) | External service + credential | `extract.js:14`, `backfill.js:19-21`, hardcoded to one specific private group ID | A working, currently-authenticated `fb-profile/` Playwright profile — **cannot be provisioned automatically**, requires a human running `save-auth.js` |
| Yahoo Finance public chart API | External service, unauthenticated | `price-feed.js:10` | Outbound internet access; no credential needed |
| `version.json` | Local file | `server.js:11` | Must exist and contain valid `{"v": N}` or the server won't boot |

**Implicit assumptions worth surfacing explicitly**:
- Everything assumes **Windows paths** (`C:\Projects\...`, backslash path construction via
  `path.join('C:','Projects',...)` in `galao-db.js:8-10`) — not portable to another OS
  without changing these constants.
- Everything assumes a **single-machine, single-user** deployment — no multi-tenant
  concept, no per-user credential/session separation, one `fb-profile/`, one `geva.db`.
- The dashboard and API assume **no auth of their own** — `server.js` has zero
  authentication/authorization on any endpoint, including the one that writes real orders
  into a shared trading DB (`POST /api/submit-commands`). Fine on `localhost`-only current
  deployment; a real gap if the new platform ever exposes this beyond one trusted machine.

---

## 7. Reliability mechanisms (do not lose these in a rewrite)

Ranked roughly by how easy each would be to silently drop, and how bad that would be:

1. **The double sanity filter** (`MIN_ENTRY_TICKS = 8`, i.e. 2.0 points, server.js:898) —
   applied once at candidate-build time (`handleTradesCreate`, server.js:966-968: drop any
   candidate whose `entry_price` is within 2pts of the *build-time* market price) and again
   independently at submit time (`handleSubmitCommands`, server.js:1007-1014, explicit
   comment: *"market may have moved since build was called"* — re-reads current price and
   re-filters). **This is the single most important thing not to lose** — it's the only
   guard against an LMT/STP order effectively behaving like a market order because price
   moved between "user clicked build" and "user clicked submit." A version-control note: a
   real commit (`d062beb`, "Double sanity filter to 8 ticks (2 pts) min entry distance")
   exists specifically because a *single* filter pass wasn't considered safe enough.

2. **Three-tier post-date resolution with a cross-check warning** (§2.7): weekday-name
   (primary) → DOM `data-utime`/`aria-label`/`title` (secondary/cross-check only, never
   overrides) → raw anchor date (last-resort fallback). A naive rewrite might "simplify" this
   to just trusting DOM metadata, which the code explicitly documents as unreliable
   (extract.js:31-34) — that would be a regression, not a simplification.

3. **Three independent dedup mechanisms**, each solving a different problem (§2.10): DB-level
   upsert (re-scrape safety), `INSERT OR IGNORE` on `lines` (re-parse safety), and the
   `activeKeys` Set in `handleTradesCreate` (server.js:946-955, don't resubmit an
   already-live identical order). Collapsing these into "one generic dedup layer" risks
   losing the specific tuple each one keys on.

4. **`fetchRunning` mutex** (server.js:841-842, in-memory boolean) — prevents two overlapping
   scrapes from racing each other and corrupting `geva.db`'s save-the-whole-file-on-every-save
   write pattern. Simple, easy to overlook if `runExtract()` gets refactored.

5. **Invisible-Unicode stripping** (`clean()`, §2.12) — Facebook injects zero-width/bidi/soft-hyphen
   characters specifically to break substring matching by scrapers (explicit code comment,
   extract.js:58-59). Silently dropping this in a rewrite wouldn't cause an obvious crash —
   it would cause `SEARCH_SUPPORT`/`SEARCH_RESISTANCE` string matching to start silently
   failing intermittently, a very hard bug to diagnose later.

6. **Anti-detection scroll pacing** (`SCROLL_PAUSE_MS = 2800`, plus the two-stage
   `scrollBy` + wait pattern in `findMatchingPost()`, extract.js:120-123) — not documented as
   explicitly "anti-bot-detection" but the specific two-phase scroll-then-wait shape, paired
   with the invisible-Unicode handling above, strongly suggests it is. Speeding this up in a
   rewrite for "efficiency" risks the Facebook session getting flagged/logged out — the exact
   failure mode `save-auth.js` exists to manually recover from.

7. **Session-death detection** (`extract.js:270-273`, `backfill.js:121-124`) — explicit
   `login`/`checkpoint` URL substring check after navigation, immediate clean exit(1) rather
   than proceeding to scrape a login page and silently saving garbage. Easy to lose if
   someone "simplifies" the post-navigation flow.

8. **Layered timeout handling** — every external call has an explicit timeout, tuned per
   call: `page.goto` 45s (extract.js:265), spawned `extract.js` child process 180s hard-kill
   (server.js:844), `insert-commands.py` subprocess 10s (server.js:863, matches
   `insert-commands.py:25`'s own `sqlite3.connect(timeout=10)`), CC2026 status check 2s
   (server.js:890), Yahoo Finance fetch 8s (price-feed.js:23), cancel-all relay to port 5001
   5s (server.js:1105). None of these are arbitrary-looking defaults; losing the specific
   tuning (e.g. collapsing them to one global timeout) could reintroduce hangs each was
   presumably tuned to avoid.

9. **Idempotent upsert as the *only* incremental-fetch mechanism** (§2.14) — there's no
   separate checkpoint/cursor to keep in sync with the DB; the DB's own unique-constraint
   behavior *is* the incremental mechanism. A rewrite that adds a separate "last fetched"
   cursor without also keeping the upsert idempotent risks the two falling out of sync.

---

## 8. Recommended integration interface

Deriving from what exists, not inventing new architecture. Distinguishing what's already
there from what's a thin wrapper recommendation from what genuinely doesn't exist yet.

### Already exists (as HTTP endpoints on :5005 — could be called today, as-is)

| Endpoint | Shape | Maps to |
|---|---|---|
| `POST /fetch` | `() -> {ok, msg}` | Triggers one `extract.js` run |
| `GET /api/today-lines` | `() -> {hasLines, date, count, dbToday}` | **Buggy** — see §5 REWORK, don't build on this until fixed |
| `POST /api/trades/create` | `{symbols?, brackets?, minStrength?} -> {ok, candidates[], total, passed, sanityFiltered, deduped, priceSource}` | `handleTradesCreate` — the closest thing to a "build orders" call that exists today |
| `POST /api/submit-commands` | `{commands[]} -> {ok, inserted, sanityDropped}` | `handleSubmitCommands` → `insert-commands.py` |
| `GET /api/prices` | `() -> {MES:{price,ts}, MNQ:{price,ts}}` | Yahoo-only, doesn't include the IB-preferred price used internally by trade-building |
| `GET /api/pnl` | `() -> {open[], closed[], counts[], prices, session, replenish}` | Read-only view over `galao.db`, filtered to `source='geva_extract'` |

### Recommended thin wrappers (functionality exists, just not exposed as a clean function-call boundary)

Derived directly from the code traced above — these are almost 1:1 renames/exports of
existing internal functions, not new logic:

```
fetchLatestPost(anchorDate?: string) -> {date, day, support, resistance, fullText, postUrl, capturedAt}
    = extract.js's main() body minus the process.exit()/CLI framing (§5 WRAP)

getStoredLines(date?: string) -> Array<{sym, date, line_type, price, strength}>
    = db.js's getAllLines(), optionally filtered — already exists, just needs a date param added

getAvailableDateRange() -> {earliest: string, latest: string}
    = does NOT exist today — trivial to add (MIN/MAX over posts.date), but not present as a query anywhere currently

buildCandidateOrders({symbols, brackets, minStrength, prices}) -> candidates[]
    = trade-builder.js's buildOrdersForLevel() + server.js's sanity/dedup filtering
      (server.js:900-986), currently entangled with HTTP request/response handling —
      wrapping this means separating the pure logic from the Node http req/res objects

submitOrders(candidates[]) -> {inserted, sanityDropped}
    = handleSubmitCommands (server.js:988-1043), same separation-from-HTTP concern
```

### Genuinely does not exist (would need real new code, not just a wrapper)

- **`get_bars(symbol, start, end, resolution)`** — GevaExtract has no bar/OHLCV concept at
  all (§2.6). Not applicable to this repo's actual output; that's `Fetcher2026`'s domain, not
  GevaExtract's, if the platform wants a unified `get_bars` surface.
- **`update_market_data(...)`** in a generic sense — the closest existing thing is
  `POST /fetch`, which is Facebook-specific and does one thing (today's Geva post). There's
  no generic "update whatever data source" abstraction here to build on.
- **A "get lines for symbol X" query that isn't hardcoded to `ES`** — since `sym` is always
  `'ES'` today (§2.4), a multi-symbol version of this whole pipeline would need real new
  design work (which sources map to which symbols), not just a wrapper.
- **Any kind of push/webhook/event-driven notification** ("new post arrived") — everything
  today is pull-based (a client calls `/fetch` or polls `/api/today-lines`). No event bus, no
  webhook emission exists anywhere in this repo.
- **Correlation between a submitted order and its originating Geva line, post-submission**
  (§4.5's discarded `_group_id`) — would need a schema change (either in `galao.db` or a
  side table) to actually persist, not just an interface wrapper.

---

## 9. Risks/gaps

- **No contract-roll handling** (§2.4) — MES/MNQ front-month rollover isn't modeled anywhere.
  If the underlying contract changes, nothing here adjusts. Likely fine today only because a
  human is in the loop reviewing candidates before submit; would be a real gap for any more
  autonomous future flow.
- **`GET /api/today-lines` staleness bug** (§5 REWORK) — already causing a real,
  previously-observed multi-day silent-staleness incident (documented in this repo's own
  `OPERATIONS.md`). Fix is drafted but intentionally not applied pending sign-off, since it
  changes live trading-decision logic — flagged again here because it's directly relevant to
  "does this fetcher reliably keep the platform's data fresh."
- **No authentication on any endpoint**, including the one that writes real orders — a
  design gap if this ever runs anywhere less trusted than one operator's own machine.
- **`geva.db`'s whole-file-load/whole-file-save pattern** doesn't scale indefinitely — fine
  today, worth a real storage-backend decision before this becomes a large historical
  archive.
- **`backfill.js`'s weekday-occurrence-counting date resolution** (§2.7) silently
  mis-dates everything before a gap if Geva skipped a week — no validation catches this.
  Worth a sanity check (e.g. cross-referencing `full_text` content for other date hints)
  before trusting a large backfill run blindly.
- **Per-line order grouping is computed then discarded** (§4.5) — a real, currently-invisible
  gap for anyone wanting to analyze "how did orders from this specific Geva line perform" downstream.
- **No test suite exists anywhere in this repo** (confirmed: no `test/`, `*.test.js`,
  `*.spec.js`, or Python test files found). Every mechanism in §7 is currently protected only
  by "the code as written," not by anything that would catch a regression. Worth prioritizing
  test coverage for the sanity filter (§7 item 1) specifically, given the financial-safety
  stakes, before any rewrite touches that code path.

---

## 10. Exact file list the future project would need

**Core, reuse largely as-is (KEEP, §5):**
```
extract.js
backfill.js
parse-lines.js
db.js
trade-builder.js
insert-commands.py
```

**Needed for those to run, with adjustment (WRAP, §5):**
```
galao-db.js                (path constant needs updating for new location)
save-auth.js                (interactive credential bootstrap — keep as a manual step)
```

**Reference/seed data, not code:**
```
output/Geva_2026-07-*.json  (6 files — migrate.js's seed data, useful as test fixtures too)
output/geva_lines.csv
```

**Take the ideas, not necessarily the files (REWORK, §5 — likely reimplemented in the new platform's own framework):**
```
server.js       — HTTP surface + dashboard; reference for endpoint shapes (§8) and the
                  double-sanity-filter logic specifically (server.js:958-973, 1007-1014)
                  which must be ported faithfully regardless of what replaces the HTTP layer
```

**Not needed by a data/order-pipeline integration, useful only for local dev/ops:**
```
to-csv.js, migrate.js, reparse.js, debug.js, price-feed.js,
run-daily.bat, setup-scheduler.bat, auto-geva-scheduled.ps1,
CLAUDE.md, OPERATIONS.md, RESTART_PROJECT.md, ORCHESTRATOR.md,
GEVAEXTRACT_STATE.md, GALGO2027_HANDOFF.md (superseded, historical only)
```

**External, not files in this repo but required for it to function:**
```
fb-profile/                                          (gitignored, machine-specific, re-auth via save-auth.js)
geva.db                                               (gitignored, the actual data — must be migrated/copied, not re-derived except via backfill.js)
C:\Projects\CriticalCorallations2026\trader\data\galao.db   (external, owned by CC2026)
```

---

## MESSAGE FOR THE ARCHITECT

GevaExtract is a narrow, reliable **data producer + order proposer** — it never talks to IB
and has zero execution logic. Its entire value is in ~6 functions in `extract.js` (Facebook
scraping under real anti-bot friction: invisible-Unicode injection, no reliable timestamps,
DOM variance) and `parse-lines.js` (Hebrew text → price levels). Reuse these near-verbatim;
rewriting them means re-discovering the same Facebook quirks by trial and error.

The one thing that must not regress: the **double sanity filter** (`server.js`, `MIN_ENTRY_TICKS
= 8` ticks / 2.0 pts, checked once at build time and again independently at submit time). It's
the only guard against a proposed LMT/STP order behaving like a market order if price moved
between build and submit. There is no test for it — treat it as financial-safety-critical if
you port this logic.

GevaExtract's output contract into `galao.db.commands` (`source='geva_extract'`, columns
listed in report §4.5) is a **write-only, fire-and-forget** relationship — it never reads back
order state beyond a read-only status display. The `commands` table schema itself is owned by
CriticalCorallations2026, not this repo; treat it as an external contract, not something to
redesign from GevaExtract's side alone.

Real, currently-open gaps, not fixed here: `GET /api/today-lines` can report stale data as
"current" (already caused one real multi-day incident); no futures contract-roll handling
anywhere; per-Geva-line order grouping (`_group_id`) is computed then discarded before DB
insert, so post-hoc "which orders came from this line" analysis is currently impossible; zero
auth on any endpoint, including the order-writing one; zero automated tests anywhere in the
repo.

Everything here is single-symbol (`ES` levels → MES/MNQ orders only), single-machine,
single-user, Windows-path-hardcoded. None of that is a bug given current scope, but none of it
generalizes for free either — a multi-symbol or multi-tenant future platform needs real new
design here, not just a wrapper.
