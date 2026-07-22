# GevaExtract

Scrapes Geva's daily ES S/R lines from a private Facebook group, stores them in a local SQLite DB, and serves a dashboard that lets you build and submit bracket orders to Interactive Brokers via the shared `galao.db` (CriticalCorallations2026).

Current version: v11.

## Architecture

```
extract.js          Playwright scrape → geva.db (posts + lines tables)
backfill.js         Bulk historical backfill via FB in-group search
parse-lines.js      Parses raw Hebrew S/R strings into price-level rows
to-csv.js           Exports geva.db → output/geva_lines.csv
db.js               sql.js wrapper for geva.db (upsertPost auto-parses lines)
galao-db.js         Read-only sql.js accessor for CriticalCorallations2026 galao.db
price-feed.js       Polls Yahoo Finance for MES=F / MNQ=F every 30 s
trade-builder.js    Builds bracket commands shaped for galao.db commands table
server.js           HTTP server on :5005 — serves the dashboard
```

## DB schema (geva.db)

**posts** — one row per trading day  
`date` (PK), `day`, `support`, `resistance`, `full_text`, `post_url`, `captured_at`, `source`

**lines** — parsed price levels (auto-populated by `upsertPost`)  
`sym`, `date`, `line_type` (sup/res), `price`, `strength` (!/?/other/empty)

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
| `logs/` | `extract.log`, `backfill.log` — not committed |
| `pending/` | Scratch dir for in-flight trade JSON — not committed |
