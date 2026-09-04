// Parses a raw support/resistance string into individual price-level rows.
// Handles: ranges ("7532.25! - 7529.50!"), space-separated entries
// ("7664.00? 7673.50!"), parenthetical notes, and multi-char markers ("*?!").

const SYM = 'ES';

// Geva marks each level with "!" (strong) or "?" (weak), and sometimes a compound
// marker: "*?!" is a strong level sitting at the current market price, "!?" leads
// with strong. Reduce by precedence — any "!" wins, else any "?", else unmarked —
// instead of dumping every compound marker into a useless "other" bucket.
function classifyStrength(raw) {
  if (raw.includes('!')) return '!';
  if (raw.includes('?')) return '?';
  return '';
}

function parseEntryPrices(entry) {
  // Strip parenthetical notes first
  const clean = entry.replace(/\(.*?\)/g, '').trim();
  // Extract all (price)(marker) pairs — handles ranges and space-separated levels
  const results = [];
  for (const m of clean.matchAll(/([\d]+\.[\d]*|[\d]+)([!?*]*)/g)) {
    let price = parseFloat(m[1]);
    // skip noise and typo'd levels (Geva has posted "70720" for 7072.0)
    if (isNaN(price) || price < 100 || price >= 10000) continue;
    price = Math.round(price * 4) / 4; // snap to the 0.25 futures tick (fixes "6522.501")
    results.push({ price, strength: classifyStrength(m[2]) });
  }
  return results;
}

function parseLinesFromPost(post) {
  const rows = [];
  const pairs = [
    [post.support,    'sup'],
    [post.resistance, 'res'],
  ];
  for (const [raw, lineType] of pairs) {
    if (!raw) continue;
    const body = raw
      .replace(/^קווי תמיכה:\s*/,    '')
      .replace(/^קווי התנגדות:\s*/, '')
      .trim();
    for (const entry of body.split(',')) {
      for (const level of parseEntryPrices(entry)) {
        rows.push({ sym: SYM, date: post.date, line_type: lineType, ...level });
      }
    }
  }
  return rows;
}

module.exports = { parseLinesFromPost };

// Self-check: node parse-lines.js
if (require.main === module) {
  const assert = require('assert');
  const rows = parseLinesFromPost({
    date: '2026-06-30',
    support: 'קווי תמיכה: 6516.50*?! (מחיר השוק), 7085.25! - 70720, 6522.501',
    resistance: 'קווי התנגדות: 6647.25! - 6654.50, 6681.25?',
  });
  const sup = rows.filter(r => r.line_type === 'sup');
  assert.deepStrictEqual(sup.map(r => r.price), [6516.5, 7085.25, 6522.5], 'typo 70720 dropped, .501 snapped');
  assert.strictEqual(sup[0].strength, '!', '*?! -> !');
  assert.deepStrictEqual(
    rows.filter(r => r.line_type === 'res').map(r => [r.price, r.strength]),
    [[6647.25, '!'], [6654.5, ''], [6681.25, '?']],
  );
  assert.ok(!rows.some(r => r.strength === 'other'), 'no "other" strength');
  console.log('parse-lines self-check OK');
}
