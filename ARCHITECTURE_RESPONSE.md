# GevaExtract — Architecture Response

> Architecture-question round only. **No code was changed to produce this document.**
> Grounded in `GEVAEXTRACT_INTEGRATION_REPORT.md` (same repo, written immediately prior —
> every code claim below traces back to a specific file/function there) plus direct
> re-verification of `trade-builder.js` and `server.js` for the questions this round adds
> that the integration report didn't need to answer (statelessness, determinism,
> price-injection feasibility).

```text
PROJECT:        GevaExtract
REPO PATH:      C:\Projects\GevaExtract
ROLE:           Part C (data acquisition + candidate-order proposer for the Geva S/R strategy)
CURRENT COMMIT: 2b38078 (main, up to date with origin/main; working tree has the routinely-
                 regenerated output/geva_lines.csv plus this round's two new report files)
```

I only have Part C's role — nothing in this repo touches Fetcher2026's data pipeline, CC2026's
broker/order-lifecycle code, or a shared experiment engine directly. Parts B/D/E are for those
repos' own sessions to answer.

---

## 1. Project identity

See header block above. One clarifying point before anything else: GevaExtract is not, in
the usual sense, a "trading algorithm" alongside CC2026's critical-line/correlation
strategies. It has no directional signal of its own — it takes one human's (Geva's) manually
drawn price level and mechanically expands it into 32 bracket-order variants (8 sizes × 2
directions × 2 symbols); the market, not GevaExtract, decides which bracket eventually fills.
Its real value is **acquisition + normalization fidelity** (scraping Facebook reliably,
parsing Hebrew shorthand correctly), not signal quality. This distinction matters for where
it belongs in the target architecture — see §10 and §14.

---

## 2. Proposed responsibility (A1)

GevaExtract should own acquiring Geva's daily Hebrew support/resistance post from a specific
private Facebook group, normalizing that free text into structured, dated price levels, and
deterministically expanding a chosen price level plus a supplied current-market price into a
family of candidate bracket-order proposals. It should stop at "propose a typed candidate" —
everything about whether/how a candidate becomes a real order belongs to Execution.

### SHOULD OWN
- Facebook scraping and its anti-detection/date-resolution logic (`extract.js`, `backfill.js`)
- Hebrew text → structured price-level normalization (`parse-lines.js`)
- Its own historical archive of scraped posts/levels (`geva.db`)
- The Geva-specific bracket-expansion math (`trade-builder.js`) — this is algorithm-specific,
  not generic execution logic, and shouldn't move into a shared execution service
- Presenting per-candidate diagnostics (why N candidates were filtered/deduped) for review

### SHOULD NOT OWN
- Writing directly into another project's order-execution database (`galao.db.commands`) —
  today it does, via `insert-commands.py` (integration report §4.5) — this should become a
  call to a documented `ExecutionService` contract instead
- Toggling another project's system-wide control flag (`galao.db.system_state`,
  `REPLENISH_ENABLED`) — today `POST /api/replenish` → `insert-commands.py --state` writes
  this directly (server.js:1080-1088) — a real, previously-unflagged coupling, see §3
- Live price acquisition for execution decisions — today it polls Yahoo Finance directly
  (`price-feed.js`) and separately reads CC2026's IB-fed price cache
  (`galao-db.js:getPrice`) — should come from one shared `MarketDataService`, not two
  ad hoc paths GevaExtract maintains itself
- IB Gateway/session health polling — today `server.js` calls CC2026's dashboard status
  endpoint directly (server.js:882-892) — should come from a shared orchestrator/health
  contract, not a hardcoded sibling URL
- A general-purpose UI framework — the current 838-line inline-HTML dashboard
  (`server.js:171-838`) is a local convenience, not something the unified platform should
  try to absorb or standardize on

---

## 3. Independence / coupling analysis (A2)

