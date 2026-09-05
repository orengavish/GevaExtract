// Historical backfill — finds Geva's daily support/resistance posts and saves
// them all to the DB. Two collectors:
//   default    — Facebook's in-group search (fast, but the result set is capped
//                by FB's own relevance ranking — ~74 posts, exhausts quickly).
//   --profile  — Geva's own post history within the group (his profile page,
//                filtered to the group), scrolled reverse-chronologically with
//                no early-exit budget: it doesn't stop at "enough", it stops
//                when Geva's feed itself runs out (his very first S/R post).
//                Much slower and the page has no stable role/selector
//                landmarks, so posts are found by content (climb from a
//                "קווי תמיכה" text node to the ancestor bracketing the whole
//                בוקר טוב...קווי התנגדות body) instead of a CSS selector.
//
// Usage: node backfill.js [--profile] [--headed] [--since YYYY-MM-DD]
//
// Date resolution (both collectors): each post's real publish date is read
// straight from Facebook's embedded JSON (`story.creation_time`) on the post's
// own permalink. The old approach — counting weekday occurrences in the search
// feed and mapping the Nth "יום רביעי" to N*7 days back — was unsound (FB search
// is not strictly reverse-chronological and every skipped week compounded the
// drift), and had mis-dated 46 of 50 rows by up to ~6 months. Don't bring it back.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { openDb } = require('./db');

const PROFILE_DIR   = path.join(__dirname, 'fb-profile');
const LOGS_DIR      = path.join(__dirname, 'logs');
const GROUP_ID      = '222428877934828';
const GEVA_USER_ID  = '753788186';
const SEARCH_TERM   = 'קווי תמיכה';
const RESIST_TERM   = 'קווי התנגדות';
const QUERY_ARG     = (() => { const i = process.argv.indexOf('--query'); return i > -1 ? process.argv[i + 1] : null; })();
const SEARCH_URL    = `https://www.facebook.com/groups/${GROUP_ID}/search/?q=${encodeURIComponent(QUERY_ARG || SEARCH_TERM)}`;
const PROFILE_URL   = `https://www.facebook.com/groups/${GROUP_ID}/user/${GEVA_USER_ID}/?sorting_setting=CHRONOLOGICAL`;
// The real unbounded history: the plain group feed (not search, not the
// profile widget — both of those are capped by FB itself, confirmed). Same
// sorting_setting=CHRONOLOGICAL param extract.js's GROUP_URL sibling accepts.
const GROUP_FEED_URL = `https://www.facebook.com/groups/${GROUP_ID}/?sorting_setting=CHRONOLOGICAL`;
const POST_SEL      = 'div[role="feed"] > div, div[role="article"]';
const MAX_TEXT_LEN  = 5000;
const MAX_SCROLLS   = 500;  // safety valve — real stop condition is NO_NEW_LIMIT below
const NO_NEW_LIMIT  = 20;   // was 6: too impatient, gave up while FB was still loading more
const MAX_SCROLLS_PROFILE  = 3000;  // safety valve only — expected to stop earlier via NO_NEW_LIMIT_PROFILE
const NO_NEW_LIMIT_PROFILE = 20;    // don't give up until 20 straight empty scrolls (with growing waits below)

const WEEKDAY_MAP   = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
const WEEKDAY_NAMES = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'יום שבת'];

const HEADED  = process.argv.includes('--headed');
const PROFILE_MODE = process.argv.includes('--profile');
const ALLFEED_MODE = process.argv.includes('--allfeed');
const SINCE   = (() => { const i = process.argv.indexOf('--since'); return i > -1 ? process.argv[i + 1] : null; })();

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

// Geva's own post history within the group has no stable role/selector
// landmarks (no role="feed"/"article", just obfuscated FB classes) — find
// posts by content instead: climb from each "קווי תמיכה" text node to the
// ancestor whose text brackets the whole בוקר טוב...קווי התנגדות body, then
// look for a permalink in that ancestor (widening a few levels if needed).
async function scanProfileMatches(page) {
  return await page.evaluate(([sa, sr, maxLen]) => {
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
    const PATTERNS = [
      'a[href*="/groups/"][href*="/posts/"]',
      'a[href*="facebook.com"][href*="fbid="]',
      'a[href*="facebook.com"][href*="/permalink/"]',
      'a[href*="/photo/"]',
    ];
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.includes(sa)) continue;
      let el = node.parentElement, container = null;
      for (let i = 0; i < 25 && el && el !== document.body; i++) {
        const t = clean(el.textContent || '');
        if (t.length > maxLen) break;
        if (t.includes('בוקר טוב') && t.includes(sr)) container = el;
        el = el.parentElement;
      }
      if (!container) continue;
      const full = clean(container.textContent || '');
      const idx = full.lastIndexOf('בוקר טוב');
      if (idx < 0) continue;
      const body = full.slice(idx).trim();
      if (!body.includes(sr)) continue;

      let postUrl = null, scan = container;
      for (let i = 0; i < 5 && scan && !postUrl; i++) {
        for (const pat of PATTERNS) {
          const a = scan.querySelector(pat);
          if (a) { postUrl = a.href; break; }
        }
        scan = scan.parentElement;
      }
      out.push({ fullText: body, postUrl });
    }
    return out;
  }, [SEARCH_TERM, RESIST_TERM, MAX_TEXT_LEN]);
}

