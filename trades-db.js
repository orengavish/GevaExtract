// trades-db.js
// Read-only access to trades.db from Node.js.
// trades.db is owned/written by broker.py (Python).
// Node.js only reads here; writes go through pending/ JSON files that broker picks up.
const initSqlJs = require('sql.js');
const path      = require('path');
const fs        = require('fs');

const TRADES_DB_PATH = path.join(__dirname, 'trades.db');

let _SQL = null;
async function getSql() {
  if (!_SQL) _SQL = await initSqlJs();
  return _SQL;
}

// Opens trades.db for reading. Returns null if file doesn't exist yet.
async function readTradesDb() {
  if (!fs.existsSync(TRADES_DB_PATH)) return null;
  const SQL = await getSql();
  const db  = new SQL.Database(fs.readFileSync(TRADES_DB_PATH));

  function q(sql, params = []) {
    const res = db.exec(sql, params);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  }

  return {
    getAllCommands()              { return q('SELECT * FROM commands ORDER BY created_at DESC'); },
    getCommandsByStatus(...ss)   { return q(`SELECT * FROM commands WHERE status IN (${ss.map(()=>'?').join(',')}) ORDER BY created_at DESC`, ss); },
    getCommandsByDate(date)      { return q('SELECT * FROM commands WHERE line_date = ? ORDER BY created_at DESC', [date]); },
    getOpenCommands()            { return this.getCommandsByStatus('PENDING','SUBMITTING','SUBMITTED','FILLED'); },
    getClosedToday()             {
      const today = new Date().toISOString().slice(0, 10);
      return q("SELECT * FROM commands WHERE status='CLOSED' AND substr(exit_time,1,10)=? ORDER BY exit_time DESC", [today]);
    },
    getPriceCache()              { return q('SELECT * FROM price_cache'); },
    getPrice(sym)                { return q('SELECT price, updated_at, source FROM price_cache WHERE sym=?', [sym])[0] ?? null; },
    getSystemState(key)          { return q('SELECT value FROM system_state WHERE key=?', [key])[0]?.value ?? null; },
    close()                      { db.close(); },
  };
}

module.exports = { readTradesDb, TRADES_DB_PATH };
