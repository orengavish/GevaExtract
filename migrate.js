// One-time import of existing output/Geva_*.json files into geva.db
// Usage: node migrate.js
const fs   = require('fs');
const path = require('path');
const { openDb } = require('./db');

const OUTPUT_DIR = path.join(__dirname, 'output');

async function main() {
  const db = await openDb();

  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => /^Geva_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  let saved = 0, skipped = 0;
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf8'));
    if (db.postExists(data.date)) {
      console.log(`  Skip (already in DB): ${data.date}`);
      skipped++;
      continue;
    }
    db.upsertPost({ ...data, source: data.source ?? 'backfill' });
    console.log(`  Imported: ${data.date}`);
    saved++;
  }

  db.save();
  db.close();
  console.log(`Done: ${saved} imported, ${skipped} already existed.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