// Gate patience on actual new matches, not scrollHeight: FB search can leave
// scrollHeight flat for several scrolls while it's still loading the next page
// in the background (spinner state), which used to read as "exhausted" after
// just NO_NEW_LIMIT(6) x ~4s — long before FB had actually delivered more. That
// stopped this collector at 2025-09-03 when at least one earlier post
// (2025-09-02) exists and is reachable by hand. Same fix as collectFromProfile:
// high patience + a growing wait, gated on newCount.
async function collectFromSearch(page) {
  const seenBodies = new Set();
  const collected  = [];
  let noNewContent = 0;
  let waitMs = 1500;

  for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
    await expandAllSeeMore(page);
    const matches = await scanMatches(page);
    let newCount = 0;
    for (const m of matches) {
      if (seenBodies.has(m.fullText)) continue;
      seenBodies.add(m.fullText);
      collected.push(m);
      newCount++;
    }

    if (newCount > 0) {
      noNewContent = 0;
      waitMs = 1500;
      log(`Scroll ${scroll + 1} — ${collected.length} unique posts (+${newCount})`);
    } else {
      noNewContent++;
      waitMs = Math.min(waitMs + 500, 6000);
      log(`Scroll ${scroll + 1} — no new matches (${noNewContent}/${NO_NEW_LIMIT})`);
      if (noNewContent >= NO_NEW_LIMIT) { log('Search results exhausted.'); break; }
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(waitMs * 0.4);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5));
    await page.waitForTimeout(waitMs);
  }
  return collected;
}

// No early exit on "enough" — only stops on NO_NEW_LIMIT_PROFILE consecutive
// empty scrolls (with a growing wait between them, to ride out slow lazy-load),
// or the MAX_SCROLLS_PROFILE safety valve. The goal is Geva's very first post.
// Click every currently-visible "See more"/"ראה עוד" expander so truncated
// posts render their full body before we scan for קווי תמיכה/קווי התנגדות.
async function expandAllSeeMore(page) {
  const sels = [
    'div[role="button"]:has-text("See more")', 'div[role="button"]:has-text("ראה עוד")',
    'span[role="button"]:has-text("See more")', 'span[role="button"]:has-text("ראה עוד")',
  ];
  for (const sel of sels) {
    const buttons = await page.$$(sel).catch(() => []);
    for (const btn of buttons) {
      try { await btn.click({ timeout: 1000 }); await page.waitForTimeout(300); } catch {}
    }
  }
}

// Shared scroll-and-collect loop: no early exit on "enough", only on
// NO_NEW_LIMIT_PROFILE consecutive empty scrolls (growing wait between them,
// to ride out slow lazy-load) or the MAX_SCROLLS_PROFILE safety valve. Used by
// both --profile (bounded widget, kept for completeness) and --allfeed (the
// actual unbounded history — see GROUP_FEED_URL above).
async function collectWithPatience(page, scanFn, label) {
  const seenBodies = new Set();
  const collected  = [];
  let noNewContent = 0;
  let waitMs = 1500;

  for (let scroll = 0; scroll < MAX_SCROLLS_PROFILE; scroll++) {
    await expandAllSeeMore(page);
    const matches = await scanFn(page);
    let newCount = 0;
    for (const m of matches) {
      if (seenBodies.has(m.fullText)) continue;
      seenBodies.add(m.fullText);
      collected.push(m);
      newCount++;
    }

    if (newCount > 0) {
      noNewContent = 0;
      waitMs = 1500;
      log(`${label} scroll ${scroll + 1} — ${collected.length} unique posts (+${newCount})`);
    } else {
      noNewContent++;
      waitMs = Math.min(waitMs + 500, 6000);
      log(`${label} scroll ${scroll + 1} — no new posts (${noNewContent}/${NO_NEW_LIMIT_PROFILE})`);
      if (noNewContent >= NO_NEW_LIMIT_PROFILE) {
        log(`${label} feed exhausted.`);
        break;
      }
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2.2));
    await page.waitForTimeout(waitMs);
    if (scroll === MAX_SCROLLS_PROFILE - 1) {
      log(`WARNING: hit MAX_SCROLLS_PROFILE (${MAX_SCROLLS_PROFILE}) — stopped by the safety valve, not because the feed ran out.`);
    }
  }
  return collected;
}

// The search RESULTS page's own filter bar reads "Filters / Posts You've Seen /
// Most recent / Date posted" — different labels from the plain group homepage's
// "Most relevant / Recent activity / New posts" dropdown (that one only applies
// there, confirmed separately; never wire it to this page). Click whichever
// recency label is actually present here so search results page chronologically
// instead of by (unstable) relevance ranking.
async function switchToNewestFirst(page) {
  for (const label of ['Most recent', 'Recent activity', 'New posts', 'Most recent activity']) {
    try {
      await page.locator(`div[role="button"]:has-text("${label}"), span:has-text("${label}")`)
        .first().click({ timeout: 3000 });
      await page.waitForTimeout(3000);
      log(`Search sort switched to "${label}".`);
      return true;
    } catch {}
  }
  log('WARNING: could not find a recency sort control on the search page — continuing with default relevance ranking.');
  return false;
}

async function main() {
  const mode = PROFILE_MODE ? 'profile' : ALLFEED_MODE ? 'allfeed' : 'search';
  log(`=== Backfill started (${mode} mode, real-date resolution)${SINCE ? ` — since ${SINCE}` : ''} ===`);

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
    const url = PROFILE_MODE ? PROFILE_URL : ALLFEED_MODE ? GROUP_FEED_URL : SEARCH_URL;
    log(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    if (page.url().includes('login') || page.url().includes('checkpoint')) {
      log('ERROR: Not logged in or checkpoint. Re-run save-auth.js.');
      process.exit(1);
    }

    if (mode === 'search') await switchToNewestFirst(page);

    const collected =
      mode === 'profile' ? await collectWithPatience(page, scanProfileMatches, 'Profile') :
      mode === 'allfeed' ? await collectWithPatience(page, scanMatches, 'Group feed') :
      await collectFromSearch(page);
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
      db.save(); // flush after every save — this run can take hours; don't lose it to a crash mid-way
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
