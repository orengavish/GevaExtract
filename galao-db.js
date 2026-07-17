// galao-db.js
// Read-only access to galao.db (CriticalCorallations2026 shared DB).
// Uses sql.js load-and-read pattern — never calls save(), so WAL file is safe.
const initSqlJs = require('sql.js');
const path      = require('path');
const fs        = require('fs');

const GALAO_DB = path.join(
  'C:', 'Projects', 'CriticalCorallations2026', 'trader', 'data', 'galao.db'
);

const MULTIPLIER = { MES: 5.0, MNQ: 2.0 };   // $/index-point per contract

let _SQL = null;
async function getSql() {
  if (!_SQL) _SQL = await initSqlJs();
  return _SQL;
}

async function readGalaoDb() {
  if (!fs.existsSync(GALAO_DB)) return null;
  const SQL = await getSql();
  const db  = new SQL.Database(fs.readFileSync(GALAO_DB));

  function q(sql, params = []) {
    const res = db.exec(sql, params);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  }

  const today = new Date().toISOString().slice(0, 10);

  return {
    // All Geva commands (open: not CLOSED/CANCELLED/ERROR)
    getGevaOpenCommands() {
      return q(
        "SELECT * FROM commands WHERE source='geva_extract' " +
        "AND status NOT IN ('CLOSED','CANCELLED','ERROR','RECONCILE_REQUIRED') " +
        "ORDER BY created_at DESC"
      );
    },

    // Geva commands closed today
    getGevaClosedToday() {
      return q(
        "SELECT * FROM commands WHERE source='geva_extract' AND status='CLOSED' " +
        "AND substr(exit_time,1,10)=? ORDER BY exit_time DESC",
        [today]
      );
    },

    // Status counts for all Geva commands (for overview)
    getGevaStatusCounts() {
      return q(
        "SELECT status, COUNT(*) as cnt FROM commands WHERE source='geva_extract' GROUP BY status"
      );
    },

    // Price cache (filled by broker from IB fills)
    getPrice(sym) {
      return q('SELECT last_price, updated_at, source FROM price_cache WHERE symbol=?', [sym])[0] ?? null;
    },

    // System state (REPLENISH_ENABLED etc.)
    getSystemState(key) {
      return q('SELECT value FROM system_state WHERE key=?', [key])[0]?.value ?? null;
    },

    // All Geva commands for Sub tab (source='geva_extract', newest first)
    getGevaAllCommands(limit = 200) {
      return q(
        'SELECT id, symbol, direction, entry_type, entry_price, tp_price, sl_price, ' +
        'bracket_size, line_type, line_strength, status, fill_price, updated_at, ' +
        'parent_command_id, pnl_points FROM commands WHERE source=\'geva_extract\' ' +
        'ORDER BY id DESC LIMIT ' + limit
      );
    },

    close() { db.close(); },

    MULTIPLIER,
    GALAO_DB,
  };
}

module.exports = { readGalaoDb, GALAO_DB, MULTIPLIER };
