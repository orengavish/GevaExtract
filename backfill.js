// Historical backfill — uses Facebook's in-group search to find Geva's daily
// support/resistance posts and save them all to the DB.
//
// Usage: node backfill.js [--headed] [--since YYYY-MM-DD]
//
// Date resolution: each post's real publish date is read straight from Facebook's
// embedded JSON (`story.creation_time`) on the post's own permalink. The old
// approach — counting weekday occurrences in the search feed and mapping the Nth
// "יום רביעי" to N*7 days back — was unsound (FB search is not strictly
// reverse-chronological and every skipped week compounded the drift), and had
// mis-dated 46 of 50 rows by up to ~6 months. Don't bring it back.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { openDb } = require('./db');

const PROFILE_DIR  = path.join(__dirname, 'fb-profile');
const LOGS_DIR     = path.join(__dirname, 'logs');
const GROUP_ID     = '222428877934828';
const SEARCH_TERM  = 'קווי תמיכה';
const SEARCH_URL   = `https://www.facebook.com/groups/${GROUP_ID}/search/?q=${encodeURIComponent(SEARCH_TERM)}`;
const POST_SEL     = 'div[role="feed"] > div, div[role="article"]';
const MAX_TEXT_LEN = 5000;
const MAX_SCROLLS  = 200;
const NO_NEW_LIMIT = 6;

const WEEKDAY_MAP   = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
const WEEKDAY_NAMES = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'יום שבת'];

const HEADED = process.argv.includes('--headed');
const SINCE  = (() => { const i = process.argv.indexOf('--since'); return i > -1 ? process.argv[i + 1] : null; })();

function toDateStr(d) { return d.toISOString().split('T')[0]; }
function getHebrewDay(dateStr) { return WEEKDAY_NAMES[new Date(dateStr + 'T12:00:00Z').getUTCDay()]; }

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, 'backfill.log'), line + '\n', 'utf8');
  } catch {}
}

function extractLines(text) {
  const lastIdx = text.lastIndexOf('בוקר טוב');
  const clean = lastIdx >= 0 ? text.slice(lastIdx) : text;
  const support    = clean.match(/קווי תמיכה[\s\S]+?(?=קווי התנגדות)/)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  const resistance = clean.match(/קווי התנגדות[\s\S]+?(?=סימן|https?:|$)/)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  return { support, resistance };
}

