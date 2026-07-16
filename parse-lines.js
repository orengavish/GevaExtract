// Parses a raw support/resistance string into individual price-level rows.
// Handles: ranges ("7532.25! - 7529.50!"), space-separated entries
// ("7664.00? 7673.50!"), parenthetical notes, and multi-char markers ("*?!").

const SYM = 'ES';

const STRENGTH_MAP = {
  '!': '!',
  '?': '?',
  '':  '',
};

function classifyStrength(raw) {
  return STRENGTH_MAP[raw] ?? 'other';
}

function parseEntryPrices(entry) {
  // Strip parenthetical notes first
  const clean = entry.replace(/\(.*?\)/g, '').trim();
  // Extract all (price)(marker) pairs — handles ranges and space-separated levels
  const results = [];
  for (const m of clean.matchAll(/([\d]+\.[\d]*|[\d]+)([!?*]*)/g)) {
    const price = parseFloat(m[1]);
    if (isNaN(price) || price < 100) continue; // skip noise
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
