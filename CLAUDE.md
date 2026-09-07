# GevaExtract

Scrapes Geva's daily ES S/R lines from a private Facebook group, stores them in a local SQLite DB, and serves a dashboard that lets you build and submit bracket orders to Interactive Brokers via the shared `galao.db` (CriticalCorallations2026).

Current version: v11.

Full operations runbook (start/stop/check everything, incident history): [OPERATIONS.md](OPERATIONS.md).
Bootstrapping this repo on a fresh machine: [RESTART_PROJECT.md](RESTART_PROJECT.md).
This repo's place alongside its sibling algo projects, for a higher-level orchestrating
session: [ORCHESTRATOR.md](ORCHESTRATOR.md).

## Architecture

```
extract.js               Playwright scrape → geva.db (posts + lines tables)
backfill.js               Bulk historical backfill. Default = FB in-group search (real-date
                          mode). --profile = Geva's group post history; --allfeed = the plain
                          group feed + ?sorting_setting=CHRONOLOGICAL; --query overrides the
                          search string. All FB scraping surfaces cap ~40-75 posts and don't
                          reach past ~2026-06; deep history came in via manual relay instead.
parse-lines.js            Parses raw Hebrew S/R strings into price-level rows
to-csv.js                 Exports geva.db → output/geva_lines.csv
db.js                     sql.js wrapper for geva.db (upsertPost auto-parses lines)
galao-db.js               Read-only sql.js accessor for CriticalCorallations2026 galao.db
price-feed.js             Polls Yahoo Finance for MES=F / MNQ=F every 30 s
trade-builder.js          Builds bracket commands shaped for galao.db commands table
server.js                 HTTP server on :5005 — serves the dashboard
auto-geva-scheduled.ps1   Full auto-trade flow: fetch → build → submit → log. Run by the
                          GevaAutoTrade scheduled task at 10:00/12:30/15:00 CT daily.
```

The full pipeline also depends on two processes **outside this repo** that must be running
for orders to actually reach IB — see [OPERATIONS.md](OPERATIONS.md) for how to check/start them:

- **IB Gateway** (via IBC, `C:\IBC\StartGateway.bat`) — must be logged in on port 4002 (paper)
- **CC2026** `trading_dashboard.py` (port 5003) + its `broker.py` / `decider.py` subprocesses

## DB schema (geva.db)

**posts** — one row per trading day  
`date` (PK), `day`, `support`, `resistance`, `full_text`, `post_url`, `captured_at`, `source`

**lines** — parsed price levels (auto-populated by `upsertPost`)  
`sym`, `date`, `line_type` (sup/res), `price`, `strength` (`!`/`?`/empty — `parse-lines.js`
reduces compound markers like `*?!` by precedence, so `other` no longer occurs)

`source` values: `daily` (extract.js), `backfill` (backfill.js), `manual` (hand-relayed from
FB by a human, parsed + inserted directly). As of 2026-09 the dataset spans **2022-04-11 →
2026-09-03, ~157 posts** — the pre-2026-06 history is almost entirely `manual`, because every
automated FB surface caps out around ~2026-06. 46 mis-dated `backfill` rows were corrected
against Facebook's `story.creation_time` in 2026-09 (weekday-name matching alone can't catch
a real post filed under the wrong week).

## Downstream: CriticalExtraction

`C:\Projects\CriticalExtraction` reads `geva.db` (read-only, frozen snapshot) as ground truth
and tries to reproduce Geva's lines from market data. Finding (2026-09): ~55% of his daily
lines are carried forward verbatim from the prior day's post; market-geometry formulas
explain <25%. A persistence model there reproduces ~58% within 2 pt vs ~8% from scratch.

## Daily workflow

1. `node extract.js` — scrapes today's post, saves to geva.db
2. `node to-csv.js` — refreshes `output/geva_lines.csv`
3. `node server.js` — dashboard at http://localhost:5005

`run-daily.bat` runs steps 1 + 2. Task Scheduler calls it each morning.

## Dashboard tabs

| Tab | Purpose |
|-----|---------|
| Posts | Raw S/R text history |
| Lines | Parsed price levels as chips |
| Trades | Build bracket orders (MES + MNQ, configurable brackets) |
| Submitted | Live view of geva_extract commands in galao.db |
| Monitor | Open/closed P&L via galao.db |
| Auto | One-click: fetch → build → submit → monitor |

## Trade builder

- Symbols: MES (×5 $/pt) and MNQ (×2 $/pt)
- Brackets: b4, b8, b16, b32 (symmetric) + b4/16, b16/4, b8/32, b32/8 (asymmetric TP/SL)
- Toggle rule: `current >= line → LMT entry`; `current < line → STP entry`
- Orders are written to `galao.db` (`commands` table, `source='geva_extract'`)

## Integration with CriticalCorallations2026

- `galao.db` lives at `C:\Projects\CriticalCorallations2026\trader\data\galao.db`
- GevaExtract reads it via `galao-db.js` (read-only, never calls `save()`)
- The broker and decider processes in CC2026 own and execute the commands
- Status polling hits `http://localhost:5003/api/session/status` for broker/decider badges

## Facebook scraping notes

- FB no longer exposes usable timestamp metadata on posts
- Date is resolved from the Hebrew weekday name Geva writes into the post body (e.g., "יום שלישי")
- The resolved date is the most recent date ≤ anchorDate with that weekday
- Playwright uses a persistent profile in `fb-profile/` — run `node save-auth.js` once to log in
- `extract.js` accepts an optional `YYYY-MM-DD` argument to override the anchor date

## Key files

| File | Notes |
|------|-------|
| `geva.db` | Local SQLite (sql.js binary format) — not committed |
| `fb-profile/` | Playwright browser profile with saved FB session — not committed |
| `output/geva_lines.csv` | Latest CSV export — committed |
| `logs/` | `extract.log`, `backfill.log`, `auto-trade.log` — not committed |
| `pending/` | Scratch dir for in-flight trade JSON — not committed |

## Known open issue

`GET /api/today-lines` (server.js) reports `hasLines: true` whenever **any** row exists in
`geva.db`, regardless of date — it doesn't check that `date` matches today. Since
`auto-geva-scheduled.ps1` only fetches from Facebook when `hasLines` is false, it will never
re-fetch once at least one post has ever been saved, and will silently keep trading off
whatever the most recent stored post is. See [OPERATIONS.md](OPERATIONS.md) for details and
the proposed fix — not yet applied, pending confirmation since it changes live trading logic.
