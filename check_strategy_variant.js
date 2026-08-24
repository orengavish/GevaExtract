// check_strategy_variant.js — standalone self-check for the strategy_variant grouping fix
// (trade-builder.js buildOrdersForLevel + server.js handleSubmitCommands allowlist).
// No test framework: asserts + non-zero exit on failure.
const assert = require('assert');
const { buildOrdersForLevel, BRACKETS } = require('./trade-builder.js');

// (a) one scraped line -> 32 commands (8 brackets x 2 directions x 2 symbols), all sharing
// one non-null strategy_variant group value.
const commands = buildOrdersForLevel({
  linePrice: 5000,
  lineType:  'sup',
  strength:  '!',
  lineDate:  '2026-08-23',
  mesPrice:  5010,
  mnqPrice:  17800,
});

const expectedCount = BRACKETS.length * 2 /* directions */ * 2 /* symbols */;
assert.strictEqual(commands.length, expectedCount, `expected ${expectedCount} commands, got ${commands.length}`);

const groups = new Set(commands.map(c => c.strategy_variant));
assert.strictEqual(groups.size, 1, `expected exactly one shared strategy_variant, got ${groups.size}`);
const [groupValue] = groups;
assert.ok(groupValue, 'strategy_variant must be non-null/non-empty');
assert.ok(commands.every(c => c.strategy_variant === groupValue), 'every command must carry the same strategy_variant');

// (b) a second call (simulating a different scraped line/day) must get its own distinct group —
// confirms it's per-line, not a hardcoded constant.
const commands2 = buildOrdersForLevel({
  linePrice: 5100,
  lineType:  'res',
  strength:  '?',
  lineDate:  '2026-08-24',
  mesPrice:  5010,
  mnqPrice:  17800,
});
assert.notStrictEqual(commands2[0].strategy_variant, groupValue, 'different line builds must get different group ids');

// Note: this repo's insert-commands.py is geva_extract-only (source is hardcoded), so there is
// no separate non-grid/other-source build path here to check for a null group value.

console.log('check_strategy_variant.js: all checks passed');
