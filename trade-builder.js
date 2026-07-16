// trade-builder.js
// Calculates bracket orders: 8 brackets × 2 directions × 2 symbols = 32 commands per Geva line.
// Toggle rule (from Galgo order_builder.py):
//   current >= line → LMT BUY  + STP SELL
//   current <  line → STP BUY  + LMT SELL
// Entry type is fixed at call time using the live price passed in.
const { randomUUID } = require('crypto');

const TICK        = 0.25;
const TICK_USD    = { MES: 1.25, MNQ: 0.50 };  // $/tick per contract
const MULTIPLIER  = { MES: 5.0,  MNQ: 2.0  };  // $/index point

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

function rt(p) {
  return Math.round(Math.round(p / TICK) * TICK * 10000) / 10000;
}

function entryType(direction, currentPrice, linePrice) {
  const above = currentPrice >= linePrice;
  return direction === 'BUY' ? (above ? 'LMT' : 'STP') : (above ? 'STP' : 'LMT');
}

function calcPrices(direction, eType, linePrice, tpTicks, slTicks) {
  const tp = tpTicks * TICK, sl = slTicks * TICK;
  let entry;
  if      (direction === 'BUY'  && eType === 'LMT') entry = rt(linePrice);
  else if (direction === 'BUY'  && eType === 'STP') entry = rt(linePrice + TICK);
  else if (direction === 'SELL' && eType === 'LMT') entry = rt(linePrice);
  else                                               entry = rt(linePrice - TICK);
  return {
    entry,
    tp: direction === 'BUY' ? rt(entry + tp) : rt(entry - tp),
    sl: direction === 'BUY' ? rt(entry - sl) : rt(entry + sl),
  };
}

// Build all 32 commands for one Geva price level.
// mesPrice and mnqPrice must be live at the moment of calling (toggle rule locked here).
function buildOrdersForLevel({ linePrice, lineType, strength, lineDate, mesPrice, mnqPrice }) {
  const group_id     = randomUUID();
  const ratio        = mnqPrice / mesPrice;
  const mnqLinePrice = rt(mnqPrice * (linePrice / mesPrice));
  const commands     = [];

  for (const bkt of BRACKETS) {
    for (const direction of ['BUY', 'SELL']) {
      // MES order
      const mesEType = entryType(direction, mesPrice, linePrice);
      const mesP     = calcPrices(direction, mesEType, linePrice, bkt.tp, bkt.sl);
      commands.push({
        group_id, symbol: 'MES', line_date: lineDate, line_price: linePrice,
        line_type: lineType, strength, bracket_label: bkt.label, direction,
        entry_type: mesEType, entry_price: mesP.entry,
        tp_price: mesP.tp, tp_ticks: bkt.tp, sl_price: mesP.sl, sl_ticks: bkt.sl, quantity: 1,
      });

      // MNQ — entry price and ticks scaled proportionally
      const mnqTpTicks = Math.max(1, Math.round(bkt.tp * ratio));
      const mnqSlTicks = Math.max(1, Math.round(bkt.sl * ratio));
      const mnqEType   = entryType(direction, mnqPrice, mnqLinePrice);
      const mnqP       = calcPrices(direction, mnqEType, mnqLinePrice, mnqTpTicks, mnqSlTicks);
      commands.push({
        group_id, symbol: 'MNQ', line_date: lineDate, line_price: linePrice,
        line_type: lineType, strength, bracket_label: bkt.label, direction,
        entry_type: mnqEType, entry_price: mnqP.entry,
        tp_price: mnqP.tp, tp_ticks: mnqTpTicks, sl_price: mnqP.sl, sl_ticks: mnqSlTicks, quantity: 1,
      });
    }
  }
  return commands;  // 32 commands
}

module.exports = { buildOrdersForLevel, BRACKETS, TICK, TICK_USD, MULTIPLIER };