| Dependency | Why it exists | Keep / replace | Proposed future contract |
|---|---|---|---|
| Hardcoded absolute path to `C:\Projects\CriticalCorallations2026\trader\data\galao.db` (`galao-db.js:8-10`, `insert-commands.py:17`) | Read live IB price + write candidate orders | **Replace** | No direct path anywhere in GevaExtract; go through service contracts below |
| Direct `INSERT INTO commands` (`insert-commands.py:36-56`) | The only way to propose an order today | **Replace** | `ExecutionService.submit_trade_intent(TradeIntent) -> Ack` |
| Direct `UPDATE`/`INSERT` on `system_state` (`insert-commands.py:88-103`, called by `server.js:1080-1088`) | Toggle CC2026's replenish flag from GevaExtract's UI | **Replace** | `ExecutionService.set_control_flag('REPLENISH_ENABLED', bool)` — or better, this flag probably shouldn't be settable from a data-proposer at all; see §11 |
| Read-only queries against `galao.db.commands`/`price_cache` (`galao-db.js:36-93`) | Dedup against live orders, get IB price, show P&L | **Replace** (dedup, price), **partially keep concept** (P&L display) | `ExecutionService.get_open_intents(source)`, `MarketDataService.get_price(symbol)`, `ExecutionService.get_status(source)` |
| `localhost:5003/api/session/status` (CC2026 dashboard) | Status-bar badge | **Replace** | A generic orchestrator/health contract, not a hardcoded port |
| `localhost:5001/api/cancel-all` (CC2026 legacy visualizer, server.js:1090-1123) | Cancel-All → IB `reqGlobalCancel` relay | **Replace** | `ExecutionService.cancel_all(source='geva_extract')` — currently this hard dependency isn't even owned cleanly by CC2026 itself (its own docs mark port 5001 "do not start") — a pre-existing footgun, not something GevaExtract should keep propping up |
| Yahoo Finance direct poll (`price-feed.js`) | Fallback price source | **Replace, or demote to MarketDataService's own internal fallback** | `MarketDataService.get_price(symbol) -> {price, ts, source}` — one shared price source for all siblings, not each maintaining its own Yahoo fallback independently |
| Bare `python` subprocess spawn (`server.js:862`) | Invoke the write bridge | **Removed entirely once the write bridge is replaced by an API call** | N/A |
| No ports/config/shared state beyond the above — GevaExtract owns its own :5005 outright | — | — | — |

---

## 4. KEEP / WRAP / REWORK / RESEARCH / ARCHIVE for the new architecture (A3)

