// price-feed.js
// Polls Yahoo Finance for MES=F and MNQ=F. No auth required, near-real-time.
const https = require('https');

const YAHOO_SYMS = { MES: 'MES=F', MNQ: 'MNQ=F' };
const cache = {};  // { MES: { price, ts }, MNQ: { price, ts } }

function fetchYahoo(sym) {
  return new Promise(resolve => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${YAHOO_SYMS[sym]}?interval=1m&range=1d`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const meta  = JSON.parse(raw)?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
          resolve(price !== null ? +price : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function refresh() {
  for (const sym of Object.keys(YAHOO_SYMS)) {
    const price = await fetchYahoo(sym);
    if (price !== null) cache[sym] = { price, ts: Date.now() };
  }
}

module.exports = {
  startPoller(ms = 30000) { refresh(); setInterval(refresh, ms); },
  getPrice(sym)  { return cache[sym] ?? null; },
  getPrices()    { return { MES: cache.MES ?? null, MNQ: cache.MNQ ?? null }; },
  refresh,
};
