# ORCHESTRATOR — GevaExtract's Companion Briefing for a Higher-Level Claude Code Session

> **Canonical whole-ecosystem version:** `CriticalCorallations2026\ORCHESTRATOR.md` is the
> full map — all sibling projects, the 8 golden rules for running multiple sessions in
> parallel, the standing known-issue table, and the coordination protocol. Read that one
> first if you're operating more than just this repo. **This file is GevaExtract's own
> entry in that map, kept here so a session that only has this repo checked out (or is
> specifically reasoning about GevaExtract's seams) doesn't have to go find the other repo
> first.** If the two ever disagree, treat CC2026's copy as authoritative and fix this one to
> match — it's the hub, this is a spoke.
>
> If you're just working *inside* GevaExtract on GevaExtract's own code, you don't need this
> file at all — read `CLAUDE.md` and `OPERATIONS.md` instead.

---

## 1. What GevaExtract is, from the outside

```
Facebook (Geva's private group)
   │  extract.js (Playwright, own fb-profile/ session)
   ▼
geva.db  (GevaExtract's own local SQLite — not shared with any sibling)
   │  trade-builder.js
   ▼
GevaExtract server.js — :5005
   │  insert-commands.py (WAL-safe write, the ONLY way this repo touches galao.db)
   ▼
galao.db  ◄── shared, owned by CriticalCorallations2026, lives at
               C:\Projects\CriticalCorallations2026\trader\data\galao.db
               (GevaExtract writes rows tagged source='geva_extract'; CC2026's
               broker.py/decider.py execute them against IB — GevaExtract never
               talks to IB Gateway directly)
```

GevaExtract is a **producer into a shared DB, not a peer trading engine.** It has no broker
loop, no position tracking, no IB socket connection of its own. Everything downstream of
`insert-commands.py` is CC2026's responsibility.

---

## 2. What an orchestrator needs to know specifically about this repo

1. **Single writer convention.** GevaExtract is the only thing in this ecosystem allowed to
   write `commands` rows tagged `source='geva_extract'`, and it only ever does so through
   `insert-commands.py` (WAL-safe). Never write to `galao.db` from GevaExtract's Node.js side
   directly — `galao-db.js` is read-only by design (never calls `.save()`), specifically so it
   can't corrupt the WAL file CC2026's broker is actively writing.

2. **Hardcoded legacy port dependency.** `server.js`'s `/api/cancel-all` calls
   `localhost:5001/api/cancel-all` (CC2026's legacy visualizer) to relay an IB
   `reqGlobalCancel`. CC2026 itself marks port 5001 "do not start" in its own docs — but
   retiring it would silently break GevaExtract's Cancel All → IB relay. Don't kill/repurpose
   port 5001 without checking this repo first (this exact trap is called out from the other
   side in `CriticalCorallations2026\ORCHESTRATOR.md` golden rule #5 — it's listed here too
   because it's this repo's dependency, not CC2026's).

3. **Facebook scraping is rate/detection-sensitive.** `extract.js` scrolls a real (or
   persistent-profile) browser session against Facebook. Don't script repeated/parallel
   `/fetch` calls or `backfill.js` runs against the same `fb-profile/` session — that's a
   good way to get the session logged out or flagged, at which point `node save-auth.js` (a
   manual, interactive step) is required to recover.

4. **Doesn't participate in the IB pacing budget directly**, but everything downstream of its
   `insert-commands.py` writes does — once CC2026's broker submits GevaExtract-originated
   orders, they count against the same account-wide 60-req/10-min IB budget documented in
   `CriticalCorallations2026\ORCHESTRATOR.md` golden rule #1. A large `Submit N` batch from
   the Trades tab (up to 32 commands per S/R level × N lines) can meaningfully add to broker
   load right after submission — be aware of what else is hitting Gateway at the same time.

5. **Own scheduled task**: `GevaAutoTrade` (10:00/12:30/15:00 CT), runs
   `auto-geva-scheduled.ps1`, which itself ensures CC2026 + IB Gateway + GevaExtract are all
   up before building/submitting. It does *not* start IB Gateway itself if Gateway is fully
   down (only checks CC2026's session status) — see `OPERATIONS.md` §2.4 and §4 for the full
   incident where this mattered.

6. **Known, currently-unfixed bug an orchestrator should not re-diagnose from scratch**:
   `GET /api/today-lines` treats *any* stored post as "current" (doesn't check the date), so
   the auto-trade scheduler has gone multiple days without re-fetching from Facebook while
   still "succeeding" (0 candidates each run). Full detail and a drafted-but-unapplied fix:
   `OPERATIONS.md` incident log. Also tracked centrally in
   `CriticalCorallations2026\ORCHESTRATOR.md` §3's known-issue table — don't fix this
   unilaterally from an orchestrator context without the sign-off `OPERATIONS.md` calls for,
   since it changes live trading-decision logic.

7. **This repo has its own instance of the "bare `python` on PATH" footgun** documented in
   `CriticalCorallations2026\ORCHESTRATOR.md` golden rule #4 — `server.js` spawns the
   `insert-commands.py` write-bridge via a bare `python` (no fully-qualified interpreter
   path), 10s timeout. If a session/shell has an unrelated interpreter shadowing `python` on
   PATH, order submission and the replenish/cancel-all endpoints fail. Same fix as
   everywhere else in this ecosystem: confirm which interpreter `python` resolves to in the
   context GevaExtract's server actually runs under before assuming it works.

8. **`geva.db` has no backup/recovery path.** Not in git, no cross-machine sync. If this
   machine is lost, the only recovery is re-scraping via `backfill.js` (itself dependent on
   Facebook not having changed its DOM/detection since). If an orchestrator is planning any
   kind of migration or machine-retirement, back this file up explicitly first.

---

## 3. Coordination notes specific to this repo

- If another session is actively running `auto-geva-scheduled.ps1` (check
  `logs\auto-trade.log` for a recent in-progress start with no matching "DONE" line yet),
  don't also trigger a manual `/fetch` or `Submit` from the dashboard at the same time —
  both paths write through the same `insert-commands.py` bridge and there's no in-repo
  locking against a concurrent double-submit.
- This repo's version number (`version.json`, shown in the dashboard header) is a local
  string like every sibling's — bumped manually, not automated. Check `git log --oneline -5`
  here directly rather than trusting a doc's claimed "current version" (same caution CC2026's
  `ORCHESTRATOR.md` gives about its own version drift).
- Git remote is `origin` → `github.com/orengavish/GevaExtract`, separate from CC2026's
  `cc2026` remote and Fetcher2026's own `origin`. A push here never affects the siblings.
