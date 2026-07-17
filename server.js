const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { spawn }  = require('child_process');
const { openDb } = require('./db');
const { readGalaoDb, MULTIPLIER } = require('./galao-db');
const priceFeed  = require('./price-feed');
const { buildOrdersForLevel, BRACKETS } = require('./trade-builder');

const PORT    = 5005;
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).v;

const CC2026_STATUS_URL = 'http://localhost:5003/api/session/status';

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtDate(d) {
  const [, m, day] = (d ?? '').split('-');
  return day && m ? `${day}/${m}` : d ?? '';
}

// ── Tab: Posts ────────────────────────────────────────────────────────────────

function buildPostsTab(posts) {
  const rows = posts.slice().reverse().map(r => `<tr>
    <td class="date">${esc(r.date)}</td>
    <td class="day">${esc(r.day ?? '')}</td>
    <td class="sup">${esc((r.support    ?? '').replace(/^קווי תמיכה:\s*/,    ''))}</td>
    <td class="res">${esc((r.resistance ?? '').replace(/^קווי התנגדות:\s*/, ''))}</td>
    <td class="src">${esc(r.source ?? '')}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr><th>תאריך</th><th>יום</th><th style="color:#68d391">תמיכה</th><th style="color:#fc8181">התנגדות</th><th>מקור</th></tr></thead>
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
      return `<span class="chip ${cls}">${l.price}${s ? `<em>${s}</em>` : ''}</span>`;
    }).join('');
  }

  const rows = [...byDate.keys()].flatMap(date => {
    const g = byDate.get(date);
    const out = [];
    if (g.sup.length) out.push(`<tr>
      <td class="date">${fmtDate(date)}</td><td class="sym">ES</td>
      <td class="type sup">תמיכה</td><td class="levels">${chips(g.sup,'sup')}</td>
    </tr>`);
    if (g.res.length) out.push(`<tr><td></td><td></td>
      <td class="type res">התנגדות</td><td class="levels">${chips(g.res,'res')}</td>
    </tr>`);
    return out;
  }).join('');

  return `<table>
    <thead><tr><th>תאריך</th><th>Sym</th><th>סוג</th><th>קווים</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Tab: Trades (CC2026-style create → preview → submit) ─────────────────────

function buildTradesTab() {
  const bktChecks = BRACKETS.map(b =>
    `<label><input type="checkbox" value="${b.label}"${['b4','b8','b16','b32'].includes(b.label) ? ' checked' : ''}> ${b.label}</label>`
  ).join('');

  return `
  <div class="filter-bar">
    <div class="filter-grp">
      <span class="filter-lbl">סמלים</span>
      <div class="chk-list" id="sym-checks">
        <label><input type="checkbox" value="MES" checked> MES</label>
        <label><input type="checkbox" value="MNQ" checked> MNQ</label>
      </div>
    </div>
    <div class="filter-grp">
      <span class="filter-lbl">Bracket</span>
      <div class="chk-list" id="bkt-checks">${bktChecks}</div>
    </div>
    <div class="filter-grp">
      <span class="filter-lbl">עוצמה ≥</span>
      <input type="number" id="min-str" min="1" max="3" value="1"
        style="width:48px;background:#0f1117;border:1px solid #2a2d3a;color:#e0e0e0;border-radius:4px;padding:3px 6px;font-size:.82rem">
    </div>
    <div style="display:flex;gap:8px;align-items:flex-end;margin-right:auto">
      <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:.74rem;color:#718096;align-items:center" id="trade-counts"></div>
      <button class="abtn" onclick="createTrades()">Create Trades</button>
      <button class="abtn" id="submit-trades-btn" style="display:none;background:#0a2d0a;border-color:#1a4a1a;color:#68d391" onclick="submitTrades()">Submit 0</button>
    </div>
  </div>
  <div id="candidates-wrap"></div>`;
}

// ── Tab: Submitted (Sub) ──────────────────────────────────────────────────────

function buildSubTab() {
  return `
  <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
    <button class="abtn" onclick="loadSubmitted()">↺ רענן</button>
    <label style="font-size:.82rem;color:#a0aec0;cursor:pointer">
      <input type="checkbox" id="sub-autorefresh" onchange="toggleSubAuto(this.checked)"> Auto 5s
    </label>
    <label style="font-size:.82rem;color:#a0aec0;cursor:pointer;margin-right:4px">
      <input type="checkbox" id="replenish-chk2" onchange="toggleReplenish(this.checked)"> Replenish
    </label>
    <span id="replenish-note2" class="muted" style="font-size:.76rem"></span>
    <span id="sub-count" class="muted" style="font-size:.74rem;margin-right:auto"></span>
  </div>
  <div id="sub-table-wrap"></div>`;
}

// ── Tab: Monitor (JS-rendered) ────────────────────────────────────────────────

function buildMonitorTab() {
  return `
  <div id="mon-header" style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
    <span id="broker-badge"  class="badge-st bu">Broker: ...</span>
    <span id="decider-badge" class="badge-st bu">Decider: ...</span>
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.84rem;color:#a0aec0">
      <input type="checkbox" id="replenish-chk" onchange="toggleReplenish(this.checked)">
      Replenish
    </label>
    <span id="replenish-note" class="muted" style="font-size:.76rem"></span>
    <button class="abtn" style="margin-right:auto" onclick="loadPnl()">↺</button>
  </div>
  <div id="mon-counts" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"></div>
  <div id="mon-open"></div>
  <div id="mon-closed" style="margin-top:22px"></div>`;
}

// ── Full page ─────────────────────────────────────────────────────────────────

function buildHtml(posts, lines) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Geva S/R v${VERSION}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#0f1117;color:#e0e0e0;padding:22px}
    header{display:flex;align-items:center;gap:9px;margin-bottom:16px;flex-wrap:wrap}
    h1{font-size:1.25rem;font-weight:600;color:#fff;white-space:nowrap}
    .ver{background:#1e2030;border:1px solid #2a2d3a;border-radius:4px;padding:2px 7px;font-size:.72rem;color:#4a90d9}
    .price-pill{font-size:.8rem;font-variant-numeric:tabular-nums;color:#718096;background:#161923;border:1px solid #2a2d3a;border-radius:5px;padding:3px 10px;white-space:nowrap}
    .price-pill b{color:#cbd5e0}
    .muted{color:#555;font-size:.78rem}
    .hdr-right{margin-right:auto;display:flex;gap:8px;align-items:center}
    a.rl{color:#4a90d9;text-decoration:none;font-size:.79rem}
    #fetchBtn{background:#1a2030;border:1px solid #2a3a5a;color:#7ab3f5;border-radius:5px;padding:4px 11px;font-size:.77rem;cursor:pointer}
    #fetchBtn:hover:not(:disabled){background:#1e2a40}
    #fetchBtn:disabled{opacity:.4;cursor:default}
    #fetchStatus{font-size:.75rem}
    .fs-r{color:#a0aec0}.fs-ok{color:#68d391}.fs-err{color:#fc8181}

    .tabs{display:flex;gap:0;border-bottom:1px solid #2a2d3a;margin-bottom:0}
    .tab{padding:7px 16px;cursor:pointer;font-size:.84rem;color:#666;border-bottom:2px solid transparent;user-select:none}
    .tab:hover{color:#aaa}
    .tab.active{color:#fff;border-bottom-color:#4a90d9}
    .panel{display:none;padding-top:14px}
    .panel.active{display:block}

    table{width:100%;border-collapse:collapse;font-size:.82rem}
    thead th{background:#1a1d27;color:#555;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.68rem;padding:7px 11px;border-bottom:1px solid #2a2d3a;text-align:right}
    tbody tr{border-bottom:1px solid #1e2030}
    tbody tr:hover{background:#1a1d27}
    td{padding:8px 11px;vertical-align:middle;text-align:right}
    td.date{color:#a0aec0;white-space:nowrap}
    td.day{color:#718096;white-space:nowrap}
    td.sup{color:#68d391;line-height:1.5}
    td.res{color:#fc8181;line-height:1.5}
    td.src{color:#4a5568;font-size:.72rem}
    td.price{font-variant-numeric:tabular-nums;font-weight:500}
    td.sym{color:#4a5568;font-size:.75rem}
    td.type{font-size:.79rem;font-weight:500}
    td.type.sup{color:#68d391}
    td.type.res{color:#fc8181}
    td.levels{white-space:nowrap}

    .chip{display:inline-flex;align-items:center;gap:2px;margin:2px 2px;padding:3px 7px;border-radius:4px;font-size:.79rem;font-variant-numeric:tabular-nums;font-weight:500}
    .chip.sup{background:#0a1f14;color:#68d391;border:1px solid #1a3a28}
    .chip.res{background:#1f0a0a;color:#fc8181;border:1px solid #3a1a1a}
    .chip em{font-style:normal;font-size:.64rem;font-weight:700;opacity:.7;margin-left:1px}

    .abtn{background:#1a2030;border:1px solid #2a3a5a;color:#7ab3f5;border-radius:5px;padding:4px 12px;font-size:.79rem;cursor:pointer}
    .abtn:hover:not(:disabled){background:#1e2a40}
    .abtn:disabled{opacity:.4;cursor:default}

    .badge-st{display:inline-block;border-radius:4px;font-size:.73rem;font-weight:600;padding:3px 9px}
    .br{background:#0a2d0a;color:#68d391;border:1px solid #1a4a1a}
    .bs{background:#2d0a0a;color:#fc8181;border:1px solid #4a1a1a}
    .bu{background:#1a1d27;color:#555;border:1px solid #2a2d3a}
    .cnt-pill{background:#1a1d27;border:1px solid #2a2d3a;border-radius:4px;padding:3px 9px;font-size:.74rem;color:#718096}
    .cnt-pill b{color:#a0aec0}

    .pnl-sec{font-size:.77rem;color:#a0aec0;font-weight:600;padding:5px 0 7px;border-bottom:1px solid #2a2d3a;margin-bottom:7px}
    .pp{color:#68d391;font-variant-numeric:tabular-nums}
    .pn{color:#fc8181;font-variant-numeric:tabular-nums}
    .pz{color:#718096}
    tr.tot{font-weight:600;background:#161923}

    /* Trades filter bar */
    .filter-bar{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;padding:10px 12px;background:#161923;border:1px solid #2a2d3a;border-radius:6px;margin-bottom:10px}
    .filter-grp{display:flex;flex-direction:column;gap:4px}
    .filter-lbl{font-size:.69rem;color:#555;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
    .chk-list{display:flex;flex-wrap:wrap;gap:6px}
    .chk-list label{font-size:.79rem;color:#a0aec0;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:3px}
    .chk-list input[type=checkbox]{cursor:pointer;accent-color:#4a90d9}

    /* Status badges (Sub tab) */
    .st-pill{display:inline-block;border-radius:3px;font-size:.68rem;font-weight:700;padding:2px 7px}
    .st-PENDING{background:#495057;color:#fff}
    .st-SUBMITTED{background:#0d6efd;color:#fff}
    .st-SUBMITTING{background:#0dcaf0;color:#000}
    .st-FILLED{background:#b58900;color:#fff}
    .st-EXITING{background:#fd7e14;color:#000}
    .st-CLOSED{background:#198754;color:#fff}
    .st-CANCELLED{background:#2d3238;color:#888}
    .st-ERROR{background:#dc3545;color:#fff}
    .st-RECONCILE_REQUIRED{background:#dc3545;color:#fff}
  </style>
</head>
<body>
  <header>
    <h1>Geva S&amp;R</h1>
    <span class="ver">v${VERSION}</span>
    <div class="price-pill" id="hdr-prices">⏳</div>
    <span class="muted">${posts.length} posts · ${lines.length} lines</span>
    <div class="hdr-right">
      <a class="rl" href="/">↺</a>
      <button id="fetchBtn" onclick="manualFetch()">⬇ שלוף</button>
      <span id="fetchStatus"></span>
    </div>
  </header>

  <div class="tabs">
    <div class="tab active" onclick="show('posts',this)">פוסטים</div>
    <div class="tab"        onclick="show('lines',this)">קווי מחיר</div>
    <div class="tab"        onclick="show('trades',this);refreshPrices()">עסקאות</div>
    <div class="tab"        onclick="show('sub',this);loadSubmitted()">מוגשות</div>
    <div class="tab"        onclick="show('monitor',this);loadPnl()">מוניטור</div>
  </div>

  <div id="posts"   class="panel active">${buildPostsTab(posts)}</div>
  <div id="lines"   class="panel">${buildLinesTab(lines)}</div>
  <div id="trades"  class="panel">${buildTradesTab()}</div>
  <div id="sub"     class="panel">${buildSubTab()}</div>
  <div id="monitor" class="panel">${buildMonitorTab()}</div>

  <script>
  // ── Tabs ─────────────────────────────────────────────────────────────────────
  function show(id,el){
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    el.classList.add('active');
    sessionStorage.setItem('tab',id);
  }
  (function(){
    const t=sessionStorage.getItem('tab');
    if(t){const e=document.querySelector('[onclick*="\''+t+'\'"]');if(e)e.click();}
  })();

  // ── Prices ───────────────────────────────────────────────────────────────────
  let _lastPriceFetch=0;
  async function refreshPrices(){
    if(Date.now()-_lastPriceFetch<28000) return;
    try{
      const d=await(await fetch('/api/prices')).json();
      _lastPriceFetch=Date.now();
      const f=p=>p?.price?p.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
      document.getElementById('hdr-prices').innerHTML='MES <b>'+f(d.MES)+'</b> &nbsp; MNQ <b>'+f(d.MNQ)+'</b>';
    }catch(e){}
  }
  refreshPrices();
  setInterval(refreshPrices,30000);

  // ── Manual fetch ──────────────────────────────────────────────────────────────
  async function manualFetch(){
    const btn=document.getElementById('fetchBtn'),st=document.getElementById('fetchStatus');
    btn.disabled=true;st.className='fs-r';st.textContent='⏳ מריץ...';
    try{
      const d=await(await fetch('/fetch',{method:'POST'})).json();
      if(d.ok){st.className='fs-ok';st.textContent='✓ '+d.msg;setTimeout(()=>location.reload(),1200);}
      else{st.className='fs-err';st.textContent='✗ '+d.msg;}
    }catch(e){st.className='fs-err';st.textContent='✗ '+e.message;}
    finally{btn.disabled=false;}
  }

  // ── Shared helpers ────────────────────────────────────────────────────────────
  function checkedVals(id){
    return[...document.querySelectorAll('#'+id+' input[type=checkbox]:checked')].map(e=>e.value);
  }
  function strengthColor(s){
    const g=['#555','#666','#777','#888','#999','#aaa','#f0a','#f60','#f80','#f00'];
    return g[Math.max(0,Math.min(9,s-1))];
  }
  function fmt(v){return v!=null?parseFloat(v).toFixed(2):'—';}

  // ── Trades tab ────────────────────────────────────────────────────────────────
  let _tradeCandidates=[];

  async function createTrades(){
    const syms=checkedVals('sym-checks');
    const bkts=checkedVals('bkt-checks');
    const minStr=parseInt(document.getElementById('min-str').value)||1;
    if(!syms.length||!bkts.length){alert('בחר לפחות סמל אחד ו-bracket אחד');return;}
    document.getElementById('trade-counts').innerHTML='<span>⏳</span>';
    document.getElementById('candidates-wrap').innerHTML='';
    try{
      const r=await fetch('/api/trades/create',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({symbols:syms,brackets:bkts,minStrength:minStr})
      });
      const d=await r.json();
      if(!d.ok){alert(d.msg);document.getElementById('trade-counts').innerHTML='';return;}
      _tradeCandidates=d.candidates;
      renderCandidates(d);
    }catch(e){alert('שגיאה: '+e.message);document.getElementById('trade-counts').innerHTML='';}
  }

  function renderCandidates(d){
    document.getElementById('trade-counts').innerHTML=
      '<span>Total: <b style="color:#a0aec0">'+d.total+'</b></span>'+
      ' <span>Passed: <b style="color:#68d391">'+d.passed+'</b></span>'+
      ' <span>Filtered: <b style="color:#fc8181">'+d.filtered+'</b></span>';
    const btn=document.getElementById('submit-trades-btn');
    btn.style.display=d.passed?'':'none';
    btn.textContent='Submit '+d.passed;
    btn.disabled=false;
    if(!d.candidates.length){
      document.getElementById('candidates-wrap').innerHTML='<p class="muted" style="padding:14px">אין מועמדים לאחר הסינון.</p>';
      return;
    }
    const rows=d.candidates.map(function(c,i){
      return '<tr>'+
        '<td style="width:26px"><input type="checkbox" data-idx="'+i+'" checked onchange="updateSubmitCount()"></td>'+
        '<td style="color:#555">'+(i+1)+'</td>'+
        '<td>'+c.symbol+'</td>'+
        '<td>'+(c.direction==='BUY'?'<span style="color:#68d391">BUY</span>':'<span style="color:#fc8181">SELL</span>')+'</td>'+
        '<td style="color:#718096;font-size:.76rem">'+c.entry_type+'</td>'+
        '<td class="price">'+fmt(c.entry_price)+'</td>'+
        '<td class="price" style="color:#68d391">'+fmt(c.tp_price)+'</td>'+
        '<td class="price" style="color:#fc8181">'+fmt(c.sl_price)+'</td>'+
        '<td style="font-size:.75rem">'+c._bracket+'</td>'+
        '<td><span style="color:'+strengthColor(c.line_strength)+'">'+c.line_strength+'</span></td>'+
        '<td style="font-size:.72rem;color:#718096">'+(c.line_type==='SUPPORT'?'SUP':'RES')+' '+fmt(c.line_price)+'</td>'+
        '</tr>';
    }).join('');
    document.getElementById('candidates-wrap').innerHTML=
      '<div style="margin-bottom:6px;display:flex;gap:10px;align-items:center">'+
      '<label style="font-size:.78rem;color:#555;cursor:pointer">'+
      '<input type="checkbox" id="sel-all" checked onchange="toggleSelAll(this.checked)"> Select All'+
      '</label></div>'+
      '<table><thead><tr>'+
      '<th></th><th>#</th><th>Sym</th><th>Dir</th><th>ET</th>'+
      '<th>Entry</th><th>TP</th><th>SL</th><th>Bkt</th><th>Str</th><th>Line</th>'+
      '</tr></thead><tbody id="cand-tbody">'+rows+'</tbody></table>';
  }

  function toggleSelAll(on){
    document.querySelectorAll('#cand-tbody input[type=checkbox]').forEach(c=>c.checked=on);
    updateSubmitCount();
  }

  function updateSubmitCount(){
    const checked=document.querySelectorAll('#cand-tbody input[type=checkbox]:checked').length;
    const total=document.querySelectorAll('#cand-tbody input[type=checkbox]').length;
    const btn=document.getElementById('submit-trades-btn');
    if(btn){btn.textContent='Submit '+checked;btn.style.display=checked?'':'none';}
    const sa=document.getElementById('sel-all');
    if(sa) sa.checked=(checked===total&&total>0);
  }

  async function submitTrades(){
    const checked=[...document.querySelectorAll('#cand-tbody input[type=checkbox]:checked')];
    const toSubmit=checked.map(c=>_tradeCandidates[parseInt(c.dataset.idx)]);
    if(!toSubmit.length)return;
    const btn=document.getElementById('submit-trades-btn');
    btn.disabled=true;btn.textContent='⏳ שולח '+toSubmit.length+'...';
    try{
      const r=await fetch('/api/submit-commands',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({commands:toSubmit})
      });
      const d=await r.json();
      if(d.ok){
        btn.textContent='✓ '+d.inserted+' נשלחו ל-broker';
        setTimeout(()=>{btn.disabled=false;updateSubmitCount();},3000);
      }else{
        btn.disabled=false;btn.textContent='Submit '+checked.length;
        alert('שגיאה: '+(d.msg||d.error||'שגיאה'));
      }
    }catch(e){
      btn.disabled=false;btn.textContent='Submit '+checked.length;
      alert('שגיאה: '+e.message);
    }
  }

  // ── Sub tab (Submitted commands from galao.db) ────────────────────────────────
  let _subTimer=null;

  const STATUS_CLS={
    PENDING:'st-PENDING',SUBMITTED:'st-SUBMITTED',SUBMITTING:'st-SUBMITTING',
    FILLED:'st-FILLED',EXITING:'st-EXITING',CLOSED:'st-CLOSED',
    CANCELLED:'st-CANCELLED',ERROR:'st-ERROR',RECONCILE_REQUIRED:'st-RECONCILE_REQUIRED'
  };

  async function loadSubmitted(){
    try{
      const d=await(await fetch('/api/submitted')).json();
      const chk2=document.getElementById('replenish-chk2');
      if(chk2) chk2.checked=(d.replenish==='1');
      const note2=document.getElementById('replenish-note2');
      if(note2) note2.textContent=d.replenish==='1'?'ON — מתחדש':'OFF';
      document.getElementById('sub-count').textContent=(d.commands?.length||0)+' פקודות';
      renderSubmitted(d.commands||[]);
    }catch(e){
      document.getElementById('sub-table-wrap').innerHTML='<p class="muted" style="padding:10px">שגיאה: '+e.message+'</p>';
    }
  }

  function renderSubmitted(cmds){
    if(!cmds.length){
      document.getElementById('sub-table-wrap').innerHTML='<p class="muted" style="padding:14px">אין פקודות geva_extract.</p>';
      return;
    }
    const fmtDt=s=>s?s.replace('T',' ').slice(0,16):'—';
    const rows=cmds.map(function(c){
      return '<tr>'+
        '<td>'+c.id+'</td>'+
        '<td>'+c.symbol+'</td>'+
        '<td>'+(c.direction==='BUY'?'<span style="color:#68d391">BUY</span>':'<span style="color:#fc8181">SELL</span>')+'</td>'+
        '<td style="font-size:.73rem;color:#718096">'+c.entry_type+'</td>'+
        '<td class="price">'+fmt(c.entry_price)+'</td>'+
        '<td class="price" style="color:#68d391">'+fmt(c.tp_price)+'</td>'+
        '<td class="price" style="color:#fc8181">'+fmt(c.sl_price)+'</td>'+
        '<td style="font-size:.73rem">'+fmt(c.bracket_size)+'</td>'+
        '<td><span class="st-pill '+(STATUS_CLS[c.status]||'st-PENDING')+'">'+(c.status||'?')+'</span></td>'+
        '<td class="price">'+fmt(c.fill_price)+'</td>'+
        '<td style="font-size:.72rem;color:#718096">'+fmtDt(c.updated_at)+'</td>'+
        '</tr>';
    }).join('');
    document.getElementById('sub-table-wrap').innerHTML=
      '<table><thead><tr>'+
      '<th>ID</th><th>Sym</th><th>Dir</th><th>Type</th>'+
      '<th>Entry</th><th>TP</th><th>SL</th><th>Bkt</th>'+
      '<th>Status</th><th>Fill</th><th>Updated</th>'+
      '</tr></thead><tbody>'+rows+'</tbody></table>';
  }

  function toggleSubAuto(on){
    clearInterval(_subTimer);
    if(on) _subTimer=setInterval(loadSubmitted,5000);
  }

  // ── Monitor tab ───────────────────────────────────────────────────────────────
  let _pnlTimer=null;
  async function loadPnl(){
    clearInterval(_pnlTimer);
    try{
      const d=await(await fetch('/api/pnl')).json();
      renderPnl(d);
    }catch(e){document.getElementById('mon-open').innerHTML='<p class="muted" style="padding:10px">שגיאה: '+e.message+'</p>';}
    _pnlTimer=setInterval(loadPnl,10000);
  }

  const MULT={MES:5.0,MNQ:2.0};

  function renderPnl(d){
    function setBadge(id,name,st){
      const el=document.getElementById(id);if(!el)return;
      const cls=st==='running'?'br':st==='dead'||st==='error'?'bs':'bu';
      el.className='badge-st '+cls;el.textContent=name+': '+(st||'?');
    }
    setBadge('broker-badge','Broker',d.session?.broker);
    setBadge('decider-badge','Decider',d.session?.decider);
    const chk=document.getElementById('replenish-chk');
    chk.checked=(d.replenish==='1');
    document.getElementById('replenish-note').textContent=d.replenish==='1'?'ON — סגירות מתחדשות':'OFF';
    const counts=d.counts||[];
    document.getElementById('mon-counts').innerHTML=counts.map(c=>'<span class="cnt-pill"><b>'+c.cnt+'</b> '+c.status+'</span>').join('');
    const liveP={};
    if(d.prices){for(const[sym,v]of Object.entries(d.prices)){if(v)liveP[sym]=v.price;}}
    const open=d.open||[];
    let oh='<div class="pnl-sec">פתוחות ('+open.length+')</div>';
    if(open.length){
      oh+='<table><thead><tr><th>ID</th><th>Sym</th><th>Dir</th><th>Entry</th><th>Fill</th><th>TP</th><th>SL</th><th>Live</th><th>Unreal P&L</th><th>סטטוס</th></tr></thead><tbody>';
      let tot=0;
      for(const c of open){
        const lp=liveP[c.symbol];
        let upt=null,upd=null;
        if(lp&&c.fill_price){upt=c.direction==='BUY'?(lp-c.fill_price):(c.fill_price-lp);upd=upt*(MULT[c.symbol]||5);tot+=upd;}
        const pc=upt===null?'pz':upt>=0?'pp':'pn';
        const pt=upt===null?'—':(upt>=0?'+':'')+upt.toFixed(2)+'pt  $'+(upd>=0?'+':'')+upd.toFixed(2);
        oh+='<tr><td>'+c.id+'</td><td>'+c.symbol+'</td><td>'+c.direction+'</td><td class="price">'+c.entry_price+'</td><td class="price">'+(c.fill_price??'—')+'</td><td class="price" style="color:#68d391">'+c.tp_price+'</td><td class="price" style="color:#fc8181">'+c.sl_price+'</td><td class="price">'+(lp?lp.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—')+'</td><td class="'+pc+'">'+pt+'</td><td><small>'+c.status+'</small></td></tr>';
      }
      if(open.length) oh+='<tr class="tot"><td colspan="8" style="color:#555;font-size:.72rem;text-align:left">סה"כ unrealized</td><td class="'+(tot>=0?'pp':'pn')+'">'+(tot>=0?'+':'')+tot.toFixed(2)+'$</td><td></td></tr>';
      oh+='</tbody></table>';
    }
    document.getElementById('mon-open').innerHTML=oh;
    const closed=d.closed||[];
    let ch='<div class="pnl-sec">סגירות היום ('+closed.length+')</div>';
    if(closed.length){
      ch+='<table><thead><tr><th>ID</th><th>Sym</th><th>Dir</th><th>Entry</th><th>Fill</th><th>Exit</th><th>סיבה</th><th>P&L pts</th><th>P&L $</th></tr></thead><tbody>';
      let tot=0;
      for(const c of closed){
        const pp=c.pnl_points??0;const pd=pp*(MULT[c.symbol]||5);tot+=pd;const pc=pp>=0?'pp':'pn';
        const reason=c.exit_reason==='TP'?'<span style="color:#68d391">TP</span>':c.exit_reason==='SL'?'<span style="color:#fc8181">SL</span>':(c.exit_reason||'');
        ch+='<tr><td>'+c.id+'</td><td>'+c.symbol+'</td><td>'+c.direction+'</td><td class="price">'+c.entry_price+'</td><td class="price">'+(c.fill_price??'—')+'</td><td class="price">'+(c.exit_price??'—')+'</td><td>'+reason+'</td><td class="'+pc+'">'+(pp>=0?'+':'')+pp.toFixed(3)+'</td><td class="'+pc+'">'+(pd>=0?'+':'')+pd.toFixed(2)+'</td></tr>';
      }
      ch+='<tr class="tot"><td colspan="7" style="color:#555;font-size:.72rem;text-align:left">סה"כ realized היום</td><td></td><td class="'+(tot>=0?'pp':'pn')+'">'+(tot>=0?'+':'')+tot.toFixed(2)+'$</td></tr>';
      ch+='</tbody></table>';
    }
    document.getElementById('mon-closed').innerHTML=ch;
  }

  async function toggleReplenish(enabled){
    const note=document.getElementById('replenish-note');
    const note2=document.getElementById('replenish-note2');
    if(note) note.textContent='⏳ שומר...';
    if(note2) note2.textContent='⏳ שומר...';
    try{
      await fetch('/api/replenish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
      const chk=document.getElementById('replenish-chk');
      const chk2=document.getElementById('replenish-chk2');
      if(chk) chk.checked=enabled;
      if(chk2) chk2.checked=enabled;
      if(note) note.textContent=enabled?'ON — סגירות מתחדשות':'OFF';
      if(note2) note2.textContent=enabled?'ON — מתחדש':'OFF';
    }catch(e){
      if(note) note.textContent='שגיאה';
      if(note2) note2.textContent='שגיאה';
    }
  }
  </script>
</body>
</html>`;
}

// ── Run extract ───────────────────────────────────────────────────────────────

let fetchRunning = false;

function runExtract() {
  return new Promise(resolve => {
    if (fetchRunning) { resolve({ ok: false, msg: 'כבר רץ' }); return; }
    fetchRunning = true;
    const child = spawn(process.execPath, [path.join(__dirname, 'extract.js')], {
      cwd: __dirname, timeout: 180_000,
    });
    const lines = [];
    child.stdout.on('data', d => lines.push(d.toString()));
    child.stderr.on('data', d => lines.push(d.toString()));
    child.on('close', code => {
      fetchRunning = false;
      if (code === 0) resolve({ ok: true, msg: 'הצלחה' });
      else resolve({ ok: false, msg: lines.join('').trim().split('\n').pop() ?? `exit ${code}` });
    });
    child.on('error', err => { fetchRunning = false; resolve({ ok: false, msg: err.message }); });
  });
}

// ── Python bridge (galao.db writes) ──────────────────────────────────────────

function runPython(args, stdinJson) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [path.join(__dirname, 'insert-commands.py'), ...args], {
      cwd: __dirname, timeout: 10_000,
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      try { resolve(JSON.parse(out || '{}')); }
      catch { resolve({ ok: code === 0, error: err || out }); }
    });
    child.on('error', reject);
    if (stdinJson !== undefined) {
      child.stdin.write(JSON.stringify(stdinJson));
      child.stdin.end();
    }
  });
}

// ── CC2026 session status ─────────────────────────────────────────────────────

function getCc2026Status() {
  return new Promise(resolve => {
    const req = http.get(CC2026_STATUS_URL, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

// ── API handlers ──────────────────────────────────────────────────────────────

async function handleTradesCreate(body) {
  const symbols     = body.symbols     ?? ['MES', 'MNQ'];
  const brackets    = body.brackets    ?? BRACKETS.map(b => b.label);
  const minStrength = parseInt(body.minStrength) || 1;

  const db    = await openDb();
  const lines = db.getAllLines();
  db.close();

  if (!lines.length) return { ok: false, msg: 'אין קווים בבסיס הנתונים. שלוף פוסטים תחילה.' };
  // Use most recent date (may be yesterday for pre-market usage)
  const latestDate = lines[0].date;
  const todayLines = lines.filter(l => l.date === latestDate);

  const prices = priceFeed.getPrices();
  if (!prices.MES?.price || !prices.MNQ?.price) {
    return { ok: false, msg: 'מחיר MES/MNQ לא זמין — המתן 30 שניות ונסה שוב' };
  }

  const allCandidates = [];
  for (const line of todayLines) {
    allCandidates.push(...buildOrdersForLevel({
      linePrice: line.price,
      lineType:  line.line_type,
      strength:  line.strength,
      lineDate:  line.date,
      mesPrice:  prices.MES.price,
      mnqPrice:  prices.MNQ.price,
    }));
  }

  const passed   = allCandidates.filter(c =>
    symbols.includes(c.symbol) &&
    brackets.includes(c._bracket) &&
    c.line_strength >= minStrength
  );
  const filtered = allCandidates.length - passed.length;

  return { ok: true, candidates: passed, total: allCandidates.length, passed: passed.length, filtered };
}

async function handleSubmitCommands(body) {
  const { commands } = body;
  if (!Array.isArray(commands) || !commands.length) return { ok: false, msg: 'חסר commands' };

  // Strip _* client-only metadata fields before inserting
  const clean = commands.map(c => ({
    symbol:        c.symbol,
    line_price:    c.line_price,
    line_type:     c.line_type,
    line_strength: c.line_strength,
    direction:     c.direction,
    entry_type:    c.entry_type,
    entry_price:   c.entry_price,
    tp_price:      c.tp_price,
    sl_price:      c.sl_price,
    bracket_size:  c.bracket_size,
  }));

  try {
    const result = await runPython([], clean);
    return result.ok
      ? { ok: true, inserted: result.inserted }
      : { ok: false, msg: result.error ?? 'שגיאה' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

async function handleSubmitted() {
  const galao = await readGalaoDb();
  if (!galao) return { ok: true, commands: [], replenish: '0' };
  const cmds      = galao.getGevaAllCommands();
  const replenish = galao.getSystemState('REPLENISH_ENABLED') ?? '0';
  galao.close();
  return { ok: true, commands: cmds, replenish };
}

async function handlePnl() {
  const [galao, session, yahooP] = await Promise.all([
    readGalaoDb(),
    getCc2026Status(),
    Promise.resolve(priceFeed.getPrices()),
  ]);

  if (!galao) {
    return { open: [], closed: [], counts: [], prices: yahooP, session, replenish: '0' };
  }

  const open      = galao.getGevaOpenCommands();
  const closed    = galao.getGevaClosedToday();
  const counts    = galao.getGevaStatusCounts();
  const replenish = galao.getSystemState('REPLENISH_ENABLED') ?? '0';

  const prices = { MES: yahooP.MES, MNQ: yahooP.MNQ };
  const mesCached = galao.getPrice('MES');
  const mnqCached = galao.getPrice('MNQ');
  if (mesCached) prices.MES = { price: mesCached.last_price, source: mesCached.source };
  if (mnqCached) prices.MNQ = { price: mnqCached.last_price, source: mnqCached.source };

  galao.close();
  return { open, closed, counts, prices, session, replenish };
}

async function handleReplenish(body) {
  const value = body.enabled ? '1' : '0';
  try {
    const r = await runPython(['--state', 'REPLENISH_ENABLED', value]);
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Request body ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

async function startServer() {
  priceFeed.startPoller(30000);

  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'POST' && url === '/fetch') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await runExtract()));
      return;
    }

    if (req.method === 'GET' && url === '/api/prices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(priceFeed.getPrices()));
      return;
    }

    if (req.method === 'POST' && url === '/api/trades/create') {
      const body = await readBody(req);
      const result = await handleTradesCreate(body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url === '/api/submit-commands') {
      const body = await readBody(req);
      const result = await handleSubmitCommands(body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && url === '/api/submitted') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await handleSubmitted()));
      return;
    }

    if (req.method === 'GET' && url === '/api/pnl') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await handlePnl()));
      return;
    }

    if (req.method === 'POST' && url === '/api/replenish') {
      const body = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await handleReplenish(body)));
      return;
    }

    if (req.method === 'GET' && (url === '/' || url === '')) {
      try {
        const db    = await openDb();
        const posts = db.getAllPosts();
        const lines = db.getAllLines();
        db.close();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildHtml(posts, lines));
      } catch (err) {
        res.writeHead(500); res.end('Error: ' + err.message);
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
