"""
insert-commands.py — GevaExtract → galao.db write bridge
Called by server.js via child_process.spawn. Uses Python's sqlite3 so WAL is handled correctly.

Usage:
    python insert-commands.py < commands.json        # insert array of command objects
    python insert-commands.py --state KEY VALUE      # upsert a system_state row
    python insert-commands.py --cancel               # mark geva_extract PENDING/SUBMITTING/SUBMITTED → CANCELLED
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

GALAO_DB = Path(r'C:\Projects\CriticalCorallations2026\trader\data\galao.db')


def now_utc():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def get_con():
    con = sqlite3.connect(str(GALAO_DB), timeout=10)
    con.execute('PRAGMA journal_mode=WAL')
    return con


def insert_commands(cmds):
    con = get_con()
    now = now_utc()
    inserted = 0
    try:
        for c in cmds:
            con.execute(
                "INSERT INTO commands "
                "(symbol, line_price, line_type, line_strength, direction, entry_type, "
                " entry_price, tp_price, sl_price, bracket_size, source, strategy_variant, "
                " quantity, status, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,'geva_extract',?,1,'PENDING',?,?)",
                (
                    c['symbol'],
                    c['line_price'],
                    c['line_type'],       # SUPPORT | RESISTANCE
                    c['line_strength'],   # 1 | 2 | 3
                    c['direction'],       # BUY | SELL
                    c['entry_type'],      # LMT | STP
                    c['entry_price'],
                    c['tp_price'],
                    c['sl_price'],
                    c['bracket_size'],    # TP distance in points (for broker replenishment)
                    c.get('strategy_variant'),  # shared group id for one line's grid fan-out; null if absent
                    now,
                    now,
                )
            )
            inserted += 1
        con.commit()
        print(json.dumps({'ok': True, 'inserted': inserted}), flush=True)
    except Exception as e:
        con.rollback()
        print(json.dumps({'ok': False, 'error': str(e)}), flush=True)
        sys.exit(1)
    finally:
        con.close()


def cancel_geva(dry_run=False):
    con = get_con()
    now = now_utc()
    try:
        r = con.execute(
            "UPDATE commands SET status='CANCELLED', updated_at=? "
            "WHERE source='geva_extract' AND status IN ('PENDING','SUBMITTING','SUBMITTED')",
            (now,)
        )
        cancelled = r.rowcount
        con.commit()
        print(json.dumps({'ok': True, 'cancelled': cancelled}), flush=True)
    except Exception as e:
        con.rollback()
        print(json.dumps({'ok': False, 'error': str(e)}), flush=True)
        sys.exit(1)
    finally:
        con.close()


def set_state(key, value):
    con = get_con()
    try:
        con.execute(
            "INSERT INTO system_state(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET "
            "value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')",
            (key, value)
        )
        con.commit()
        print(json.dumps({'ok': True, 'key': key, 'value': value}), flush=True)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}), flush=True)
        sys.exit(1)
    finally:
        con.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='GevaExtract galao.db write bridge')
    parser.add_argument('--state', nargs=2, metavar=('KEY', 'VALUE'),
                        help='Upsert system_state row')
    parser.add_argument('--cancel', action='store_true',
                        help='Mark geva_extract PENDING/SUBMITTING/SUBMITTED → CANCELLED')
    args = parser.parse_args()

    if args.cancel:
        cancel_geva()
    elif args.state:
        set_state(args.state[0], args.state[1])
    else:
        raw = sys.stdin.read().strip()
        if not raw:
            print(json.dumps({'ok': False, 'error': 'no input'}), flush=True)
            sys.exit(1)
        insert_commands(json.loads(raw))
