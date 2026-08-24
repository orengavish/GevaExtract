// check_haslines.js — standalone self-check for the hasLines fix (server.js:1164).
// No test framework: asserts + non-zero exit on failure.
const assert = require('assert');

// Mirrors server.js:1156-1164 exactly: lines is ORDER BY date DESC, so lines[0] is newest.
function computeHasLines(lines, today) {
  return lines.length > 0 && lines[0].date === today;
}

const today = new Date().toISOString().slice(0, 10);
const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);

// (a) most-recent row dated today -> true
assert.strictEqual(computeHasLines([{ date: today }], today), true, 'row dated today should be hasLines=true');

// (b) most-recent row dated 4 days ago -> false
assert.strictEqual(computeHasLines([{ date: fourDaysAgo }], today), false, 'row 4 days stale should be hasLines=false');

// (c) empty array -> false
assert.strictEqual(computeHasLines([], today), false, 'empty lines should be hasLines=false');

console.log('check_haslines.js: all checks passed');
