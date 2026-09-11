// Export parsed S/R lines to output/geva_lines_report.csv (date|type|line|remark)
// Usage: node to-lines-csv.js
const fs   = require('fs');
const path = require('path');
const { openDb } = require('./db');

const OUTPUT_DIR = path.join(__dirname, 'output');
const CSV_PATH   = path.join(OUTPUT_DIR, 'geva_lines_report.csv');

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n|]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const db   = await openDb();
  const rows = db.getAllLines();
  db.close();

  if (!rows.length) { console.log('No lines in DB.'); return; }
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const lines = ['date|type|line|remark'];
  for (const r of rows) {
    lines.push([r.date, r.line_type, r.price, r.strength].map(csvEscape).join('|'));
  }

  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${rows.length} rows to ${CSV_PATH}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
