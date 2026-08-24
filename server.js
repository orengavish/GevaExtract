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
    <thead><tr><th>Date</th><th>Day</th><th style="color:#68d391">Support</th><th style="color:#fc8181">Resistance</th><th>Source</th></tr></thead>
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
      <td class="type sup">SUP</td><td class="levels">${chips(g.sup,'sup')}</td>
    </tr>`);
    if (g.res.length) out.push(`<tr><td></td><td></td>
      <td class="type res">RES</td><td class="levels">${chips(g.res,'res')}</td>
    </tr>`);
    return out;
  }).join('');

  return `<table>
    <thead><tr><th>Date</th><th>Sym</th><th>Type</th><th>Levels</th></tr></thead>
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
      <span class="filter-lbl">Symbols</span>
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
      <span class="filter-lbl">Strength &ge;</span>
      <input type="number" id="min-str" min="1" max="3" value="1"
        style="width:48px;background:#0f1117;border:1px solid #2a2d3a;color:#e0e0e0;border-radius:4px;padding:3px 6px;font-size:.82rem">
    </div>
    <div style="display:flex;gap:8px;align-items:flex-end;margin-left:auto">
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
    <button class="abtn" onclick="loadSubmitted()">↺ Refresh</button>
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
    <button class="abtn" style="margin-left:auto" onclick="loadPnl()">&#x21BA; Refresh</button>
  </div>
  <div id="mon-counts" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"></div>
  <div id="mon-open"></div>
  <div id="mon-closed" style="margin-top:22px"></div>`;
}

// ── Tab: Auto ─────────────────────────────────────────────────────────────────

function buildAutoTab() {
  return `
  <div style="max-width:640px;margin:0 auto">
    <div style="text-align:center;padding:28px 0 20px">
      <button id="auto-go-btn" class="auto-go" onclick="runAuto()">&#9654; GO</button>
      <button id="auto-cancel-btn" class="auto-go" onclick="cancelAll()"
        style="margin-left:14px;background:#4a1010;border-color:#7a1a1a;color:#fc8181">&#9746; Cancel All</button>
      <div id="auto-subtitle" style="margin-top:14px;font-size:.85rem;color:#718096">Fetch lines &rarr; build all orders &rarr; submit to broker</div>
    </div>
    <div id="auto-steps">
      <div class="auto-step"><span class="as-ic" id="as-ic-1">&#9675;</span><span id="as-lb-1">Fetch Geva lines from Facebook</span><span class="as-note" id="as-nt-1"></span></div>
      <div class="auto-step"><span class="as-ic" id="as-ic-2">&#9675;</span><span id="as-lb-2">Build orders &mdash; all brackets, MES + MNQ</span><span class="as-note" id="as-nt-2"></span></div>
      <div class="auto-step"><span class="as-ic" id="as-ic-3">&#9675;</span><span id="as-lb-3">Submit to broker</span><span class="as-note" id="as-nt-3"></span></div>
      <div class="auto-step"><span class="as-ic" id="as-ic-4">&#9675;</span><span id="as-lb-4">Live monitor</span><span class="as-note" id="as-nt-4"></span></div>
    </div>
    <div id="auto-live" style="margin-top:18px"></div>
  </div>`;
}

// ── Full page ─────────────────────────────────────────────────────────────────

function buildHtml(posts, lines) {
  return `<!DOCTYPE html>
