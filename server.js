const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { spawn }= require('child_process');
const { openDb }= require('./db');
const { readTradesDb } = require('./trades-db');
const priceFeed= require('./price-feed');
const { buildOrdersForLevel, TICK_USD } = require('./trade-builder');

const PORT       = 5005;
const VERSION    = JSON.parse(fs.readFileSync(path.join(__dirname,'version.json'),'utf8')).v;
const PENDING_DIR= path.join(__dirname, 'pending');

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtDate(d) { // '2026-07-16' → '16/07'
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}

function fmtPrice(p) {
  if (p == null) return '—';
  return (+p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Tab: Posts ────────────────────────────────────────────────────────────────

function buildPostsTab(posts) {
  const rows = posts.slice().reverse().map(r => {
    const sup = esc((r.support    ?? '').replace(/^קווי תמיכה:\s*/,    ''));
    const res = esc((r.resistance ?? '').replace(/^קווי התנגדות:\s*/, ''));
    return `<tr>
      <td class="date">${esc(r.date)}</td>
      <td class="day">${esc(r.day ?? '')}</td>
      <td class="sup">${sup}</td>
      <td class="res">${res}</td>
      <td class="src">${esc(r.source ?? '')}</td>
    </tr>`;
  }).join('');
  return `
  <table>
    <thead><tr>
      <th>תאריך</th><th>יום</th>
      <th style="color:#68d391">תמיכה</th>
      <th style="color:#fc8181">התנגדות</th>
      <th>מקור</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Tab: Lines ────────────────────────────────────────────────────────────────

function buildLinesTab(lines) {
  const byDate = new Map();
  for (const l of lines) {
    if (!byDate.has(l.date)) byDate.set(l.date, { sup: [], res: [] });
    byDate.get(l.date)[l.line_type].push(l);
  }

  function chips(levels, cls) {
    return levels.map(l => {
      const s = l.strength === '!' ? '!' : l.strength === '?' ? '?' : l.strength === 'other' ? '*' : '';
      const badge = s ? `<em class="s">${s}</em>` : '';
      return `<span class="chip ${cls}">${l.price}${badge}</span>`;
    }).join('');
  }

  const rows = [...byDate.keys()].flatMap(date => {
    const g = byDate.get(date);
    const out = [];
    if (g.sup.length) out.push(`<tr>
      <td class="date">${fmtDate(date)}</td><td class="sym">ES</td>
      <td class="type sup">תמיכה</td><td class="levels">${chips(g.sup,'sup')}</td>
    </tr>`);
    if (g.res.length) out.push(`<tr>
      <td></td><td></td>
      <td class="type res">התנגדות</td><td class="levels">${chips(g.res,'res')}</td>
    </tr>`);
    return out;
  }).join('');

  return `
  <table>
    <thead><tr><th>תאריך</th><th>Sym</th><th>סוג</th><th>קווים</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Tab: Trades ───────────────────────────────────────────────────────────────

function buildTradesTab(latestLines, latestDate) {
  if (!latestDate) {
    return '<p style="color:#555;padding:20px">אין קווים בבסיס הנתונים.</p>';
  }

  const rows = latestLines.map(l => {
    const typeClass = l.line_type === 'sup' ? 'sup' : 'res';
    const typeLabel = l.line_type === 'sup' ? 'תמיכה' : 'התנגדות';
    const str = l.strength === '!' ? '!' : l.strength === '?' ? '?' : l.strength === 'other' ? '*' : '';
    const dataAttrs = `data-price="${l.price}" data-type="${esc(l.line_type)}" data-str="${esc(l.strength)}" data-date="${esc(l.date)}"`;
    return `<tr id="row-${l.price.toString().replace('.','_')}">
      <td class="price">${l.price}</td>
      <td>${str ? `<span class="badge-str">${str}</span>` : ''}</td>
      <td class="type ${typeClass}">${typeLabel}</td>
      <td>
        <button class="submit-btn" ${dataAttrs} onclick="submitLevel(this)">
          Submit 32
        </button>
      </td>
      <td class="trade-status" id="ts-${l.price.toString().replace('.','_')}"></td>
    </tr>`;
  }).join('');

  return `
  <div class="trade-toolbar">
    <div>
      <strong style="color:#a0aec0">${fmtDate(latestDate)}</strong>
      <span style="color:#555;font-size:.8rem;margin-right:8px">${latestLines.length} קווים</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span id="live-prices" style="font-size:.82rem;font-variant-numeric:tabular-nums;color:#718096">⏳ טוען...</span>
      <button class="action-btn" onclick="submitAll()">Submit All (${latestLines.length * 32})</button>
    </div>
  </div>
  <table>
    <thead><tr>
      <th>מחיר</th><th>עוצמה</th><th>סוג</th><th>פעולה</th><th>סטטוס</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Tab: P&L (shell — content is JS-rendered) ─────────────────────────────────

function buildPnlTab() {
  return `
  <div id="mon-controls" style="display:flex;gap:12px;align-items:center;margin-bottom:16px">
    <span id="broker-badge" class="badge-status">טוען...</span>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:.85rem;color:#a0aec0">
      <input type="checkbox" id="replenish-chk" onchange="toggleReplenish(this.checked)">
      Replenish
    </label>
    <span style="color:#555;font-size:.78rem" id="replenish-note"></span>
    <button class="action-btn" style="margin-right:auto" onclick="loadPnl()">↺ רענן</button>
  </div>
  <div id="mon-open"></div>
  <div id="mon-closed" style="margin-top:24px"></div>
  <div id="mon-totals" style="margin-top:14px"></div>`;
}

// ── Full page HTML ─────────────────────────────────────────────────────────────

function buildHtml(posts, lines) {
  const latestDate  = lines[0]?.date ?? null;
  const latestLines = latestDate ? lines.filter(l => l.date === latestDate) : [];

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Geva S/R v${VERSION}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#0f1117;color:#e0e0e0;padding:24px}
    header{display:flex;align-items:center;gap:10px;margin-bottom:18px;flex-wrap:wrap}
    h1{font-size:1.3rem;font-weight:600;color:#fff;white-space:nowrap}
    .ver{background:#1e2030;border:1px solid #2a2d3a;border-radius:5px;padding:2px 8px;font-size:.75rem;color:#4a90d9}
    .price-header{font-size:.82rem;font-variant-numeric:tabular-nums;color:#718096;background:#161923;border:1px solid #2a2d3a;border-radius:5px;padding:3px 10px;white-space:nowrap}
    .price-header b{color:#cbd5e0}
    .meta-count{font-size:.78rem;color:#555}
    .hdr-right{margin-right:auto;display:flex;gap:8px;align-items:center}
    a.refresh{color:#4a90d9;text-decoration:none;font-size:.8rem}
    #fetchBtn{background:#1a2030;border:1px solid #2a3a5a;color:#7ab3f5;border-radius:6px;padding:4px 12px;font-size:.78rem;cursor:pointer}
    #fetchBtn:hover:not(:disabled){background:#1e2a40}
    #fetchBtn:disabled{opacity:.45;cursor:default}
    #fetchStatus{font-size:.76rem}
    .fs-running{color:#a0aec0}.fs-ok{color:#68d391}.fs-err{color:#fc8181}

    /* tabs */
    .tabs{display:flex;gap:2px;border-bottom:1px solid #2a2d3a;margin-bottom:0}
    .tab{padding:7px 18px;cursor:pointer;font-size:.85rem;color:#666;border-bottom:2px solid transparent;user-select:none;transition:color .15s}
    .tab:hover{color:#aaa}
    .tab.active{color:#fff;border-bottom-color:#4a90d9}
    .panel{display:none;padding-top:16px}
    .panel.active{display:block}

    /* tables */
    table{width:100%;border-collapse:collapse;font-size:.83rem}
    thead th{background:#1a1d27;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.69rem;padding:8px 12px;border-bottom:1px solid #2a2d3a;text-align:right}
    tbody tr{border-bottom:1px solid #1e2030;transition:background .1s}
    tbody tr:hover{background:#1a1d27}
    td{padding:9px 12px;vertical-align:middle;text-align:right}
    td.date{color:#a0aec0;white-space:nowrap;font-variant-numeric:tabular-nums}
    td.day{color:#718096;white-space:nowrap}
    td.sup{color:#68d391;line-height:1.5}
    td.res{color:#fc8181;line-height:1.5}
    td.src{color:#4a5568;font-size:.73rem;white-space:nowrap}
    td.price{font-variant-numeric:tabular-nums;font-weight:500}
    td.sym{color:#4a5568;font-size:.76rem;white-space:nowrap}
    td.type{font-size:.8rem;white-space:nowrap;font-weight:500}
    td.type.sup{color:#68d391}
    td.type.res{color:#fc8181}
    td.levels{white-space:nowrap}

    /* chips */
    .chip{display:inline-flex;align-items:center;gap:2px;margin:2px 3px;padding:3px 7px;border-radius:4px;font-size:.8rem;font-variant-numeric:tabular-nums;font-weight:500}
    .chip.sup{background:#0a1f14;color:#68d391;border:1px solid #1a3a28}
    .chip.res{background:#1f0a0a;color:#fc8181;border:1px solid #3a1a1a}
    .chip em.s{font-style:normal;font-size:.66rem;font-weight:700;opacity:.7;margin-left:1px}

    /* badges */
    .badge-str{display:inline-block;border-radius:3px;font-size:.7rem;font-weight:700;padding:1px 5px;background:#2d3a50;color:#7ab3f5}
    .badge-status{display:inline-block;border-radius:5px;font-size:.75rem;font-weight:600;padding:3px 10px}
    .badge-running{background:#0a2d0a;color:#68d391;border:1px solid #1a4a1a}
    .badge-stopped{background:#2d0a0a;color:#fc8181;border:1px solid #4a1a1a}
    .badge-error{background:#2d1a0a;color:#f6ad55;border:1px solid #4a2a0a}
    .badge-unknown{background:#1a1d27;color:#555;border:1px solid #2a2d3a}

    /* trade toolbar */
    .trade-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding:10px 14px;background:#161923;border:1px solid #2a2d3a;border-radius:7px}
    .submit-btn{background:#0a1f2d;border:1px solid #1a3a5a;color:#7ab3f5;border-radius:5px;padding:4px 11px;font-size:.78rem;cursor:pointer;transition:background .12s}
    .submit-btn:hover:not(:disabled){background:#122040}
    .submit-btn:disabled{opacity:.4;cursor:default}
    .action-btn{background:#1a2030;border:1px solid #2a3a5a;color:#7ab3f5;border-radius:6px;padding:5px 13px;font-size:.8rem;cursor:pointer;white-space:nowrap}
    .action-btn:hover{background:#1e2a40}
    td.trade-status{font-size:.76rem;color:#555;white-space:nowrap}
    .ts-ok{color:#68d391}
    .ts-err{color:#fc8181}

    /* P&L */
    .pnl-header{font-size:.78rem;color:#a0aec0;font-weight:600;padding:6px 0 8px;border-bottom:1px solid #2a2d3a;margin-bottom:8px}
    .pnl-pos{color:#68d391;font-variant-numeric:tabular-nums}
    .pnl-neg{color:#fc8181;font-variant-numeric:tabular-nums}
    .pnl-zero{color:#718096}
    .totals-row{font-weight:600;background:#161923}
  </style>
</head>
<body>
  <header>
    <h1>Geva S&amp;R</h1>
    <span class="ver">v${VERSION}</span>
    <div class="price-header" id="hdr-prices">⏳</div>
    <span class="meta-count">${posts.length} posts · ${lines.length} lines</span>
    <div class="hdr-right">
      <a class="refresh" href="/">↺</a>
      <button id="fetchBtn" onclick="manualFetch()">⬇ שלוף היום</button>
      <span id="fetchStatus"></span>
    </div>
  </header>

  <div class="tabs">
    <div class="tab active" onclick="show('posts',this)">פוסטים</div>
    <div class="tab"        onclick="show('lines',this)">קווי מחיר</div>
    <div class="tab"        onclick="show('trades',this);initTrades()">עסקאות</div>
    <div class="tab"        onclick="show('monitor',this);loadPnl()">מוניטור</div>
  </div>

  <div id="posts"   class="panel active">${buildPostsTab(posts)}</div>
  <div id="lines"   class="panel">${buildLinesTab(lines)}</div>
  <div id="trades"  class="panel">${buildTradesTab(latestLines, latestDate)}</div>
  <div id="monitor" class="panel">${buildPnlTab()}</div>

  <script>
  // ── Tab management ───────────────────────────────────────────────────────────
  function show(id, el) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab'  ).forEach(t => t.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    el.classList.add('active');
    sessionStorage.setItem('tab', id);
  }
  const _savedTab = sessionStorage.getItem('tab');
  if (_savedTab) {
    const _el = document.querySelector('[onclick*="\\'' + _savedTab + '\\'"]');
    if (_el) _el.click();
  }

  // ── Price poller (header + trades tab) ───────────────────────────────────────
  let _pricesLastFetch = 0;
  async function fetchPrices() {
    if (Date.now() - _pricesLastFetch < 28000) return;
    try {
      const d = await (await fetch('/api/prices')).json();
      _pricesLastFetch = Date.now();
      const fmt = (p) => p?.price ? p.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
      const html = \`MES <b>\${fmt(d.MES)}</b> &nbsp; MNQ <b>\${fmt(d.MNQ)}</b>\`;
      document.getElementById('hdr-prices').innerHTML = html;
      const lp = document.getElementById('live-prices');
      if (lp) lp.innerHTML = html + ' <span style="color:#3a4050;font-size:.7rem">(Yahoo)</span>';
    } catch(e) {}
  }
  fetchPrices();
  setInterval(fetchPrices, 30000);

  // ── Manual fetch from FB ─────────────────────────────────────────────────────
  async function manualFetch() {
    const btn = document.getElementById('fetchBtn');
    const st  = document.getElementById('fetchStatus');
    btn.disabled = true;
    st.className = 'fs-running'; st.textContent = '⏳ מריץ...';
    try {
      const r = await fetch('/fetch', { method: 'POST' });
      const d = await r.json();
      if (d.ok) { st.className='fs-ok'; st.textContent='✓ '+d.msg; setTimeout(()=>location.reload(),1200); }
      else       { st.className='fs-err'; st.textContent='✗ '+d.msg; }
    } catch(e) { st.className='fs-err'; st.textContent='✗ '+e.message; }
    finally { btn.disabled = false; }
  }

  // ── Trades tab ───────────────────────────────────────────────────────────────
  let _tradesInitDone = false;
  function initTrades() {
    if (_tradesInitDone) return;
    _tradesInitDone = true;
    fetchPrices();
  }

  async function submitLevel(btn) {
    const { price, type: lineType, str: strength, date: lineDate } = btn.dataset;
    await _doSubmit([{ linePrice: +price, lineType, strength, lineDate }], btn);
  }

  async function submitAll() {
    const btns = [...document.querySelectorAll('.submit-btn:not(:disabled)')];
    if (!btns.length) return;
    const levels = btns.map(b => ({
      linePrice: +b.dataset.price, lineType: b.dataset.type,
      strength: b.dataset.str,     lineDate: b.dataset.date,
    }));
    btns.forEach(b => { b.disabled = true; b.textContent = '⏳'; });
    await _doSubmit(levels, null);
    btns.forEach(b => b.textContent = '✓');
  }

  async function _doSubmit(levels, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ מגיש...'; }
    try {
      const r = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ levels }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.msg || 'שגיאה');
      for (const { linePrice } of levels) {
        const key = linePrice.toString().replace('.','_');
        const st  = document.getElementById('ts-' + key);
        if (st) { st.className = 'trade-status ts-ok'; st.textContent = '✓ ' + (d.count / levels.length) + ' ⏳'; }
        const b   = document.querySelector(\`[data-price="\${linePrice}"].submit-btn\`);
        if (b) b.textContent = '✓';
      }
    } catch(e) {
      if (btn) { btn.disabled=false; btn.textContent='Submit 32'; }
      alert('שגיאה: ' + e.message);
    }
  }

  // ── P&L tab ──────────────────────────────────────────────────────────────────
  let _pnlTimer = null;

  async function loadPnl() {
    try {
      const d = await (await fetch('/api/pnl')).json();
      renderPnl(d);
    } catch(e) {
      document.getElementById('mon-open').innerHTML =
        '<p style="color:#555;padding:12px">שגיאה בטעינת נתונים</p>';
    }
    clearInterval(_pnlTimer);
    _pnlTimer = setInterval(loadPnl, 10000);
  }

  function renderPnl(d) {
    // Broker status badge
    const statusMap = { RUNNING:'badge-running', STOPPED:'badge-stopped', ERROR:'badge-error' };
    const cls = statusMap[d.brokerStatus] || 'badge-unknown';
    document.getElementById('broker-badge').className = 'badge-status ' + cls;
    document.getElementById('broker-badge').textContent = 'Broker: ' + (d.brokerStatus || '?');

    // Replenish toggle
    const chk = document.getElementById('replenish-chk');
    chk.checked = d.replenish === '1';
    document.getElementById('replenish-note').textContent =
      d.replenish === '1' ? '— פקודות נסגרות מתחדשות אוטומטית' : '— ידני';

    // Prices for unrealized P&L
    const liveP = { MES: d.prices?.MES?.price, MNQ: d.prices?.MNQ?.price };
    const TICK_USD = { MES: 1.25, MNQ: 0.50 };

    // Open positions
    const open = d.open || [];
    let openHtml = '<div class="pnl-header">פוזיציות פתוחות (' + open.length + ')</div>';
    if (!open.length) {
      openHtml += '<p style="color:#555;font-size:.82rem;padding:8px 0">אין פוזיציות פתוחות</p>';
    } else {
      openHtml += '<table><thead><tr><th>ID</th><th>Sym</th><th>Dir</th><th>Bracket</th><th>Entry</th><th>Fill</th><th>TP</th><th>SL</th><th>Live</th><th>P&L unreal</th><th>סטטוס</th></tr></thead><tbody>';
      let totalUnreal = 0;
      for (const c of open) {
        const lp = liveP[c.symbol];
        let unreal = null, unrealUsd = null;
        if (lp && c.fill_price) {
          const ticks = c.direction === 'BUY'
            ? (lp - c.fill_price) / 0.25
            : (c.fill_price - lp) / 0.25;
          unreal = ticks;
          unrealUsd = ticks * (TICK_USD[c.symbol] || 1.25);
          totalUnreal += unrealUsd;
        }
        const pClass = (unreal === null) ? 'pnl-zero' : (unreal >= 0 ? 'pnl-pos' : 'pnl-neg');
        const pText  = unreal === null ? '—' :
          (unreal >= 0 ? '+' : '') + unreal.toFixed(1) + 't  $' +
          (unrealUsd >= 0 ? '+' : '') + unrealUsd.toFixed(2);
        openHtml += \`<tr>
          <td>\${c.id}</td><td>\${c.symbol}</td><td>\${c.direction}</td><td>\${c.bracket_label||''}</td>
          <td class="price">\${c.entry_price}</td>
          <td class="price">\${c.fill_price ?? '—'}</td>
          <td class="price" style="color:#68d391">\${c.tp_price}</td>
          <td class="price" style="color:#fc8181">\${c.sl_price}</td>
          <td class="price">\${lp ? lp.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</td>
          <td class="\${pClass}">\${pText}</td>
          <td><span class="badge-str">\${c.status}</span></td>
        </tr>\`;
      }
      openHtml += \`<tr class="totals-row">
        <td colspan="9" style="text-align:left;color:#718096;font-size:.78rem">סה"כ unrealized</td>
        <td class="\${totalUnreal >= 0 ? 'pnl-pos' : 'pnl-neg'}">\${totalUnreal >= 0 ? '+' : ''}\${totalUnreal.toFixed(2)}$</td>
        <td></td>
      </tr>\`;
      openHtml += '</tbody></table>';
    }
    document.getElementById('mon-open').innerHTML = openHtml;

    // Closed today
    const closed = d.closed || [];
    let closedHtml = '<div class="pnl-header">סגירות היום (' + closed.length + ')</div>';
    if (!closed.length) {
      closedHtml += '<p style="color:#555;font-size:.82rem;padding:8px 0">אין סגירות היום</p>';
    } else {
      closedHtml += '<table><thead><tr><th>ID</th><th>Sym</th><th>Dir</th><th>Bracket</th><th>Entry</th><th>Fill</th><th>Exit</th><th>סיבה</th><th>P&L ticks</th><th>P&L $</th></tr></thead><tbody>';
      let totalReal = 0;
      for (const c of closed) {
        const pTicks = c.pnl_ticks ?? 0;
        const pUsd   = pTicks * (TICK_USD[c.symbol] || 1.25);
        totalReal   += pUsd;
        const pClass = pTicks >= 0 ? 'pnl-pos' : 'pnl-neg';
        const reason = c.exit_reason === 'TP' ? '<span style="color:#68d391">TP</span>'
                     : c.exit_reason === 'SL' ? '<span style="color:#fc8181">SL</span>'
                     : esc(c.exit_reason || '');
        closedHtml += \`<tr>
          <td>\${c.id}</td><td>\${c.symbol}</td><td>\${c.direction}</td><td>\${c.bracket_label||''}</td>
          <td class="price">\${c.entry_price}</td>
          <td class="price">\${c.fill_price ?? '—'}</td>
          <td class="price">\${c.exit_price ?? '—'}</td>
          <td>\${reason}</td>
          <td class="\${pClass}">\${pTicks >= 0 ? '+' : ''}\${pTicks.toFixed(1)}</td>
          <td class="\${pClass}">\${pUsd >= 0 ? '+' : ''}\${pUsd.toFixed(2)}</td>
        </tr>\`;
      }
      closedHtml += \`<tr class="totals-row">
        <td colspan="8" style="text-align:left;color:#718096;font-size:.78rem">סה"כ realized היום</td>
        <td></td>
        <td class="\${totalReal >= 0 ? 'pnl-pos' : 'pnl-neg'}">\${totalReal >= 0 ? '+' : ''}\${totalReal.toFixed(2)}$</td>
      </tr>\`;
      closedHtml += '</tbody></table>';
    }
    document.getElementById('mon-closed').innerHTML = closedHtml;
  }

  async function toggleReplenish(enabled) {
    document.getElementById('replenish-note').textContent = '⏳ שומר...';
    try {
      await fetch('/api/replenish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch(e) {}
  }
  </script>
</body>
</html>`;
}

// ── Manual fetch ──────────────────────────────────────────────────────────────

let fetchRunning = false;

function runExtract() {
  return new Promise(resolve => {
    if (fetchRunning) { resolve({ ok: false, msg: 'כבר רץ, המתן...' }); return; }
    fetchRunning = true;
    const child = spawn(process.execPath, [path.join(__dirname, 'extract.js')], {
      cwd: __dirname, timeout: 180_000,
    });
    const lines = [];
    child.stdout.on('data', d => lines.push(d.toString()));
    child.stderr.on('data', d => lines.push(d.toString()));
    child.on('close', code => {
      fetchRunning = false;
      if (code === 0) resolve({ ok: true,  msg: 'הצלחה' });
      else            resolve({ ok: false, msg: lines.join('').trim().split('\n').pop() ?? `exit ${code}` });
    });
    child.on('error', err => { fetchRunning = false; resolve({ ok: false, msg: err.message }); });
  });
}

// ── API: Submit ───────────────────────────────────────────────────────────────

async function handleSubmit(body) {
  const { levels } = body;
  if (!Array.isArray(levels) || !levels.length) {
    return { ok: false, msg: 'חסר levels' };
  }
  const prices = priceFeed.getPrices();
  if (!prices.MES || !prices.MNQ) {
    return { ok: false, msg: 'מחיר MES/MNQ לא זמין עדיין — המתן 30 שניות ונסה שוב' };
  }

  const allCommands = [];
  for (const lv of levels) {
    const cmds = buildOrdersForLevel({
      linePrice:  lv.linePrice,
      lineType:   lv.lineType,
      strength:   lv.strength,
      lineDate:   lv.lineDate,
      mesPrice:   prices.MES.price,
      mnqPrice:   prices.MNQ.price,
    });
    allCommands.push(...cmds);
  }

  // Write to pending/ directory — broker picks up
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const fname = path.join(PENDING_DIR, `submit_${Date.now()}.json`);
  fs.writeFileSync(fname, JSON.stringify(allCommands), 'utf8');

  return { ok: true, count: allCommands.length, msg: `${allCommands.length} פקודות בתור` };
}

// ── API: P&L ─────────────────────────────────────────────────────────────────

async function handlePnl() {
  const db = await readTradesDb();
  if (!db) {
    return {
      open: [], closed: [], prices: priceFeed.getPrices(),
      replenish: '0', brokerStatus: 'STOPPED',
    };
  }
  const open      = db.getOpenCommands();
  const closed    = db.getClosedToday();
  const replenish = db.getSystemState('REPLENISH_ENABLED') ?? '0';
  const brokerStatus = db.getSystemState('SESSION') ?? 'UNKNOWN';
  const priceRows = db.getPriceCache();
  db.close();

  // Merge price sources: prefer broker fill prices, then Yahoo
  const yahooPrices = priceFeed.getPrices();
  const prices = { MES: yahooPrices.MES, MNQ: yahooPrices.MNQ };
  for (const row of priceRows) {
    prices[row.sym] = { price: row.price, updated_at: row.updated_at, source: row.source };
  }

  return { open, closed, prices, replenish, brokerStatus };
}

// ── API: Replenish toggle ─────────────────────────────────────────────────────

function handleReplenishToggle(body) {
  const value = body.enabled ? '1' : '0';
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const fname = path.join(PENDING_DIR, `state_${Date.now()}.json`);
  fs.writeFileSync(fname, JSON.stringify({ key: 'REPLENISH_ENABLED', value }), 'utf8');
  return { ok: true };
}

// ── Request body reader ───────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

async function startServer() {
  priceFeed.startPoller(30000);

  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    // POST /fetch — manual FB extraction
    if (req.method === 'POST' && url === '/fetch') {
      const result = await runExtract();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/prices — live prices from Yahoo cache
    if (req.method === 'GET' && url === '/api/prices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(priceFeed.getPrices()));
      return;
    }

    // POST /api/submit — build + queue bracket orders
    if (req.method === 'POST' && url === '/api/submit') {
      const body   = await readBody(req);
      const result = await handleSubmit(body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/pnl — P&L data from trades.db
    if (req.method === 'GET' && url === '/api/pnl') {
      const data = await handlePnl();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    // POST /api/replenish — toggle replenish flag
    if (req.method === 'POST' && url === '/api/replenish') {
      const body   = await readBody(req);
      const result = handleReplenishToggle(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET / — main page
    if ((req.method === 'GET') && (url === '/' || url === '')) {
      try {
        const db    = await openDb();
        const posts = db.getAllPosts();
        const lines = db.getAllLines();
        db.close();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildHtml(posts, lines));
      } catch (err) {
        res.writeHead(500); res.end(`Error: ${err.message}`);
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`Geva S/R v${VERSION} → http://localhost:${PORT}`);
  });
}

startServer();