Restates the integration report's §5 classification, recontextualized for the target
platform boundary specifically (not just "is this code good" but "does this belong inside
the future GevaExtract plugin at all"):

| Component | Classification | Why | Future interface |
|---|---|---|---|
| `extract.js`, `backfill.js`, `save-auth.js` | **KEEP AS-IS** | Hard-won anti-scraping/date-resolution logic, no known bugs, not reproducible-by-mock (see §12 risk) | Wrapped as a callable data-acquisition function, internals untouched |
| `parse-lines.js` | **KEEP AS-IS** | Small, pure, handles real observed edge cases | Same, exported as a normalization function |
| `db.js` (schema + upsert semantics) | **KEEP** (schema/semantics), **WRAP** (storage engine) | Correct dedup/idempotency; the sql.js whole-file load/save pattern is a scale concern, not a correctness one | Same public shape, swappable backend later |
| `trade-builder.js` | **KEEP AS-IS** | Pure functions, already the right shape for reuse (see §10.4-10.5) — this is the actual "algorithm plugin" core | `AlgorithmPlugin.run()`, see §10 |
| The double sanity filter (`server.js:958-973,1007-1014`) | **KEEP the logic, REWORK its location** | Load-bearing, must not be lost — but whether it belongs in GevaExtract, in Execution's intake, or both is an open question, see §11 Q2 and §14 | See §11 |
| `galao-db.js`, `insert-commands.py` | **REWORK** | Correct today, but exactly the direct-coupling this round's Golden Rule 1 asks to remove | Replaced by `MarketDataService`/`ExecutionService` clients |
| `server.js`'s HTTP router + inline-HTML dashboard (`server.js:171-838,1141-1231`) | **ARCHIVE** (for the unified platform's UI purposes), **KEEP** (as GevaExtract's own standalone dev/ops tool, unchanged) | Not unreliable, just not something a larger platform should standardize on; still useful locally | N/A — stays a local tool, not a platform component |
| `GET /api/today-lines` staleness logic (server.js:1156-1173) | **REWORK** | Known live bug (integration report §5/§9), independent of this migration — worth fixing on its own timeline with sign-off, not bundled into architecture migration | N/A |
| `_group_id`/`_bracket` metadata (computed, currently discarded, `server.js:1018-1029`) | **RESEARCH-ADJACENT gap, not a classification of code** — this is a missing capability, not existing code to classify | Should become part of the `TradeIntent` contract instead of being dropped (§10.8) |
| Nothing in this repo qualifies for **RESEARCH ONLY** | — | GevaExtract makes no profitability claim about anything — the bracket math is mechanical order construction, not a strategy being evaluated for edge. (CC2026's actual strategies are what Part D/E's RESEARCH ONLY classification applies to.) | — |

---

## 5. Proposed public contracts (A4)

Derived from what already exists as functions/objects in the code, not invented:

```text
fetch_latest_post(anchor_date: date | None) -> PostResult | Error
  side effects: writes to GevaExtract's own geva.db only
  sync/async: long-running (10-60s browser automation) — should be invoked as an async
              job with a result callback/poll, not a blocking call
  idempotent: yes (date-keyed upsert)
  = extract.js's main() body, minus process.exit()/CLI framing

get_lines(date: date | None, symbol: str = 'ES') -> LineLevel[]
  read-only, sync, trivially idempotent
  = db.js's getAllLines(), needs a date filter param added (doesn't exist today)

get_available_range() -> {earliest: date, latest: date}
  read-only, sync
  = does NOT exist today, trivial MIN/MAX addition over posts.date

propose_trade_intents(lines: LineLevel[], market_prices: {MES: float, MNQ: float},
                       params: GevaParams) -> TradeIntent[]
  pure function, sync, no side effects, deterministic except one cosmetic UUID (§10.12)
  = trade-builder.js's buildOrdersForLevel() + server.js's sanity/dedup filtering
    (server.js:900-986), currently entangled with HTTP req/res — the entanglement is the
    only thing needing removal, not the logic itself
```

See §10 for the Geva-specific `AlgorithmPlugin`/`GevaParams`/`GevaResult` schemas this round
also asks for — those are a more detailed version of `propose_trade_intents` above, framed
for the Experiment Engine's registry rather than as a standalone API.

---

## 6. Data ownership (A5)

| Asset | Current owner | Current readers | Current writers | Proposed future owner |
|---|---|---|---|---|
| `geva.db` (`posts`, `lines`) | GevaExtract | GevaExtract only | GevaExtract only | **Unchanged** — this is GevaExtract's own domain data, no reason to move it |
| `galao.db.commands` rows tagged `source='geva_extract'` | CriticalCorallations2026 | CC2026 broker/decider (all rows), GevaExtract (read, filtered to its own tag, for dedup/display) | CC2026's decider (other sources), **GevaExtract (writes its own via `insert-commands.py`)** | **CC2026/Execution exclusively.** GevaExtract should stop writing rows directly — submit `TradeIntent`s through `ExecutionService` instead |
| `galao.db.price_cache` | CC2026 (fed by broker from IB fills) | GevaExtract (read), CC2026 | CC2026 broker only | Execution/`MarketDataService` |
| `galao.db.system_state` (`REPLENISH_ENABLED`) | CC2026 | GevaExtract (read+**write**) | CC2026, **GevaExtract** | Should move fully to Execution's own control surface — GevaExtract currently has unilateral write access to a CC2026-wide flag, which is a real coupling smell worth the architect's attention (§14) |
| `fb-profile/` (Facebook session) | GevaExtract | GevaExtract only | GevaExtract only | **Unchanged**, inherently GevaExtract's own credential |
| `output/*.json`, `output/*.csv` | GevaExtract | GevaExtract, git history | GevaExtract | **Unchanged** |

The one asset "currently living physically inside another repo" that this round's framing
specifically asks about: **none of GevaExtract's own data lives inside CC2026** — the
coupling runs the other direction (GevaExtract writes into CC2026's DB). That asymmetry is
exactly why §3's replace-list is all one-directional.

---

## 7. Failure boundaries (A6)

If GevaExtract fails/is down entirely:

- **Fetcher2026**: unaffected — no dependency in either direction today.
- **CC2026's experiments/backtest engine**: unaffected — no dependency.
- **Paper/live execution (CC2026's broker.py)**: unaffected for anything already
  submitted — confirmed by code, `broker.py` (per the CC2026 integration report from this
  same round) polls `galao.db` directly, not GevaExtract's process. Only effect: no *new*
  `source='geva_extract'` candidates get proposed while GevaExtract is down. Existing open
  Geva-sourced orders continue to be managed normally.
- **CC2026's dashboard**: unaffected — the status-check relationship is GevaExtract polling
  CC2026, never the reverse.
- **IB Gateway**: unaffected — no relationship at all.
- **Stored state**: `geva.db` simply stops advancing (last successful scrape stays as
  current); `galao.db` is untouched.

**This is already a well-isolated failure boundary** — the only real leak is the
`system_state` write (§6) and the port-5001 cancel-all relay (§3), both flagged for removal.
Once those two are gone, GevaExtract failing has **zero** effect on anything outside itself.

---

## 8. Migration strategy (A7)

Staged, each step additive/reversible until the explicit cutover step:

1. **Wrap** (reversible, no behavior change): export `extract.js`/`backfill.js`/
   `parse-lines.js`/`trade-builder.js`'s internals as library functions per §5, with the
   current CLI/HTTP entry points becoming thin callers of the same code. No external
   behavior changes.
2. **Golden fixtures + regression tests** (reversible, additive): the 6 committed
   `output/Geva_*.json` snapshots become input fixtures; capture the exact current
   `handleTradesCreate`/`handleSubmitCommands` output for a few known (post, price) pairs as
   golden output. This must happen *before* touching the sanity-filter or price-injection
   code (§10.5), per this round's "contract before migration" rule.
3. **Introduce a client abstraction** (reversible, additive): wrap today's `galao-db.js`/
   `insert-commands.py` calls behind an internal `ExecutionServiceClient`/
   `MarketDataServiceClient` interface that, for now, still talks to the real `galao.db`
   underneath — isolates the coupling to one module instead of scattering it, with zero
   external behavior change yet.
4. **Shadow run** once real `ExecutionService`/`MarketDataService` implementations exist
   elsewhere: emit `TradeIntent`s to both the legacy direct-DB path and the new service in
   parallel for a period, diff the outputs.
5. **Switch consumer**: point `propose_trade_intents`'s output solely at the new
   `ExecutionService`; retire the direct `galao.db` write path from GevaExtract's code
   entirely (the underlying `commands` table itself remains CC2026's problem, not
   GevaExtract's, from this point on).
6. **Remove the hardcoded CC2026 path constants** from `galao-db.js`/`insert-commands.py` (or
   delete those two files outright once nothing calls them).
7. **Only after 1-6 are stable**: consider whether the raw-HTML dashboard gets replaced by a
   unified platform UI — explicitly an "after parity" improvement (§9), not bundled into the
   above.

Steps 1-3 are fully reversible (nothing removed, only added/wrapped). Step 4 is
observation-only. Steps 5-6 are the actual cutover and should only happen once step 4's
shadow comparison shows matching output for a representative period.

---

## 9. DO NOT LOSE list (A8)

The ten most important mechanisms a careless rewrite could silently drop — full detail and
code references in `GEVAEXTRACT_INTEGRATION_REPORT.md` §7, condensed here:

1. **The double sanity filter** (`MIN_ENTRY_TICKS=8`, server.js:898,958-973,1007-1014) —
   checked once at build time, again at submit time. The single most important item on this
   list; see §11 Q2 for where it should live going forward.
2. **Three-tier post-date resolution**: weekday-name (primary) → DOM metadata (secondary
   cross-check only, never overrides) → anchor-date fallback (extract.js:36-43,162-199,
   289-294).
3. **Invisible-Unicode stripping** (`clean()`, extract.js:60-75) — defeats Facebook's
   anti-scraping character injection; losing it causes silent, hard-to-diagnose intermittent
   match failures, not a crash.
4. **Session-death detection** (`login`/`checkpoint` URL guard, extract.js:270-273,
   backfill.js:121-124) — clean exit instead of scraping/saving a login page as if it were
   real data.
5. **Three independent, purpose-specific dedup mechanisms** (posts upsert, lines
   `INSERT OR IGNORE` + delete-then-reinsert, `activeKeys` Set against live orders,
   db.js:47-70, server.js:946-955) — each keys on a different tuple; collapsing into one
   generic dedup risks losing the specific guarantee each one provides.
6. **`fetchRunning` in-memory mutex** (server.js:841-842) — prevents two concurrent scrapes
   from racing `geva.db`'s whole-file save.
7. **Anti-detection scroll pacing** (2800ms, two-phase scroll, extract.js:120-123) — "speeding
   this up" risks the Facebook session getting flagged/logged out.
8. **Layered, individually-tuned timeouts** on every external call (45s/180s/10s/2s/8s/5s,
   full list in integration report §7 item 8) — not arbitrary, each likely tuned against a
   real observed hang.
9. **Idempotent upsert as the sole incremental-fetch mechanism** (`ON CONFLICT DO UPDATE`,
   db.js:47-58) — there is no separate checkpoint; the DB constraint *is* the mechanism.
10. **Graceful missing-data handling throughout** (`support`/`resistance` independently
    nullable, `expandSeeMore` best-effort, `postUrl` 4-pattern fallback) — a rewrite that
    makes any of these "required" will start hard-failing on days where Geva's post is
    slightly different in structure, which happens.

---

## 10. Role-specific answers — Part C (GevaExtract)

**C1 — Core intellectual/algorithmic value.** Not a proprietary trading signal. The value is
**acquisition + normalization fidelity**: reliably scraping one specific human's daily
judgment out of an adversarial platform (Facebook, with active anti-scraping measures and
deliberately unreliable metadata), and faithfully parsing Hebrew trader shorthand (including
an observed `'other'` strength category, ranges, compound entries) into structured numeric
data without loss of the numeric content. The bracket-expansion math downstream of that is
comparatively generic order-construction, not a differentiated "algorithm."

**C2 — Split by concern:**
- *Data acquisition*: `extract.js`, `backfill.js`, `save-auth.js`
- *Feature extraction/normalization*: `parse-lines.js`
- *Signal logic*: `trade-builder.js`'s `buildOrdersForLevel`/`entryType`/`calcPrices` — the
  closest thing to "the algorithm," though it's an exhaustive bracket expansion around a
  given level, not a directional signal
- *Parameter/configuration*: `BRACKETS`, `MIN_ENTRY_TICKS`, `MULTIPLIER`, `minStrength` —
  currently a mix of hardcoded constants and loose request-body fields, not a typed schema
- *Execution bridge*: `insert-commands.py`, `galao-db.js`, `server.js`'s
  `handleSubmitCommands`/`handleTradesCreate`
- *Visualization*: `server.js`'s `buildHtml()` and the whole dashboard tab set

**C3 — What survives in the future plugin:** data acquisition + normalization + signal logic
survive as the plugin's core, near-verbatim. Parameter/configuration survives but should
become a typed `GevaParams` object (§10.6-10.8). Execution bridge does **not** survive as-is
— replaced by `TradeIntent` emission to `ExecutionService`. Visualization does not belong in
the plugin at all — it's a platform UI concern.

**C4 — Can it run on historical Fetcher datasets instead of live prices?** Yes, and this is
easier than it might look: `buildOrdersForLevel()`/`entryType()`/`calcPrices()` are **already
pure functions of a supplied `currentPrice` scalar** (trade-builder.js:36-54) — they have no
internal knowledge of *where* that price came from. The live-only coupling is entirely in
`server.js`'s `handleTradesCreate` wrapper, which happens to fetch that price from Yahoo/
`galao-db.js` today (server.js:914-931). Swap that one call site for a historical price
lookup (any Fetcher2026 bar at a given timestamp) and the algorithm runs unchanged.

**C5 — What changes are required, without changing semantics:** exactly one seam —
extract `handleTradesCreate`'s price acquisition into an injected parameter instead of an
internally-fetched value. No change needed to `trade-builder.js`, `parse-lines.js`, or
`geva.db` — they're already price-source-agnostic. New (small, additive) capability needed on
Fetcher2026's side: "market price for symbol X at time T," which doesn't exist as a query
today (see §11 Q6).

**C6 — All algorithm parameters, including hardcoded:**

| Parameter | Where | Current value | Configurable today? |
|---|---|---|---|
| `BRACKETS` (8 TP/SL combos) | trade-builder.js:15-24 | b4,b8,b16,b32,b4/16,b16/4,b8/32,b32/8 | Selectable subset via API request; the *set itself* is hardcoded |
| `TICK` | trade-builder.js:12 | 0.25 | No |
| `MULTIPLIER.MES`/`MNQ` | trade-builder.js:13 | 5.0 / 2.0 | No |
| `STRENGTH_MAP` (strength → int) | trade-builder.js:27 | `!`→1, ``→2, `?`→3, other→2 | No |
| `MIN_ENTRY_TICKS` (sanity filter) | server.js:898 | 8 (2.0 pts) | No — not exposed to the API at all |
| `minStrength` | server.js:903 | request param, default 1 | Yes |
| `symbols` | server.js:901 | request param, default `['MES','MNQ']` | Yes |
| `brackets` | server.js:902 | request param, default = all | Yes |
| `quantity` per order | insert-commands.py:39 | hardcoded `1` | No — not exposed anywhere |
| `MAX_SCROLLS`/`SCROLL_PAUSE_MS` (acquisition pacing, not a trading param) | extract.js:15-16 | 40 / 2800ms | No |
| Price noise floor | parse-lines.js:24 | 100 | No |

**C7 — Generic `run algorithm on dataset with parameter set` shape:**
Input: `dataset = {geva_lines: LineLevel[], market_prices: {MES, MNQ}}`;
`parameter_set = GevaParams` (§10.6 table, formalized).
Output: `{candidates: TradeIntent[], diagnostics: {total, passed, sanity_filtered, deduped}}`
— this is exactly `handleTradesCreate`'s current return shape (server.js:976-985), just
reframed as a pure function instead of an HTTP handler.

**C8 — Can it produce normalized SIGNAL/TRADE-INTENT objects instead of writing CC2026's
table directly?** Yes — it already does, transiently. `buildOrdersForLevel()` constructs
exactly this object in memory (`trade-builder.js:72-109`), *including* `_group_id`,
`_bracket`, `_line_date` — richer than what actually gets persisted. `server.js`'s `clean()`
mapping (server.js:1018-1029) is what currently throws that context away before the
`galao.db` insert. Not writing that table directly, and instead handing this already-existing
object to `ExecutionService.submit_trade_intent()`, is a small, low-risk change — the object
just needs to stop being immediately collapsed.

**C9 — What does the current execution bridge add that must not be lost?** The double sanity
filter and the `activeKeys` live-order dedup (server.js:946-973,1007-1014) — both are
correctness/safety checks, not incidental plumbing. Where they should live going forward
(GevaExtract, centrally in Execution, or both) is an open question — see §11 Q2, §14.

**C10 — Running thousands of parameter configs without IB/live execution:** Already
mechanically straightforward, given C4/C11: `buildOrdersForLevel` needs no IB connection, no
server, no network — just `geva.db`'s stored lines (already historical) × a matrix of
`{brackets, minStrength, minEntryTicks}` × a historical price series from Fetcher2026. This
is a batch loop over already-pure functions, not new algorithmic work.

**C11 — State needed between observations:** Essentially none. `buildOrdersForLevel` is
fully stateless per call. The only cross-call "state" is `geva.db`'s persistent archive
(not runtime state) and the `activeKeys` dedup set, which is *queried fresh* from external
state (currently `galao.db`, future `ExecutionService`) each time rather than maintained
internally. This statelessness is a genuine asset for parallel batch experimentation.

**C12 — Deterministic given identical input?** Yes, for everything in `trade-builder.js` —
pure arithmetic, no randomness — **except** `_group_id = randomUUID()`
(trade-builder.js:59), a cosmetic correlation ID with zero effect on order economics. Two
identical runs produce economically identical `TradeIntent`s with different `group_id`
values. If the Experiment Engine's reproducibility/hashing scheme cares about this, either
make `group_id` deterministic (e.g. hash of `date + line_price + line_type`) or exclude it
from equality checks — flagged as a decision point in §11 Q9. The *upstream* scrape
(`extract.js`) is inherently non-deterministic/non-replayable (live Facebook state at scrape
time) — but everything downstream of a stored `geva.db` row is fully deterministic.

**C13 — What should be stored for diagnosis, not just P&L?** The `{total, passed,
sanityFiltered, deduped}` breakdown is already computed (server.js:975-985) but only
returned to the immediate HTTP caller, never persisted — worth storing per-run so "why did
today only produce 3 candidates" is answerable later. Currently a real gap: even the counts
aren't kept, and the *specific* filtered/deduped candidates (not just counts) aren't recorded
at all.

**C14 — What coupling currently prevents Geva from being a reusable plugin?** The
internally-fetched price in `handleTradesCreate` (C5), the direct `galao.db` write path, the
hardcoded CC2026 absolute path, and the lack of a typed `GevaParams` object (today: loose
request-body fields with inline defaults scattered across `server.js`).

**C15 — What should stay independent rather than be copied into the Experiment Engine?**
`extract.js`/`backfill.js`/`save-auth.js` (Facebook-specific data acquisition) and
`parse-lines.js` (Hebrew-specific normalization) — both are domain-specific to this one data
source. The Experiment Engine should consume GevaExtract's *output* (stored lines) as an
input dataset, not reimplement or absorb the scraping/parsing itself.

### Proposed contracts

```text
AlgorithmPlugin (Geva instance):
  id:      'geva_sr_bracket'
  version: string   # bump when trade-builder.js's math changes
  get_required_dataset_spec() -> {source: 'geva_lines', date_range}
  run(dataset: GevaDataset, params: GevaParams) -> GevaResult
  # stateless (C11), deterministic modulo group_id (C12)

GevaParams:
  brackets:         string[]   # subset of the 8 canonical labels, currently hardcoded set
  symbols:           string[]   # subset of ['MES','MNQ']
  min_strength:      1 | 2 | 3
  min_entry_ticks:    number     # sanity filter distance — NOT exposed as a param today (C6)
  quantity:           number     # per-order size — hardcoded to 1 today (C6)

GevaDataset:
  geva_lines:      LineLevel[]           # {sym, date, line_type, price, strength}
  market_prices:   {MES: number, MNQ: number, as_of: timestamp}   # injected, not fetched internally (C4-C5)

GevaResult:
  candidates:    TradeIntent[]   # symbol, line_price, line_type, line_strength, direction,
                                  # entry_type, entry_price, tp_price, sl_price, bracket_size,
                                  # group_id (now KEPT, not discarded — C8), bracket_label,
                                  # line_date, source_algorithm: 'geva_sr_bracket'
  diagnostics:   {total, passed, sanity_filtered, deduped}   # persisted, not just returned (C13)
```

---

## 11. Questions/requirements for sibling projects (Part F)

```text
TO EXECUTION (CriticalCorallations2026):

Q1. Can ExecutionService.submit_trade_intent() accept a batch tagged with a shared group_id
    and preserve that grouping post-submission? Today it's computed then discarded
    (integration report §4.5) — I want "which orders came from the same Geva line" to survive.

Q2. Should the market-distance sanity check (today: MIN_ENTRY_TICKS=8 ticks, checked twice in
    my own code) live centrally in your intake, so every proposer (Geva, critical-line,
    correlation) gets it for free with a consistent threshold — or does each proposer keep
    owning its own? If centralized, what's the contract for a rejected-as-unsafe intent
    (hard reject / auto-adjust / flag-and-hold)?

Q3. Can I read/set REPLENISH_ENABLED (or its future equivalent) through a real API instead of
    writing directly into your system_state table? I currently have unilateral write access
    to a platform-wide flag that isn't really mine to own.

Q4. What does your contract return when an intent is rejected/deduped, so my dashboard can
    show *why* without querying galao.db directly?

Q5. Is per-order quantity going to be configurable, or fixed at 1 contract platform-wide? I
    have no way to express "size 2" today even if I wanted to.

TO FETCHER2026:

Q6. Can I request "market price for symbol X at time T" (not just latest), so my bracket
    algorithm — already a pure function of a supplied current price — can run against
    historical data for backtesting without any new logic on my side?

Q7. If my live auto-trade flow needs two price reads (build time, then submit time, possibly
    minutes apart, for the double sanity filter), what's the latency/availability contract I
    should design against?

TO THE EXPERIMENT ENGINE:

Q8. My algorithm has effectively zero internal state between calls (§10 C11) — does
    AlgorithmPlugin assume statefulness by default, or is there an explicit "stateless"
    category that skips whatever state-management machinery stateful algorithms need?

Q9. My only non-determinism is a cosmetic UUID with zero effect on trade economics (§10 C12)
    — does your reproducibility/hashing scheme need me to make it deterministic, or can it be
    excluded from equality/hash checks?

Q10. Geva posts are daily and manually-authored, not a continuous algorithmic signal — how
     should "one candidate-order family per human-authored price level per day" fit a schema
     presumably designed around more continuous signal generation?

TO THE ORCHESTRATOR / GENERAL:

Q11. If I stop writing to galao.db directly, who inherits the Cancel-All → IB
     reqGlobalCancel relay I currently hit at CC2026's legacy port 5001 (a port CC2026's own
     docs already say shouldn't be running)?

Q12. Should Facebook credential/session management (a permanently manual, human,
     per-machine step — cannot be scripted or included in any CI/reproducible pipeline) get
     a documented platform-level "external, human-only credential" category, so this doesn't
     get assumed-away by later automation work?

Q13. Does the Algorithm Registry actually want GevaExtract classified as a peer "algorithm"
     next to critical-line/correlation strategies, or as a distinct "data acquisition +
     intent proposer" category? I don't have a directional signal of my own — see §1 and §14.
```

---

## 12. Risks / disagreements (Part G)

1. **I disagree with treating GevaExtract as a peer "algorithm" for comparison purposes.**
   The proposed pipeline (`Algorithms → Experiment Engine → Results → Feedback → Promotion`)
   implies something with a directional signal worth backtesting/scoring against others.
   Geva's bracket expansion has no directional opinion — the market picks which of 32
   brackets fills. Running it through the same "is this a good algorithm" evaluation
   machinery as CC2026's actual strategies may be a category error. I'd propose a distinct
   "intent proposer" category, but this is genuinely the central architect's call (§14).

2. **Golden Rule 1 (maximum independence, no direct writes into another component's private
   storage) directly conflicts with today's reality** — GevaExtract writes into CC2026's
   `galao.db.commands` *and* `system_state` right now. Fixing this is correct, but it's a
   real migration dependent on `ExecutionService` existing first (§8) — sequencing risk:
   don't strand GevaExtract's live auto-trade flow between "old path removed" and "new path
   not ready yet."

3. **A mechanism that maximum independence could weaken**: the double sanity filter's second
   check exists specifically because of a short, synchronous gap between build and submit
   (server.js:1007-1014's own comment: *"market may have moved since build was called"*). If
   `TradeIntent` submission becomes async/queued through a service boundary, that gap could
   grow much larger than today's few-seconds-to-minutes window. Recommend Execution's own
   intake perform an independent freshness check regardless of what GevaExtract's proposer
   does — don't rely on my timestamp being recent by the time you actually act on it.

4. **Performance**: no real concern at GevaExtract's current data volume (hundreds of posts,
   tens of thousands of order candidates total). The sql.js whole-file load/save pattern is
   a future-scale concern, not a current one.

5. **Reliability concern specific to "independently testable" (Golden Rule 1)**: Facebook
   scraping's live DOM state can't be mocked/versioned the way a normal API can. Golden
   fixtures (§8 step 2) can fully cover `parse-lines.js`, but `extract.js`'s selector-matching
   logic itself can only be regression-tested against either live Facebook or recorded raw
   HTML snapshots (which don't currently exist — only parsed JSON is saved). Recommend
   starting to capture raw HTML snapshots going forward specifically to enable this.

6. **Migration risk**: `save-auth.js`'s human-interactive login is irreducibly manual — no
   staged migration plan makes this scriptable. Any assumption that a fresh environment "just
   works" end-to-end will always hit this one step. Flagging explicitly so it isn't
   assumed-away.

7. **Unresolved, not mine to decide**: should there be one shared `MarketDataService` all
   three siblings (plus CC2026's own broker) consume, replacing GevaExtract's independent
   Yahoo-Finance-plus-galao.db-price-cache dual-sourcing? Clearly correct directionally, but
   touches Fetcher2026 and CC2026 both — see §14.

---

## 13. Recommended architecture decisions

Concrete recommendations I'd make from GevaExtract's side, not just open questions:

- Inject market prices into the trade-building call rather than fetching them internally
  (§10 C5) — small, low-risk, and is the one change that also unlocks historical/backtest
  usage of the same algorithm (§10 C4, C10) essentially for free.
- Stop discarding `_group_id`/`_bracket`/`_line_date` before persistence (§10 C8) — keep them
  as first-class `TradeIntent` fields. Trivial change, closes a real analysis gap.
- Formalize `GevaParams` as a typed object (§10.6, §10's contract block) instead of loose
  request-body fields with inline defaults — needed regardless of the rest of this migration.
- Treat `save-auth.js`'s manual login as a permanently-documented "external, human-only
  credential" category (§12 risk 6, §11 Q12) rather than something automation will eventually
  swallow.
- Capture raw HTML snapshots alongside parsed JSON going forward (§12 risk 5) to make
  `extract.js` itself regression-testable, not just `parse-lines.js`.
- Keep `extract.js`/`backfill.js`/`parse-lines.js` physically in a GevaExtract-owned module
  regardless of how the rest of the platform is organized (§10 C15) — no reason to generalize
  Facebook-specific/Hebrew-specific code.

---

## 14. Open decisions requiring the central architect

- **Does GevaExtract belong in the Algorithm Registry as a peer strategy, or in a distinct
  "data acquisition / intent proposer" category?** (§1, §12 risk 1, §11 Q13) — affects how
  it's evaluated and whether "no algorithm is assumed profitable" (Golden Rule 3) even
  applies to it the same way, given it has no signal of its own to be profitable or not.
- **Where does the sanity-distance-from-market check ultimately live** — per-proposer
  (as today), centrally in Execution's intake, or both? (§11 Q2, §12 risk 3)
- **Should there be one shared `MarketDataService`** consumed by GevaExtract, Fetcher2026,
  and CC2026's broker alike, replacing each project's own independent price-sourcing?
  (§12 risk 7) — cross-cutting, not GevaExtract's call alone.
- **Who owns `REPLENISH_ENABLED`-style control flags** going forward, and through what API?
  (§6, §11 Q3)
- **Who inherits the port-5001 Cancel-All relay** once GevaExtract stops writing to
  `galao.db` directly? (§11 Q11) — currently nobody's problem cleanly; CC2026's own docs
  already disclaim that port.
- **Should per-order `quantity` become a real platform-wide configurable**, given it's
  hardcoded to `1` in GevaExtract's write path today with no way to express otherwise?
  (§10 C6, §11 Q5)

---

# MESSAGE TO CENTRAL ARCHITECT

GevaExtract's real value is narrow and specific: reliable Facebook scraping under real
anti-bot friction, and faithful Hebrew-text-to-price-level parsing. Both should move into the
new platform essentially unchanged (KEEP), wrapped as callable functions rather than a
CLI/HTTP-only script.

**Important reframing**: GevaExtract is not a trading algorithm with a directional signal —
it mechanically expands one human's manually-drawn price level into 32 bracket variants and
lets the market pick which fills. I'd recommend it not be evaluated through the same
Algorithm Registry / backtesting-comparison machinery as CC2026's actual strategies, but this
is your call, not mine — see open decision #1.

**Concrete, low-risk win available now**: `trade-builder.js`'s order math is already a pure
function of a supplied current price — it doesn't fetch prices itself. One small change
(inject the price instead of fetching it inside `server.js`) makes this algorithm runnable
against Fetcher2026's historical data for backtesting, essentially for free.

**Must not be lost**: the double sanity filter (2-point minimum distance from market, checked
twice) — the only guard against a proposed order behaving like a market order. No test covers
it today. If submission becomes async through a service boundary, the gap this filter guards
against could widen — Execution's own intake should do its own freshness check too, not trust
mine.

**Real, currently-unflagged coupling**: GevaExtract has unilateral write access to CC2026's
`system_state` table (`REPLENISH_ENABLED`) and its own hardcoded direct-write path into
`galao.db.commands`. Both need to go through a real `ExecutionService` contract — sequence
this migration so GevaExtract's live auto-trade flow is never stranded between the old and
new paths.

**Irreducibly manual, don't plan around it disappearing**: Facebook login (`save-auth.js`)
requires a human, every time the session expires, on every machine. No migration plan makes
this scriptable.