<html lang="en">
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
    .hdr-right{margin-left:auto;display:flex;gap:8px;align-items:center}
    a.rl{color:#4a90d9;text-decoration:none;font-size:.79rem}
    .menu-wrap{position:relative}
    .menu-btn{background:#1a2030;border:1px solid #2a3a5a;color:#7ab3f5;border-radius:5px;
      padding:4px 10px;font-size:.79rem;cursor:pointer;line-height:1.4}
    .menu-btn:hover{background:#1e2a40}
    .menu-dd{display:none;position:absolute;left:0;top:100%;margin-top:4px;background:#161923;
      border:1px solid #2a2d3a;border-radius:6px;min-width:11rem;z-index:50;
      box-shadow:0 4px 20px rgba(0,0,0,.5);padding:4px 0}
    .menu-dd.open{display:block}
    .menu-dd a.mi{display:block;padding:6px 12px;color:#e0e0e0;text-decoration:none;font-size:.75rem}
    .menu-dd a.mi:hover{background:#1e2030}
    #fetchBtn{background:#1a2030;border:1px solid #2a3a5a;color:#7ab3f5;border-radius:5px;padding:4px 11px;font-size:.77rem;cursor:pointer}
    #fetchBtn:hover:not(:disabled){background:#1e2a40}
    #fetchBtn:disabled{opacity:.4;cursor:default}
    #fetchStatus{font-size:.75rem;vertical-align:middle}
    .fs-r{color:#a0aec0}.fs-ok{color:#68d391}.fs-err{color:#fc8181}
    @keyframes spin{to{transform:rotate(360deg)}}
    .fetch-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;z-index:2000;backdrop-filter:blur(3px)}
    .fetch-overlay.show{display:flex}
    .fetch-modal{background:#161923;border:1px solid #2a3a5a;border-radius:14px;padding:36px 48px;text-align:center;min-width:300px;box-shadow:0 12px 48px rgba(0,0,0,.7)}
    .fm-spinner{width:52px;height:52px;border:4px solid #2a3a5a;border-top-color:#7ab3f5;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px}
    .fm-icon{font-size:3.2rem;margin-bottom:14px;line-height:1}
    .fm-title{font-size:1.15rem;font-weight:700;margin-bottom:8px}
    .fm-msg{font-size:.84rem;color:#718096;margin-bottom:0;word-break:break-word;max-width:260px}

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

    /* Global status bar */
    .gstatus{display:flex;gap:7px;align-items:center;padding:8px 0 10px;border-bottom:1px solid #2a2d3a;margin-bottom:0;flex-wrap:wrap}
    .gsb{background:#1a1d27;border:1px solid #2a2d3a;border-radius:4px;padding:4px 10px;font-size:.78rem;color:#718096;white-space:nowrap;font-variant-numeric:tabular-nums}
    .gsb b{color:#e0e0e0}
    .gsb.gpr{font-size:.88rem;border-color:#2a3a5a}
    .gsb.gpr b{color:#cbd5e0;font-size:.92rem}

    /* Auto tab */
    .auto-go{font-size:2.4rem;font-weight:800;background:#0a2d0a;border:2px solid #2a6a2a;color:#68d391;border-radius:14px;padding:18px 64px;cursor:pointer;letter-spacing:.06em;transition:box-shadow .2s,background .15s}
    .auto-go:hover:not(:disabled){background:#0e3a0e;box-shadow:0 0 28px rgba(104,211,145,.22)}
    .auto-go:disabled{opacity:.35;cursor:default}
    .auto-step{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #1e2030;font-size:.84rem}
    .as-ic{width:22px;text-align:center;font-size:1rem;flex-shrink:0}
    .as-note{margin-left:auto;font-size:.75rem;color:#718096;text-align:right}
    @keyframes spin2{to{transform:rotate(360deg)}}
    .as-spin{display:inline-block;width:14px;height:14px;border:2px solid #2a3a5a;border-top-color:#7ab3f5;border-radius:50%;animation:spin2 .7s linear infinite;vertical-align:middle}
  </style>
</head>
<body>
  <script>
  /* Early-load stubs: queue calls that arrive before the main script executes.
     The main script's function declarations overwrite window.X, so after it
     runs the stubs are gone and everything works normally. */
  (function(){
    var _q=[], _ready=false;
    document.addEventListener('DOMContentLoaded',function(){
      _ready=true; _q.forEach(function(f){f();}); _q=[];
    });
    function defer(fn){ _ready?fn():_q.push(fn); }
    ['show','manualFetch','createTrades','submitTrades','loadSubmitted',
     'loadPnl','runAuto','refreshPrices','toggleSelAll','updateSubmitCount',
     'toggleSubAuto'].forEach(function(name){
      window[name]=function(){
        var args=Array.prototype.slice.call(arguments);
        defer(function(){ window[name].apply(null,args); });
      };
    });
    window.toggleReplenish=function(e){ defer(function(){ toggleReplenish(e); }); };
  })();
  </script>
  <header>
    <h1>Geva S&amp;R</h1>
    <span class="ver">v${VERSION}</span>
    <div class="price-pill" id="hdr-prices">--</div>
    <span class="muted">${posts.length} posts · ${lines.length} lines</span>
    <div class="hdr-right">
      <a class="rl" href="/">↺</a>
      <button id="fetchBtn" onclick="manualFetch()">⬇ Fetch</button>
      <span id="fetchStatus"></span>
      <div class="menu-wrap">
        <button class="menu-btn" onclick="document.getElementById('menu-dd').classList.toggle('open')" title="Other dashboards">🔗</button>
        <div class="menu-dd" id="menu-dd">
          <a class="mi" id="menu-link-cc2026" target="_blank">CC2026 Dashboard</a>
          <a class="mi" id="menu-link-fetcher" target="_blank">Fetcher2026</a>
          <a class="mi" id="menu-link-geva" target="_blank">GevaExtract (this)</a>
        </div>
      </div>
    </div>
  </header>

  <div class="gstatus">
    <span class="gsb gpr">MES <b id="gs-mes">--</b></span>
    <span class="gsb gpr">MNQ <b id="gs-mnq">--</b></span>
    <span class="gsb">Pending <b id="gs-pending">--</b></span>
    <span class="gsb">Submitted <b id="gs-sub" style="color:#4a90d9">--</b></span>
    <span class="gsb">Filled <b id="gs-filled" style="color:#b58900">--</b></span>
    <span class="gsb">Closed today <b id="gs-closed">--</b></span>
    <span class="gsb">P&amp;L <b id="gs-pnl">--</b></span>
    <span class="gsb">Replenish <b id="gs-rep">--</b></span>
    <span class="gsb" id="gs-broker" style="margin-left:auto">Broker --</span>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="show('posts',this)">Posts</div>
    <div class="tab"        onclick="show('lines',this)">Lines</div>
    <div class="tab"        onclick="show('trades',this);refreshPrices()">Trades</div>
    <div class="tab"        onclick="show('sub',this);loadSubmitted()">Submitted</div>
    <div class="tab"        onclick="show('monitor',this);loadPnl()">Monitor</div>
    <div class="tab"        onclick="show('auto',this)">&#9654; Auto</div>
  </div>

  <div id="posts"   class="panel active">${buildPostsTab(posts)}</div>
  <div id="lines"   class="panel">${buildLinesTab(lines)}</div>
  <div id="trades"  class="panel">${buildTradesTab()}</div>
  <div id="sub"     class="panel">${buildSubTab()}</div>
  <div id="monitor" class="panel">${buildMonitorTab()}</div>
  <div id="auto"    class="panel">${buildAutoTab()}</div>

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
    if(t){const e=Array.from(document.querySelectorAll('.tab')).find(el=>(el.getAttribute('onclick')||'').includes("'"+t+"'"));if(e)e.click();}
  })();

  // Cross-dashboard menu — same host, different port, works on localhost/LAN/Tailscale
  (function(){
    const base=location.protocol+'//'+location.hostname;
    document.getElementById('menu-link-cc2026').href  = base+':5003';
    document.getElementById('menu-link-fetcher').href = base+':5050';
    document.getElementById('menu-link-geva').href    = base+':5005';
    document.querySelectorAll('.menu-dd .mi').forEach(a=>{
      a.addEventListener('click',()=>document.getElementById('menu-dd').classList.remove('open'));
    });
    document.addEventListener('click',(e)=>{
      if(!e.target.closest('.menu-wrap')) document.getElementById('menu-dd').classList.remove('open');
    });
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
  function _fetchModal(state, msg){
    const ov=document.getElementById('fetchOverlay');
    const mo=document.getElementById('fetchModal');
    if(!ov||!mo) return;
    if(state==='loading'){
      mo.innerHTML='<div class="fm-spinner"></div><div class="fm-title" style="color:#a0aec0">Fetching from Facebook...</div><div class="fm-msg">Please wait</div>';
      ov.classList.add('show');
    } else if(state==='ok'){
      mo.innerHTML='<div class="fm-icon">&#x2705;</div><div class="fm-title" style="color:#68d391">Fetch succeeded!</div><div class="fm-msg">'+msg+'</div>';
    } else {
      mo.innerHTML='<div class="fm-icon">&#x274C;</div><div class="fm-title" style="color:#fc8181">Fetch failed</div><div class="fm-msg" style="margin-bottom:16px">'+msg+'</div><button class="abtn" onclick="document.getElementById(\\'fetchOverlay\\').classList.remove(\\'show\\')">Close</button>';
    }
  }
  async function manualFetch(){
    const btn=document.getElementById('fetchBtn');
    btn.disabled=true;btn.textContent='Fetching...';
    _fetchModal('loading');
    try{
      const d=await(await fetch('/fetch',{method:'POST'})).json();
      if(d.ok){
        _fetchModal('ok',d.msg);
        setTimeout(()=>{document.getElementById('fetchOverlay').classList.remove('show');location.reload();},2000);
      } else {
        _fetchModal('err',d.msg||'Unknown error');
      }
    }catch(e){
      _fetchModal('err',e.message||'Network error — server not responding');
    }finally{
      btn.disabled=false;btn.textContent='&#x2B07; Fetch';
    }
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
    if(!syms.length||!bkts.length){alert('Select at least one symbol and bracket');return;}
    document.getElementById('trade-counts').innerHTML='<span style="color:#718096">Loading...</span>';
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
    }catch(e){alert('Error: '+e.message);document.getElementById('trade-counts').innerHTML='';}
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
      document.getElementById('candidates-wrap').innerHTML='<p class="muted" style="padding:14px">No candidates after filtering.</p>';
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
    btn.disabled=true;btn.textContent='Sending '+toSubmit.length+'...';
    try{
      const r=await fetch('/api/submit-commands',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({commands:toSubmit})
      });
      const d=await r.json();
      if(d.ok){
        btn.textContent='Sent '+d.inserted;
        setTimeout(()=>{btn.disabled=false;updateSubmitCount();},3000);
      }else{
        btn.disabled=false;btn.textContent='Submit '+checked.length;
        alert('Error: '+(d.msg||d.error||'unknown error'));
      }
    }catch(e){
      btn.disabled=false;btn.textContent='Submit '+checked.length;
      alert('Error: '+e.message);
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
      if(note2) note2.textContent=d.replenish==='1'?'ON':'OFF';
      document.getElementById('sub-count').textContent=(d.commands?.length||0)+' commands';
      renderSubmitted(d.commands||[]);
    }catch(e){
      document.getElementById('sub-table-wrap').innerHTML='<p class="muted" style="padding:10px">Error: '+e.message+'</p>';
    }
  }

  function renderSubmitted(cmds){
    if(!cmds.length){
      document.getElementById('sub-table-wrap').innerHTML='<p class="muted" style="padding:14px">No geva_extract commands.</p>';
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
    }catch(e){document.getElementById('mon-open').innerHTML='<p class="muted" style="padding:10px">Error: '+e.message+'</p>';}
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
    document.getElementById('replenish-note').textContent=d.replenish==='1'?'ON':'OFF';
    const counts=d.counts||[];
    document.getElementById('mon-counts').innerHTML=counts.map(c=>'<span class="cnt-pill"><b>'+c.cnt+'</b> '+c.status+'</span>').join('');
    const liveP={};
    if(d.prices){for(const[sym,v]of Object.entries(d.prices)){if(v)liveP[sym]=v.price;}}
    const open=d.open||[];
    let oh='<div class="pnl-sec">Open ('+open.length+')</div>';
    if(open.length){
      oh+='<table><thead><tr><th>ID</th><th>Sym</th><th>Dir</th><th>Entry</th><th>Fill</th><th>TP</th><th>SL</th><th>Live</th><th>Unreal P&amp;L</th><th>Status</th></tr></thead><tbody>';
      let tot=0;
      for(const c of open){
        const lp=liveP[c.symbol];
        let upt=null,upd=null;
        if(lp&&c.fill_price){upt=c.direction==='BUY'?(lp-c.fill_price):(c.fill_price-lp);upd=upt*(MULT[c.symbol]||5);tot+=upd;}
        const pc=upt===null?'pz':upt>=0?'pp':'pn';
        const pt=upt===null?'—':(upt>=0?'+':'')+upt.toFixed(2)+'pt  $'+(upd>=0?'+':'')+upd.toFixed(2);
        oh+='<tr><td>'+c.id+'</td><td>'+c.symbol+'</td><td>'+c.direction+'</td><td class="price">'+c.entry_price+'</td><td class="price">'+(c.fill_price??'—')+'</td><td class="price" style="color:#68d391">'+c.tp_price+'</td><td class="price" style="color:#fc8181">'+c.sl_price+'</td><td class="price">'+(lp?lp.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—')+'</td><td class="'+pc+'">'+pt+'</td><td><small>'+c.status+'</small></td></tr>';
      }
      if(open.length) oh+='<tr class="tot"><td colspan="8" style="color:#555;font-size:.72rem">Total unrealized</td><td class="'+(tot>=0?'pp':'pn')+'">'+(tot>=0?'+':'')+tot.toFixed(2)+'$</td><td></td></tr>';
      oh+='</tbody></table>';
    }
    document.getElementById('mon-open').innerHTML=oh;
    const closed=d.closed||[];
    let ch='<div class="pnl-sec">Closed today ('+closed.length+')</div>';
    if(closed.length){
      ch+='<table><thead><tr><th>ID</th><th>Sym</th><th>Dir</th><th>Entry</th><th>Fill</th><th>Exit</th><th>Reason</th><th>P&amp;L pts</th><th>P&amp;L $</th></tr></thead><tbody>';
      let tot=0;
      for(const c of closed){
        const pp=c.pnl_points??0;const pd=pp*(MULT[c.symbol]||5);tot+=pd;const pc=pp>=0?'pp':'pn';
        const reason=c.exit_reason==='TP'?'<span style="color:#68d391">TP</span>':c.exit_reason==='SL'?'<span style="color:#fc8181">SL</span>':(c.exit_reason||'');
        ch+='<tr><td>'+c.id+'</td><td>'+c.symbol+'</td><td>'+c.direction+'</td><td class="price">'+c.entry_price+'</td><td class="price">'+(c.fill_price??'—')+'</td><td class="price">'+(c.exit_price??'—')+'</td><td>'+reason+'</td><td class="'+pc+'">'+(pp>=0?'+':'')+pp.toFixed(3)+'</td><td class="'+pc+'">'+(pd>=0?'+':'')+pd.toFixed(2)+'</td></tr>';
      }
      ch+='<tr class="tot"><td colspan="7" style="color:#555;font-size:.72rem">Total realized today</td><td></td><td class="'+(tot>=0?'pp':'pn')+'">'+(tot>=0?'+':'')+tot.toFixed(2)+'$</td></tr>';
      ch+='</tbody></table>';
    }
    document.getElementById('mon-closed').innerHTML=ch;
  }

  // ── Global status bar ─────────────────────────────────────────────────────────
  async function refreshGlobalStatus(){
    try{
      const d=await(await fetch('/api/pnl')).json();
      const fp=p=>p!=null?p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'--';
      const mes=d.prices?.MES?.price,mnq=d.prices?.MNQ?.price;
      document.getElementById('gs-mes').textContent=fp(mes);
      document.getElementById('gs-mnq').textContent=fp(mnq);
      if(mes||mnq) document.getElementById('hdr-prices').innerHTML='MES <b>'+fp(mes)+'</b> &nbsp; MNQ <b>'+fp(mnq)+'</b>';
      const cv={};(d.counts||[]).forEach(c=>cv[c.status]=c.cnt);
      document.getElementById('gs-pending').textContent=cv.PENDING||0;
      document.getElementById('gs-sub').textContent=(cv.SUBMITTED||0)+(cv.SUBMITTING||0);
      document.getElementById('gs-filled').textContent=cv.FILLED||0;
      document.getElementById('gs-closed').textContent=(d.closed||[]).length;
      const pnl=(d.closed||[]).reduce((s,c)=>s+(c.pnl_points??0)*({MES:5,MNQ:2}[c.symbol]||5),0);
      const pe=document.getElementById('gs-pnl');
      pe.textContent=(pnl>=0?'+':'')+pnl.toFixed(2)+'$';
      pe.style.color=pnl>0?'#68d391':pnl<0?'#fc8181':'#a0aec0';
      const re=document.getElementById('gs-rep');
      re.textContent=d.replenish==='1'?'ON':'OFF';
      re.style.color=d.replenish==='1'?'#68d391':'#718096';
      const br=d.session?.broker;
      const be=document.getElementById('gs-broker');
      be.textContent='Broker: '+(br||'?');
      be.style.color=br==='running'?'#68d391':br==='dead'||br==='error'?'#fc8181':'#718096';
    }catch(e){}
  }
  refreshGlobalStatus();
  setInterval(refreshGlobalStatus,15000);

  // ── Auto tab ──────────────────────────────────────────────────────────────────
  const BRACKETS_ALL=['b4','b8','b16','b32','b4/16','b16/4','b8/32','b32/8'];
  let _autoTimer=null;

  function setAS(n,state,note){
    const ic=document.getElementById('as-ic-'+n);
    const nt=document.getElementById('as-nt-'+n);
    if(!ic) return;
    if(state==='run'){ic.innerHTML='<span class="as-spin"></span>';ic.style.color='';}
    else if(state==='ok'){ic.innerHTML='&#10003;';ic.style.color='#68d391';}
    else if(state==='err'){ic.innerHTML='&#10007;';ic.style.color='#fc8181';}
    else{ic.innerHTML='&#9675;';ic.style.color='';}
    if(nt&&note!==undefined) nt.textContent=note;
  }

  async function runAuto(){
    const btn=document.getElementById('auto-go-btn');
    btn.disabled=true;
    document.getElementById('auto-subtitle').textContent='Running...';
    document.getElementById('auto-live').innerHTML='';
    clearInterval(_autoTimer);
    for(let i=1;i<=4;i++) setAS(i,'idle','');

    // Step 1: Fetch
    setAS(1,'run');
    try{
      const r=await(await fetch('/fetch',{method:'POST'})).json();
      if(!r.ok){setAS(1,'err',r.msg);btn.disabled=false;document.getElementById('auto-subtitle').textContent='Stopped — see step 1';return;}
      setAS(1,'ok',r.msg);
    }catch(e){setAS(1,'err',e.message);btn.disabled=false;return;}

    // Step 2: Build
    setAS(2,'run');
    let candidates=[];
    try{
      const r=await(await fetch('/api/trades/create',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({symbols:['MES','MNQ'],brackets:BRACKETS_ALL,minStrength:1})
      })).json();
      if(!r.ok){setAS(2,'err',r.msg);btn.disabled=false;document.getElementById('auto-subtitle').textContent='Stopped — see step 2';return;}
      candidates=r.candidates||[];
      setAS(2,'ok',r.passed+' orders');
    }catch(e){setAS(2,'err',e.message);btn.disabled=false;return;}

    // Step 3: Submit
    setAS(3,'run');
    try{
      const r=await(await fetch('/api/submit-commands',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({commands:candidates})
      })).json();
      if(!r.ok){setAS(3,'err',r.msg);btn.disabled=false;document.getElementById('auto-subtitle').textContent='Stopped — see step 3';return;}
      setAS(3,'ok',r.inserted+' submitted');
    }catch(e){setAS(3,'err',e.message);btn.disabled=false;return;}

    // Step 4: Live monitor
    setAS(4,'run','watching...');
    document.getElementById('auto-subtitle').textContent='Done — monitoring live';
    btn.disabled=false;
    loadAutoLive();
    _autoTimer=setInterval(loadAutoLive,5000);
  }

  async function loadAutoLive(){
    try{
      const d=await(await fetch('/api/pnl')).json();
      const cv={};(d.counts||[]).forEach(c=>cv[c.status]=c.cnt);
      const open=d.open||[],closed=d.closed||[];
      const pnl=closed.reduce((s,c)=>s+(c.pnl_points??0)*({MES:5,MNQ:2}[c.symbol]||5),0);
      const pnlStr=(pnl>=0?'+':'')+pnl.toFixed(2)+'$';
      setAS(4,'ok','open: '+open.length+' · closed: '+closed.length+' · P&L: '+pnlStr);
      let html='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">';
      ['PENDING','SUBMITTED','FILLED','EXITING','CLOSED','CANCELLED','ERROR'].forEach(st=>{if(cv[st])html+='<span class="cnt-pill"><b>'+cv[st]+'</b> '+st+'</span>';});
      html+='<span class="cnt-pill" style="color:'+(pnl>0?'#68d391':pnl<0?'#fc8181':'#a0aec0')+'"><b>'+pnlStr+'</b> P&amp;L today</span></div>';
      if(open.length){
        html+='<table><thead><tr><th>ID</th><th>Sym</th><th>Dir</th><th>Entry</th><th>Fill</th><th>TP</th><th>SL</th><th>Status</th></tr></thead><tbody>';
        open.slice(0,40).forEach(c=>{
          const dir=c.direction==='BUY'?'<span style="color:#68d391">BUY</span>':'<span style="color:#fc8181">SELL</span>';
          html+='<tr><td>'+c.id+'</td><td>'+c.symbol+'</td><td>'+dir+'</td><td class="price">'+c.entry_price+'</td><td class="price">'+(c.fill_price??'&#8212;')+'</td><td class="price" style="color:#68d391">'+c.tp_price+'</td><td class="price" style="color:#fc8181">'+c.sl_price+'</td><td><span class="st-pill st-'+c.status+'">'+c.status+'</span></td></tr>';
        });
        html+='</tbody></table>';
      }
      document.getElementById('auto-live').innerHTML=html;
      refreshGlobalStatus();
    }catch(e){}
  }

  async function cancelAll(){
    const btn=document.getElementById('auto-cancel-btn');
    const sub=document.getElementById('auto-subtitle');
    if(!confirm('Cancel ALL geva_extract orders (PENDING + SUBMITTED)?\\nAlso sends reqGlobalCancel to IB if CC2026 visualizer is up.')) return;
    btn.disabled=true;btn.textContent='Cancelling...';
    try{
      const d=await(await fetch('/api/cancel-all',{method:'POST'})).json();
      if(d.ok){
        const note='Cancelled '+d.cancelled+' rows in DB. IB: '+d.ib;
        if(sub) sub.textContent=note;
        refreshGlobalStatus();
      } else {
        alert('Cancel failed: '+(d.error||'unknown'));
      }
    }catch(e){
      alert('Cancel error: '+e.message);
    }finally{
      btn.disabled=false;btn.innerHTML='&#9746; Cancel All';
    }
  }

  async function toggleReplenish(enabled){
    const note=document.getElementById('replenish-note');
    const note2=document.getElementById('replenish-note2');
    if(note) note.textContent='saving...';
    if(note2) note2.textContent='saving...';
    try{
      await fetch('/api/replenish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
      const chk=document.getElementById('replenish-chk');
      const chk2=document.getElementById('replenish-chk2');
      if(chk) chk.checked=enabled;
      if(chk2) chk2.checked=enabled;
      if(note) note.textContent=enabled?'ON':'OFF';
      if(note2) note2.textContent=enabled?'ON':'OFF';
    }catch(e){
      if(note) note.textContent='error';
      if(note2) note2.textContent='error';
    }
  }
  </script>

  <div class="fetch-overlay" id="fetchOverlay">
    <div class="fetch-modal" id="fetchModal"></div>
  </div>
</body>
</html>`;
}

// ── Run extract ───────────────────────────────────────────────────────────────

let fetchRunning = false;

function runExtract() {
  return new Promise(resolve => {
    if (fetchRunning) { resolve({ ok: false, msg: 'already running' }); return; }
    fetchRunning = true;
    const child = spawn(process.execPath, [path.join(__dirname, 'extract.js')], {
      cwd: __dirname, timeout: 180_000,
    });
    const lines = [];
    child.stdout.on('data', d => lines.push(d.toString()));
    child.stderr.on('data', d => lines.push(d.toString()));
    child.on('close', code => {
      fetchRunning = false;
      if (code === 0) resolve({ ok: true, msg: 'Success' });
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

// Minimum tick distance from current market to entry — prevents immediate fills.
// 8 ticks = 2.0 points for MES/MNQ (tick = 0.25).
const MIN_ENTRY_TICKS = 8;

async function handleTradesCreate(body) {
  const symbols     = body.symbols     ?? ['MES', 'MNQ'];
  const brackets    = body.brackets    ?? BRACKETS.map(b => b.label);
  const minStrength = parseInt(body.minStrength) || 1;

  const db    = await openDb();
  const lines = db.getAllLines();
  db.close();

  if (!lines.length) return { ok: false, msg: 'No lines in DB. Run Fetch first.' };
  // Use most recent date (may be yesterday for pre-market usage)
  const latestDate = lines[0].date;
  const todayLines = lines.filter(l => l.date === latestDate);

  // Prefer IB live prices from galao.db (real-time, fed by broker) over Yahoo (15-min delayed).
  // Accurate prices are critical for the sanity filter — stale prices can miss near-market orders.
  const yahooPrices = priceFeed.getPrices();
  const prices = { MES: yahooPrices.MES, MNQ: yahooPrices.MNQ };
  try {
    const galaoP = await readGalaoDb();
    if (galaoP) {
      const ibMes = galaoP.getPrice('MES');
      const ibMnq = galaoP.getPrice('MNQ');
      if (ibMes) prices.MES = { price: ibMes.last_price, source: 'ib' };
      if (ibMnq) prices.MNQ = { price: ibMnq.last_price, source: 'ib' };
      galaoP.close();
    }
  } catch (_) {}

  if (!prices.MES?.price || !prices.MNQ?.price) {
    return { ok: false, msg: 'MES/MNQ price not available — wait 30s and retry' };
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

  // Load active geva orders for dedup — skip any (symbol, entry, tp, sl, direction) already in-flight.
  const activeKeys = new Set();
  try {
    const galaoD = await readGalaoDb();
    if (galaoD) {
      for (const o of galaoD.getActiveGevaOrders()) {
        activeKeys.add(`${o.symbol}|${o.entry_price}|${o.tp_price}|${o.sl_price}|${o.direction}`);
      }
      galaoD.close();
    }
  } catch (_) {}

  const priceFor = sym => sym === 'MES' ? prices.MES.price : prices.MNQ.price;
  const minDist  = MIN_ENTRY_TICKS * 0.25;

  let sanityFiltered = 0;
  let deduped        = 0;

  const passed = allCandidates.filter(c => {
    if (!symbols.includes(c.symbol))       return false;
    if (!brackets.includes(c._bracket))    return false;
    if (c.line_strength < minStrength)     return false;
    // Sanity: entry must be ≥ MIN_ENTRY_TICKS from current market.
    if (Math.abs(c.entry_price - priceFor(c.symbol)) < minDist) { sanityFiltered++; return false; }
    // Dedup: skip if an identical active order already exists in galao.db.
    const key = `${c.symbol}|${c.entry_price}|${c.tp_price}|${c.sl_price}|${c.direction}`;
    if (activeKeys.has(key)) { deduped++; return false; }
    return true;
  });

  const filtered = allCandidates.length - passed.length;
  return {
    ok: true,
    candidates:  passed,
    total:       allCandidates.length,
    passed:      passed.length,
    filtered,
    sanityFiltered,
    deduped,
    priceSource: { MES: prices.MES.source ?? 'yahoo', MNQ: prices.MNQ.source ?? 'yahoo' },
  };
}

async function handleSubmitCommands(body) {
  const { commands } = body;
  if (!Array.isArray(commands) || !commands.length) return { ok: false, msg: 'missing commands' };

  // Secondary sanity check (belt+suspenders): market may have moved since build was called.
  // Re-read prices and drop any order now within MIN_ENTRY_TICKS of market.
  const yahooPrices = priceFeed.getPrices();
  const prices = { MES: yahooPrices.MES, MNQ: yahooPrices.MNQ };
  try {
    const galaoP = await readGalaoDb();
    if (galaoP) {
      const ibMes = galaoP.getPrice('MES');
      const ibMnq = galaoP.getPrice('MNQ');
      if (ibMes) prices.MES = { price: ibMes.last_price };
      if (ibMnq) prices.MNQ = { price: ibMnq.last_price };
      galaoP.close();
    }
  } catch (_) {}

  const minDist   = MIN_ENTRY_TICKS * 0.25;
  const priceFor2 = sym => sym === 'MES' ? prices.MES?.price : prices.MNQ?.price;

  const safeCommands = commands.filter(c => {
    const p = priceFor2(c.symbol);
    if (!p) return true; // no price → can't validate, allow through
    return Math.abs(c.entry_price - p) >= minDist;
  });
  const sanityDropped = commands.length - safeCommands.length;

  // Strip _* client-only metadata fields before inserting
  const clean = safeCommands.map(c => ({
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
    strategy_variant: c.strategy_variant ?? null,
  }));

  if (!clean.length) {
    return { ok: true, inserted: 0, sanityDropped, msg: 'all candidates dropped by secondary sanity check' };
  }

  try {
    const result = await runPython([], clean);
    return result.ok
      ? { ok: true, inserted: result.inserted, sanityDropped }
      : { ok: false, msg: result.error ?? 'error' };
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

async function handleCancelAll() {
  // Step 1: try to hit CC2026 visualizer cancel-all (does IB reqGlobalCancel + full DB update)
  let ibResult = 'skipped';
  try {
    const resp = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: 5001, path: '/api/cancel-all', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
        res => {
          let raw = '';
          res.on('data', d => raw += d);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write('{}');
      req.end();
    });
    ibResult = resp.ib_cancel ?? 'ok';
  } catch (e) {
    ibResult = 'unavailable';
  }

  // Step 2: always do geva_extract-scoped DB cancel via Python bridge (idempotent)
  let dbResult;
  try {
    dbResult = await runPython(['--cancel']);
  } catch (e) {
    dbResult = { ok: false, error: e.message };
  }

  return { ok: dbResult.ok, cancelled: dbResult.cancelled ?? 0, ib: ibResult };
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

    if (req.method === 'GET' && url === '/api/today-lines') {
      try {
        const db    = await openDb();
        const lines = db.getAllLines();
        db.close();
        const date     = lines.length ? lines[0].date : null;
        const today    = new Date().toISOString().slice(0, 10);
        // getAllLines() is ORDER BY date DESC, so lines[0] is the most-recent row.
        // hasLines is "current" only when that most-recent row is dated today —
        // a stale row from a prior day must not read as current.
        const hasLines = lines.length > 0 && lines[0].date === today;
        const count    = date ? lines.filter(l => l.date === date).length : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hasLines, date, count, dbToday: today }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hasLines: false, error: err.message }));
      }
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

    if (req.method === 'POST' && url === '/api/cancel-all') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await handleCancelAll()));
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