function weekdayInText(text) {
  const m = text.match(/יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
  return m ? WEEKDAY_MAP[m[1]] : null;
}

// Read a post's real publish date from Facebook's embedded JSON on its permalink.
async function realDateFor(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const html = await page.content();

  let ts = null;
  const story = html.match(/"story":\{"creation_time":(\d{10})/);
  if (story) {
    ts = +story[1];
  } else {
    const all = [...html.matchAll(/"creat(?:ion|ed)_time":(\d{10})/g)].map(m => +m[1]);
    if (all.length) {
      const freq = {};
      for (const v of all) freq[v] = (freq[v] || 0) + 1;
      ts = +Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }
  }
  return ts ? new Date(ts * 1000) : null;
}

async function scanMatches(page) {
  return await page.evaluate(([sa, sel, maxLen]) => {
    function clean(text) {
      let out = '';
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (
          c === 0x00AD || (c >= 0x200B && c <= 0x200F) ||
          (c >= 0x202A && c <= 0x202E) || (c >= 0x2060 && c <= 0x2064) || c === 0xFEFF
        ) continue;
        out += text[i];
      }
      return out;
    }
    const posts = Array.from(document.querySelectorAll(sel));
    const out = [];
    for (const post of posts) {
      const raw = post.textContent || '';
      if (raw.length > maxLen) continue;
      const c = clean(raw);
      if (!c.includes(sa)) continue;
      const idx = c.lastIndexOf('בוקר טוב');
      if (idx < 0) continue;
      const body = c.slice(idx, idx + maxLen).trim();
      if (!body.includes('קווי התנגדות')) continue;

      let postUrl = null;
      for (const pat of [
        'a[href*="/groups/"][href*="/posts/"]',
        'a[href*="facebook.com"][href*="fbid="]',
        'a[href*="facebook.com"][href*="/permalink/"]',
        'a[href*="/photo/"]',
      ]) {
        const a = post.querySelector(pat);
        if (a) { postUrl = a.href; break; }
      }

      out.push({ fullText: body, postUrl });
    }
    return out;
  }, [SEARCH_TERM, POST_SEL, MAX_TEXT_LEN]);
}

async function main() {
  log(`=== Backfill started (real-date mode)${SINCE ? ` — since ${SINCE}` : ''} ===`);

  if (!fs.existsSync(PROFILE_DIR)) {
    log('ERROR: No saved Facebook session. Run "node save-auth.js" first.');
    process.exit(1);
  }

  const db = await openDb();

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADED,
    args: ['--start-maximized'],
    viewport: null,
  });
  const page = browser.pages()[0] || await browser.newPage();

  try {
    log(`Navigating to: ${SEARCH_URL}`);
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    if (page.url().includes('login') || page.url().includes('checkpoint')) {
      log('ERROR: Not logged in or checkpoint. Re-run save-auth.js.');
      process.exit(1);
    }

    const seenBodies = new Set();
    const collected  = [];
    let noNewContent = 0;

    for (let scroll = 0; scroll <= MAX_SCROLLS; scroll++) {
      const matches = await scanMatches(page);
      let newCount = 0;
      for (const m of matches) {
        if (seenBodies.has(m.fullText)) continue;
        seenBodies.add(m.fullText);
        collected.push(m);
        newCount++;
      }

      if (scroll === MAX_SCROLLS) break;

      const before = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5));
      await page.waitForTimeout(2800);
      const after = await page.evaluate(() => document.body.scrollHeight);

      if (after === before) {
        noNewContent++;
        log(`Scroll ${scroll + 1} — no new content (${noNewContent}/${NO_NEW_LIMIT}), total collected: ${collected.length}`);
        if (noNewContent >= NO_NEW_LIMIT) { log('Search results exhausted.'); break; }
      } else {
        noNewContent = 0;
        log(`Scroll ${scroll + 1} — ${collected.length} unique posts (+${newCount})`);
      }
    }

    log(`Total unique candidate posts: ${collected.length}`);

    let saved = 0, skipExisting = 0, skipNoUrl = 0, skipWeekday = 0, skipNoDate = 0, skipSince = 0;
    for (const m of collected) {
      if (!m.postUrl) { skipNoUrl++; log('  skip — no permalink for a candidate post'); continue; }

      const d = await realDateFor(page, m.postUrl).catch(() => null);
      if (!d) { skipNoDate++; log(`  skip — no FB timestamp: ${m.postUrl}`); continue; }
      const date = toDateStr(d);

      const wdText = weekdayInText(m.fullText);
      if (wdText !== null && wdText !== d.getUTCDay()) {
        skipWeekday++;
        log(`  skip — weekday mismatch: FB date ${date} (${WEEKDAY_NAMES[d.getUTCDay()]}) vs text "${WEEKDAY_NAMES[wdText]}" — ${m.postUrl}`);
        continue;
      }

      if (SINCE && date < SINCE) { skipSince++; continue; }
      if (db.postExists(date)) { skipExisting++; log(`  already in DB: ${date}`); continue; }

      const { support, resistance } = extractLines(m.fullText);
      db.upsertPost({
        date,
        day:        getHebrewDay(date),
        support,
        resistance,
        fullText:   m.fullText,
        postUrl:    m.postUrl,
        capturedAt: new Date().toISOString(),
        source:     'backfill',
      });
      log(`  saved: ${date}`);
      saved++;
    }

    db.save();
    log(`=== Backfill complete: ${saved} saved | ${skipExisting} already in DB | ` +
        `${skipSince} before --since | ${skipWeekday} weekday-mismatch | ${skipNoUrl} no-url | ${skipNoDate} no-date ===`);

  } finally {
    db.close();
    await browser.close();
  }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
