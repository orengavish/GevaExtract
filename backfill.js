// Historical backfill — uses Facebook's in-group search to find Geva's daily
// support/resistance posts and save them all to the DB.
//
// Usage: node backfill.js
//
// Scrolls until FB search is exhausted (NO_NEW_LIMIT consecutive empty scrolls).
// Date resolution: the Hebrew weekday name Geva writes into the post is the
// only reliable signal (FB hides timestamp metadata). Posts are encountered
// newest-first within each weekday, so the Nth occurrence of a weekday maps
// to N*7 days before the most recent occurrence of that weekday.

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

function toDateStr(d) { return d.toISOString().split('T')[0]; }
function getHebrewDay(dateStr) { return WEEKDAY_NAMES[new Date(dateStr).getDay()]; }

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

function resolveDate(weekdayHebrew, occurrenceIndex, today) {
  const targetDow = WEEKDAY_MAP[weekdayHebrew];
  if (targetDow === undefined) return null;
  const d = new Date(today);
  while (d.getDay() !== targetDow) d.setDate(d.getDate() - 1);
  d.setDate(d.getDate() - 7 * occurrenceIndex);
  return toDateStr(d);
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
      const bodyMatch = c.match(/בוקר טוב[\s\S]+?בלבד\./);
      if (!bodyMatch) continue;

      let postUrl = null;
      for (const pat of [
        'a[href*="/groups/"][href*="/posts/"]',
        'a[href*="facebook.com"][href*="fbid="]',
        'a[href*="facebook.com"][href*="/permalink/"]',
      ]) {
        const a = post.querySelector(pat);
        if (a) { postUrl = a.href; break; }
      }

      out.push({ fullText: bodyMatch[0].trim(), postUrl });
    }
    return out;
  }, [SEARCH_TERM, POST_SEL, MAX_TEXT_LEN]);
}

async function main() {
  log('=== Backfill started — scrolling until FB search exhausted ===');

  if (!fs.existsSync(PROFILE_DIR)) {
    log('ERROR: No saved Facebook session. Run "node save-auth.js" first.');
    process.exit(1);
  }

  const db = await openDb();

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
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

    // Resolve dates: count occurrences per weekday in encounter order (newest first).
    const today = new Date();
    const occurrenceCount = {};
    const resolved = [];
    for (const m of collected) {
      const dayMatch = m.fullText.match(/יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
      if (!dayMatch) { log('  Skipping — no weekday name in post.'); continue; }
      const wd = dayMatch[1];
      const occIdx = occurrenceCount[wd] ?? 0;
      occurrenceCount[wd] = occIdx + 1;
      const date = resolveDate(wd, occIdx, today);
      if (date) resolved.push({ date, ...m });
    }

    resolved.sort((a, b) => (a.date < b.date ? 1 : -1));

    let savedCount = 0, skippedCount = 0;
    for (const r of resolved) {
      if (db.postExists(r.date)) {
        log(`  Already in DB: ${r.date} — skipping`);
        skippedCount++;
        continue;
      }
      const { support, resistance } = extractLines(r.fullText);
      db.upsertPost({
        date:       r.date,
        day:        getHebrewDay(r.date),
        support,
        resistance,
        fullText:   r.fullText,
        postUrl:    r.postUrl,
        capturedAt: new Date().toISOString(),
        source:     'backfill',
      });
      log(`  Saved: ${r.date}`);
      savedCount++;
    }

    db.save();
    log(`=== Backfill complete: ${savedCount} saved, ${skippedCount} already in DB ===`);

  } finally {
    db.close();
    await browser.close();
  }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
