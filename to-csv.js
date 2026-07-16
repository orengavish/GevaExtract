// Builds a single CSV index from every output/Geva_*.json file.
// Usage: node to-csv.js
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'output');
const CSV_PATH = path.join(OUTPUT_DIR, 'geva_lines.csv');

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function main() {
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => /^Geva_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  if (!files.length) {
    console.log('No Geva_*.json files found in output/.');
    return;
  }

  const rows = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf8'));
    return {
      date: data.date,
      day: data.day,
      support: data.support ?? '',
      resistance: data.resistance ?? '',
      post_url: data.postUrl ?? '',
      filename: f.replace(/\.json$/, '.txt'),
    };
  });

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const header = ['date', 'day', 'support', 'resistance', 'post_url', 'filename'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map(h => csvEscape(r[h])).join(','));
  }

  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${rows.length} rows to ${CSV_PATH}`);
}

main();
