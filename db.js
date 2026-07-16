const initSqlJs          = require('sql.js');
const path               = require('path');
const fs                 = require('fs');
const { parseLinesFromPost } = require('./parse-lines');

const DB_PATH = path.join(__dirname, 'geva.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT UNIQUE NOT NULL,
    day         TEXT,
    support     TEXT,
    resistance  TEXT,
    full_text   TEXT,
    post_url    TEXT,
    captured_at TEXT,
    source      TEXT DEFAULT 'daily'
  );
  CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date);

  CREATE TABLE IF NOT EXISTS lines (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sym       TEXT NOT NULL DEFAULT 'ES',
    date      TEXT NOT NULL,
    line_type TEXT NOT NULL,
    price     REAL NOT NULL,
    strength  TEXT NOT NULL DEFAULT '',
    UNIQUE(date, line_type, price)
  );
  CREATE INDEX IF NOT EXISTS idx_lines_date ON lines(date);
`;

let _SQL = null;
async function getSqlJs() {
  if (!_SQL) _SQL = await initSqlJs();
  return _SQL;
}

async function openDb() {
  const SQL  = await getSqlJs();
  const data = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  const db   = data ? new SQL.Database(data) : new SQL.Database();
  db.run(SCHEMA);

  return {
    upsertPost(row) {
      db.run(
        `INSERT INTO posts (date, day, support, resistance, full_text, post_url, captured_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           day = excluded.day, support = excluded.support,
           resistance = excluded.resistance, full_text = excluded.full_text,
           post_url = excluded.post_url, captured_at = excluded.captured_at,
           source = excluded.source`,
        [row.date, row.day, row.support, row.resistance,
         row.fullText, row.postUrl, row.capturedAt, row.source]
      );
      // Auto-parse lines on every post upsert
      const lines = parseLinesFromPost(row);
      // Delete old lines for this date first (in case support/resistance changed)
      db.run('DELETE FROM lines WHERE date = ?', [row.date]);
      for (const l of lines) {
        db.run(
          `INSERT OR IGNORE INTO lines (sym, date, line_type, price, strength)
           VALUES (?, ?, ?, ?, ?)`,
          [l.sym, l.date, l.line_type, l.price, l.strength]
        );
      }
    },

    postExists(date) {
      const res = db.exec('SELECT 1 FROM posts WHERE date = ?', [date]);
      return res.length > 0 && res[0].values.length > 0;
    },

    getAllPosts() {
      const res = db.exec(
        'SELECT date, day, support, resistance, full_text, post_url, captured_at, source FROM posts ORDER BY date ASC'
      );
      if (!res.length) return [];
      const { columns, values } = res[0];
      return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    },

    getAllLines() {
      const res = db.exec(
        'SELECT sym, date, line_type, price, strength FROM lines ORDER BY date DESC, line_type ASC, price ASC'
      );
      if (!res.length) return [];
      const { columns, values } = res[0];
      return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    },

    save() {
      fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDb };
