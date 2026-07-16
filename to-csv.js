// Export all DB rows to output/geva_lines.csv
// Usage: node to-csv.js
const fs   = require('fs');
const path = require('path');
const { openDb } = require('./db');

const OUTPUT_DIR = path.join(__dirname, 'output');
const CSV_PATH   = path.join(OUTPUT_DIR, 'geva_lines.csv');

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const db   = await openDb();
  const rows = db.getAllPosts();
  db.close();

  if (!rows.length) { console.log('No rows in DB.'); return; }
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const header = ['date', 'day', 'support', 'resistance', 'post_url', 'source'];
  const lines  = [header.join(',')];
  for (const r of rows) {
    lines.push([r.date, r.day, r.support, r.resistance, r.post_url, r.source]
      .map(csvEscape).join(','));
  }

  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${rows.length} rows to ${CSV_PATH}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
