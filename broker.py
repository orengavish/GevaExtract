"""
broker.py — GevaExtract Trading Broker
Manages trades.db: picks up PENDING commands from pending/ directory,
submits bracket orders to IB paper, polls fills, replenishes on close.

Usage:
    python broker.py              # live broker (requires IB TWS paper at port 7497)
    python broker.py --dry-run    # simulate without IB
"""

import argparse
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT        = Path(__file__).parent
TRADES_DB   = ROOT / "trades.db"
PENDING_DIR = ROOT / "pending"
LOGS_DIR    = ROOT / "logs"

TICK         = 0.25
POLL_S       = 3
IB_HOST      = "127.0.0.1"
IB_PAPER_PORT = 7497
IB_CLIENT_ID  = 20   # keep different from other Galgo clients

TICK_USD = {"MES": 1.25, "MNQ": 0.50}


# ── Utilities ──────────────────────────────────────────────────────────────────

def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def log(msg):
    line = f"[{now_utc()}] {msg}"
    print(line, flush=True)
    try:
        LOGS_DIR.mkdir(exist_ok=True)
        with (LOGS_DIR / "broker.log").open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def rt(price):
    return round(round(price / TICK) * TICK, 10)


# ── Database ───────────────────────────────────────────────────────────────────

def get_db():
    TRADES_DB.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(str(TRADES_DB), timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    _init_schema(con)
    return con

def _init_schema(con):
    con.executescript("""
        CREATE TABLE IF NOT EXISTS commands (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id          TEXT,
            symbol            TEXT NOT NULL,
            line_date         TEXT,
            line_price        REAL,
            line_type         TEXT,
            strength          TEXT DEFAULT '',
            bracket_label     TEXT,
            direction         TEXT NOT NULL,
            entry_type        TEXT NOT NULL,
            entry_price       REAL NOT NULL,
            tp_price          REAL NOT NULL,
            tp_ticks          INTEGER,
            sl_price          REAL NOT NULL,
            sl_ticks          INTEGER,
            quantity          INTEGER DEFAULT 1,
            status            TEXT NOT NULL DEFAULT 'PENDING',
            ib_order_id       INTEGER,
            ib_tp_order_id    INTEGER,
            ib_sl_order_id    INTEGER,
            fill_price        REAL,
            fill_time         TEXT,
            exit_price        REAL,
            exit_time         TEXT,
            exit_reason       TEXT,
            pnl_ticks         REAL,
            parent_command_id INTEGER,
            created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            updated_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmd_status    ON commands(status);
        CREATE INDEX IF NOT EXISTS idx_cmd_group     ON commands(group_id);
        CREATE INDEX IF NOT EXISTS idx_cmd_line_date ON commands(line_date);

        CREATE TABLE IF NOT EXISTS price_cache (
            sym        TEXT PRIMARY KEY,
            price      REAL NOT NULL,
            updated_at TEXT NOT NULL,
            source     TEXT DEFAULT 'fill'
        );

        CREATE TABLE IF NOT EXISTS system_state (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
    """)
    con.commit()

def get_state(con, key, default=None):
    row = con.execute("SELECT value FROM system_state WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default

def set_state(con, key, value):
    con.execute(
        "INSERT INTO system_state(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value)
    )
    con.commit()

def cache_price(con, sym, price, source="fill"):
    con.execute(
        "INSERT INTO price_cache(sym,price,updated_at,source) VALUES(?,?,?,?) "
        "ON CONFLICT(sym) DO UPDATE SET price=excluded.price,"
        "updated_at=excluded.updated_at,source=excluded.source",
        (sym, price, now_utc(), source)
    )
    con.commit()

def get_cached_price(con, sym):
    row = con.execute("SELECT price FROM price_cache WHERE sym=?", (sym,)).fetchone()
    return float(row["price"]) if row else None


# ── Pending file pickup ────────────────────────────────────────────────────────

def pickup_pending_files(con):
    """
    Process JSON files dropped by server.js into pending/.
    submit_*.json  → list of command dicts to INSERT
    state_*.json   → { key, value } to SET in system_state
    """
    PENDING_DIR.mkdir(exist_ok=True)
    total = 0
    for f in sorted(PENDING_DIR.glob("*.json")):
        try:
            payload = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                # Submit: array of command objects
                for c in payload:
                    con.execute(
                        "INSERT INTO commands "
                        "(group_id,symbol,line_date,line_price,line_type,strength,"
                        " bracket_label,direction,entry_type,entry_price,"
                        " tp_price,tp_ticks,sl_price,sl_ticks,quantity) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (c.get("group_id"), c["symbol"], c.get("line_date"),
                         c.get("line_price"), c.get("line_type"), c.get("strength", ""),
                         c.get("bracket_label"), c["direction"], c["entry_type"],
                         c["entry_price"], c["tp_price"], c.get("tp_ticks"),
                         c["sl_price"], c.get("sl_ticks"), c.get("quantity", 1))
                    )
                con.commit()
                log(f"  Queued {len(payload)} commands from {f.name}")
                total += len(payload)
            elif isinstance(payload, dict) and "key" in payload:
                # State update: { key, value }
                set_state(con, payload["key"], payload["value"])
                log(f"  State {payload['key']} = {payload['value']}")
            f.unlink()
        except Exception as e:
            log(f"  Error reading {f.name}: {e}")
    return total


# ── Toggle rule ────────────────────────────────────────────────────────────────

def entry_type_for(direction, current_price, line_price):
    above = current_price >= line_price
    if direction == "BUY":
        return "LMT" if above else "STP"
    return "STP" if above else "LMT"

def calc_bracket(direction, e_type, line_price, tp_ticks, sl_ticks):
    tp_dist = tp_ticks * TICK
    sl_dist = sl_ticks * TICK
    if direction == "BUY" and e_type == "LMT":
        entry = rt(line_price)
    elif direction == "BUY" and e_type == "STP":
        entry = rt(line_price + TICK)
    elif direction == "SELL" and e_type == "LMT":
        entry = rt(line_price)
    else:
        entry = rt(line_price - TICK)
    tp = rt(entry + tp_dist) if direction == "BUY" else rt(entry - tp_dist)
    sl = rt(entry - sl_dist) if direction == "BUY" else rt(entry + sl_dist)
    return entry, tp, sl


# ── IB connectivity ────────────────────────────────────────────────────────────

def connect_ib():
    from ib_insync import IB
    ib = IB()
    ib.connect(IB_HOST, IB_PAPER_PORT, clientId=IB_CLIENT_ID, readonly=False)
    log(f"Connected to IB paper (port {IB_PAPER_PORT}, clientId {IB_CLIENT_ID})")
    return ib

def get_contract(ib, symbol):
    from ib_insync import Contract
    c = Contract(symbol=symbol, secType="FUT", exchange="CME", currency="USD")
    details = ib.qualifyContracts(c)
    if not details:
        raise ValueError(f"Cannot qualify contract: {symbol}")
    return details[0]

def place_bracket(ib, contract, direction, e_type, entry_price, tp_price, sl_price, qty=1):
    from ib_insync import LimitOrder, StopOrder
    exit_action = "SELL" if direction == "BUY" else "BUY"

    if e_type == "LMT":
        # Use ib_insync's built-in LMT bracket
        bracket = ib.bracketOrder(direction, qty, entry_price, tp_price, sl_price)
        trades  = [ib.placeOrder(contract, o) for o in bracket]
        ib.sleep(0.5)
        return trades[0].order.orderId, trades[1].order.orderId, trades[2].order.orderId

    # STP entry — manual bracket (ib.bracketOrder only supports LMT entry)
    entry_ord = StopOrder(direction, qty, entry_price)
    entry_ord.transmit = False
    entry_trade = ib.placeOrder(contract, entry_ord)
    ib.sleep(0.15)  # allow orderId assignment
    eid = entry_trade.order.orderId

    tp_ord = LimitOrder(exit_action, qty, tp_price)
    tp_ord.parentId = eid
    tp_ord.transmit = False
    tp_trade = ib.placeOrder(contract, tp_ord)

    sl_ord = StopOrder(exit_action, qty, sl_price)
    sl_ord.parentId = eid
    sl_ord.transmit = True  # transmits whole bracket
    sl_trade = ib.placeOrder(contract, sl_ord)
    ib.sleep(0.5)
    return eid, tp_trade.order.orderId, sl_trade.order.orderId


# ── Broker phases ──────────────────────────────────────────────────────────────

def process_pending(ib, con):
    rows = con.execute(
        "SELECT * FROM commands WHERE status='PENDING' ORDER BY created_at"
    ).fetchall()
    submitted = 0
    for cmd in rows:
        # Optimistic claim
        if not con.execute(
            "UPDATE commands SET status='SUBMITTING',updated_at=? WHERE id=? AND status='PENDING'",
            (now_utc(), cmd["id"])
        ).rowcount:
            continue
        con.commit()
        try:
            contract = get_contract(ib, cmd["symbol"])
            eid, tpid, slid = place_bracket(
                ib, contract,
                cmd["direction"], cmd["entry_type"],
                cmd["entry_price"], cmd["tp_price"], cmd["sl_price"],
                cmd["quantity"] or 1
            )
            con.execute(
                "UPDATE commands SET status='SUBMITTED',"
                "ib_order_id=?,ib_tp_order_id=?,ib_sl_order_id=?,updated_at=? WHERE id=?",
                (eid, tpid, slid, now_utc(), cmd["id"])
            )
            con.commit()
            log(f"  SUBMIT {cmd['id']} {cmd['symbol']} {cmd['direction']} "
                f"{cmd['bracket_label']} {cmd['entry_type']}@{cmd['entry_price']}")
            submitted += 1
        except Exception as e:
            con.execute("UPDATE commands SET status='ERROR',updated_at=? WHERE id=?",
                        (now_utc(), cmd["id"]))
            con.commit()
            log(f"  ERROR {cmd['id']}: {e}")
    return submitted


def poll_fills(ib, con):
    """Detect entry fills for SUBMITTED commands."""
    try:
        trades = ib.trades()
    except Exception as e:
        log(f"  poll_fills: {e}")
        return 0

    fill_map = {t.order.orderId: t.orderStatus.avgFillPrice
                for t in trades if t.orderStatus.status == "Filled"}

    rows = con.execute("SELECT * FROM commands WHERE status='SUBMITTED'").fetchall()
    n = 0
    for cmd in rows:
        if cmd["ib_order_id"] not in fill_map:
            continue
        fp = fill_map[cmd["ib_order_id"]]
        con.execute(
            "UPDATE commands SET status='FILLED',fill_price=?,fill_time=?,updated_at=? WHERE id=?",
            (fp, now_utc(), now_utc(), cmd["id"])
        )
        con.commit()
        cache_price(con, cmd["symbol"], fp)
        log(f"  FILL  {cmd['id']} {cmd['symbol']} {cmd['direction']} @ {fp}")
        n += 1
    return n


def poll_exits(ib, con):
    """Detect TP/SL fills for FILLED commands; compute P&L."""
    try:
        trades = ib.trades()
    except Exception as e:
        log(f"  poll_exits: {e}")
        return 0

    fill_map = {t.order.orderId: t.orderStatus.avgFillPrice
                for t in trades if t.orderStatus.status == "Filled"}

    rows = con.execute("SELECT * FROM commands WHERE status='FILLED'").fetchall()
    n = 0
    for cmd in rows:
        ep = None
        if cmd["ib_tp_order_id"] and cmd["ib_tp_order_id"] in fill_map:
            ep = fill_map[cmd["ib_tp_order_id"]]
        elif cmd["ib_sl_order_id"] and cmd["ib_sl_order_id"] in fill_map:
            ep = fill_map[cmd["ib_sl_order_id"]]
        if ep is None:
            continue

        fp = cmd["fill_price"]
        d  = cmd["direction"]
        tp = cmd["tp_price"]
        sl = cmd["sl_price"]

        if d == "BUY":
            reason    = "TP" if ep >= tp - TICK else ("SL" if ep <= sl + TICK else "OTHER")
            pnl_ticks = (ep - fp) / TICK
        else:
            reason    = "TP" if ep <= tp + TICK else ("SL" if ep >= sl - TICK else "OTHER")
            pnl_ticks = (fp - ep) / TICK

        pnl_ticks = round(pnl_ticks, 4)
        con.execute(
            "UPDATE commands SET status='CLOSED',"
            "exit_price=?,exit_time=?,exit_reason=?,pnl_ticks=?,updated_at=? WHERE id=?",
            (ep, now_utc(), reason, pnl_ticks, now_utc(), cmd["id"])
        )
        con.commit()
        pnl_usd = pnl_ticks * TICK_USD.get(cmd["symbol"], 1.25)
        log(f"  CLOSE {cmd['id']} {cmd['symbol']} {cmd['direction']} {reason} "
            f"pnl={pnl_ticks:+.1f}t (${pnl_usd:+.2f})")
        n += 1
    return n


def replenish(con):
    """Spawn new PENDING for each CLOSED command that has no active child."""
    if get_state(con, "REPLENISH_ENABLED", "0") != "1":
        return 0

    rows = con.execute("""
        SELECT * FROM commands
        WHERE  status = 'CLOSED'
          AND  NOT EXISTS (
              SELECT 1 FROM commands c2
              WHERE  c2.parent_command_id = commands.id
                AND  c2.status NOT IN ('CLOSED','ERROR')
          )
        ORDER BY updated_at DESC LIMIT 200
    """).fetchall()

    n = 0
    for cmd in rows:
        price = get_cached_price(con, cmd["symbol"])
        if price is None:
            continue
        e_type = entry_type_for(cmd["direction"], price, cmd["line_price"])
        entry, tp, sl = calc_bracket(cmd["direction"], e_type,
                                     cmd["line_price"], cmd["tp_ticks"], cmd["sl_ticks"])
        con.execute("""
            INSERT INTO commands
            (group_id,symbol,line_date,line_price,line_type,strength,bracket_label,
             direction,entry_type,entry_price,tp_price,tp_ticks,sl_price,sl_ticks,
             quantity,parent_command_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (cmd["group_id"], cmd["symbol"], cmd["line_date"], cmd["line_price"],
              cmd["line_type"], cmd["strength"], cmd["bracket_label"],
              cmd["direction"], e_type, entry, tp, cmd["tp_ticks"],
              sl, cmd["sl_ticks"], cmd["quantity"] or 1, cmd["id"]))
        con.commit()
        log(f"  REPLENISH {cmd['id']} → new PENDING {cmd['symbol']} "
            f"{cmd['direction']} {cmd['bracket_label']}")
        n += 1
    return n


# ── Dry-run loop ───────────────────────────────────────────────────────────────

def run_dry(con):
    log("DRY-RUN: no IB connection — simulating submissions only")
    while True:
        if get_state(con, "SESSION") == "SHUTDOWN":
            log("SHUTDOWN → exit")
            break
        pickup_pending_files(con)
        rows = con.execute("SELECT * FROM commands WHERE status='PENDING'").fetchall()
        for cmd in rows:
            if con.execute(
                "UPDATE commands SET status='SUBMITTED',ib_order_id=88888,updated_at=? "
                "WHERE id=? AND status='PENDING'", (now_utc(), cmd["id"])
            ).rowcount:
                con.commit()
                log(f"  [DRY] SUBMIT {cmd['id']} {cmd['symbol']} {cmd['direction']} "
                    f"{cmd['bracket_label']} {cmd['entry_type']}@{cmd['entry_price']}")
        time.sleep(POLL_S)


# ── Main loop ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GevaExtract IB broker")
    parser.add_argument("--dry-run", action="store_true",
                        help="Simulate without IB — process pending/, fake submissions")
    args = parser.parse_args()

    con = get_db()
    set_state(con, "SESSION", "RUNNING")
    log("=== Broker starting ===")

    if args.dry_run:
        try:
            run_dry(con)
        finally:
            set_state(con, "SESSION", "STOPPED")
        return

    try:
        ib = connect_ib()
    except Exception as e:
        log(f"IB connection failed: {e}")
        set_state(con, "SESSION", "ERROR")
        sys.exit(1)

    log("Broker loop running (Ctrl-C to stop)")
    try:
        while True:
            if get_state(con, "SESSION") == "SHUTDOWN":
                log("SHUTDOWN → exit")
                break
            pickup_pending_files(con)
            process_pending(ib, con)
            poll_fills(ib, con)
            if poll_exits(ib, con):
                replenish(con)
            time.sleep(POLL_S)
    except KeyboardInterrupt:
        log("Interrupted by user")
    finally:
        try:
            ib.disconnect()
        except Exception:
            pass
        set_state(con, "SESSION", "STOPPED")
        log("=== Broker stopped ===")


if __name__ == "__main__":
    main()
