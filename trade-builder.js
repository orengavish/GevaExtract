// trade-builder.js
// Calculates bracket orders for insertion into galao.db (CriticalCorallations2026).
// Matches the galao.db commands table schema exactly.
//
// Toggle rule (from Galgo order_builder.py):
//   current >= line → LMT BUY  + STP SELL
//   current <  line → STP BUY  + LMT SELL
// Entry type is determined at call time using live prices (fixed before sending to broker).

const { randomUUID } = require('crypto');

const TICK       = 0.25;
const MULTIPLIER = { MES: 5.0, MNQ: 2.0 };   // $/index-point

const BRACKETS = [
  { label: 'b4',    tp:  4, sl:  4 },
  { label: 'b8',    tp:  8, sl:  8 },
  { label: 'b16',   tp: 16, sl: 16 },
  { label: 'b32',   tp: 32, sl: 32 },
  { label: 'b4/16', tp:  4, sl: 16 },
  { label: 'b16/4', tp: 16, sl:  4 },
  { label: 'b8/32', tp:  8, sl: 32 },
  { label: 'b32/8', tp: 32, sl:  8 },
];

// Strength string → integer (galao.db line_strength convention)
const STRENGTH_MAP = { '!': 1, '?': 3, '': 2, 'other': 2 };

// line_type → galao.db convention
const LINE_TYPE_MAP = { sup: 'SUPPORT', res: 'RESISTANCE' };

function rt(p) {
  return Math.round(Math.round(p / TICK) * TICK * 10000) / 10000;
}

function entryType(direction, currentPrice, linePrice) {
  const above = currentPrice >= linePrice;
  return direction === 'BUY' ? (above ? 'LMT' : 'STP') : (above ? 'STP' : 'LMT');
}

function calcPrices(direction, eType, linePrice, tpTicks, slTicks) {
  const tpDist = tpTicks * TICK;
  const slDist = slTicks * TICK;
  let entry;
  if      (direction === 'BUY'  && eType === 'LMT') entry = rt(linePrice);
  else if (direction === 'BUY'  && eType === 'STP') entry = rt(linePrice + TICK);
  else if (direction === 'SELL' && eType === 'LMT') entry = rt(linePrice);
  else                                               entry = rt(linePrice - TICK);
  return {
    entry,
    tp: direction === 'BUY' ? rt(entry + tpDist) : rt(entry - tpDist),
    sl: direction === 'BUY' ? rt(entry - slDist) : rt(entry + slDist),
  };
}

// Build all 32 commands for one Geva price level.
// Returns objects shaped for direct INSERT into galao.db commands table.
function buildOrdersForLevel({ linePrice, lineType, strength, lineDate, mesPrice, mnqPrice }) {
  const group_id     = randomUUID();           // shared across MES+MNQ for the same Geva line
  const ratio        = mnqPrice / mesPrice;
  const mnqLinePrice = rt(mnqPrice * (linePrice / mesPrice));
  const lineTypeDb   = LINE_TYPE_MAP[lineType] ?? 'SUPPORT';
  const lineStrength = STRENGTH_MAP[strength]  ?? 2;
  const commands     = [];

  for (const bkt of BRACKETS) {
    for (const direction of ['BUY', 'SELL']) {

      // ── MES ──────────────────────────────────────────────────────────────
      const mesEType = entryType(direction, mesPrice, linePrice);
      const mesP     = calcPrices(direction, mesEType, linePrice, bkt.tp, bkt.sl);
      commands.push({
        // galao.db required fields
        symbol:        'MES',
        line_price:    linePrice,
        line_type:     lineTypeDb,
        line_strength: lineStrength,
        direction,
        entry_type:    mesEType,
        entry_price:   mesP.entry,
        tp_price:      mesP.tp,
        sl_price:      mesP.sl,
        bracket_size:  rt(bkt.tp * TICK),   // TP distance in points (broker replenishment metadata)
        // extra context (used for display, not in DB insert)
        _group_id:     group_id,
        _bracket:      bkt.label,
        _line_date:    lineDate,
      });

      // ── MNQ — proportionally scaled ───────────────────────────────────────
      const mnqTpTicks = Math.max(1, Math.round(bkt.tp * ratio));
      const mnqSlTicks = Math.max(1, Math.round(bkt.sl * ratio));
      const mnqEType   = entryType(direction, mnqPrice, mnqLinePrice);
      const mnqP       = calcPrices(direction, mnqEType, mnqLinePrice, mnqTpTicks, mnqSlTicks);
      commands.push({
        symbol:        'MNQ',
        line_price:    mnqLinePrice,          // MNQ-scaled — broker uses this for replenishment toggle
        line_type:     lineTypeDb,
        line_strength: lineStrength,
        direction,
        entry_type:    mnqEType,
        entry_price:   mnqP.entry,
        tp_price:      mnqP.tp,
        sl_price:      mnqP.sl,
        bracket_size:  rt(mnqTpTicks * TICK),
        _group_id:     group_id,
        _bracket:      bkt.label,
        _line_date:    lineDate,
      });
    }
  }

  return commands;   // 32 commands
}

module.exports = { buildOrdersForLevel, BRACKETS, TICK, MULTIPLIER };
