// Historical backfill — uses Facebook's in-group search (far more reliable than
// scrolling the activity feed, which buries old posts under unrelated chatter)
// to find Geva's daily support/resistance posts and save the N most recent ones.
//
// Usage: node backfill.js [daysBack]   (default 5)
//
// Date resolution: Facebook no longer exposes usable post-timestamp metadata
// (no data-utime/title, and aria-labels are absent; the visible "time ago" text
// is deliberately scrambled and survives even computed-style filtering). The
// reliable signal is the Hebrew weekday name Geva writes into the post itself
// ("...יום שלישי,..."). Within a single weekday, search results are encountered
// in decreasing-recency order (verified against price-level continuity across
// consecutive posts), so the Nth time a given weekday is encountered maps to
// N*7 days before the most recent occurrence of that weekday.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR  = path.join(__dirname, 'fb-profile');
const OUTPUT_DIR   = path.join(__dirname, 'output');
const LOGS_DIR     = path.join(__dirname, 'logs');
const GROUP_ID     = '222428877934828';
const SEARCH_TERM  = 'קווי תמיכה';
const SEARCH_URL   = `https://www.facebook.com/groups/${GROUP_ID}/search/?q=${encodeURIComponent(SEARCH_TERM)}`;
const POST_SEL     = 'div[role="feed"] > div, div[role="article"]';
const MAX_TEXT_LEN = 5000; // longer nodes are aggregate/wrapper garbage, not a single post
const MAX_SCROLLS  = 30;
const NO_NEW_LIMIT = 4;

const WEEKDAY_MAP = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
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
  // Search-result posts embed a truncated preview copy followed by the full
  // expanded copy ("...See more<slug>.comOren**בוקר טוב...**"). Isolate the
  // expanded copy (from the LAST "בוקר טוב") before parsing, so each label
  // ("קווי תמיכה"/"קווי התנגדות") only appears once and the terminator
  // lookaheads (next label / "סימן" / url / end) land correctly.
  const lastIdx = text.lastIndexOf('בוקר טוב');
  const clean = lastIdx >= 0 ? text.slice(lastIdx) : text;
  const support    = clean.match(/קווי תמיכה[\s\S]+?(?=קווי התנגדות)/)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  const resistance = clean.match(/קווי התנגדות[\s\S]+?(?=סימן|https?:|$)/)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  return { support, resistance };
}

function buildTxt(data) {
  return [
    `DATE: ${data.date}`,
    `DAY: ${data.day}`,
    `SOURCE: ${data.groupUrl}`,
    `POST URL: ${data.postUrl ?? 'unknown'}`,
    '',
    'SUPPORT:',
    data.support ?? '(not found)',
    '',
    'RESISTANCE:',
    data.resistance ?? '(not found)',
    '',
    'FULL POST:',
    data.fullText,
  ].join('\n');
}

function alreadySaved(date) {
  return fs.existsSync(path.join(OUTPUT_DIR, `Geva_${date}.txt`));
}

function savePost(data) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = `Geva_${data.date}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.txt`),  buildTxt(data), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.json`), JSON.stringify(data, null, 2), 'utf8');
  log(`  Saved: ${base}.txt`);
}

// Resolves a Hebrew weekday name + "how many times we've already seen this
// weekday" into an actual calendar date, anchored at `today`.
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
  const daysBack = parseInt(process.argv[2], 10) || 5;
  log(`=== Backfill started (target: ${daysBack} most recent posts) ===`);

  if (!fs.existsSync(PROFILE_DIR)) {
    log('ERROR: No saved Facebook session. Run "node save-auth.js" first.');
    process.exit(1);
  }

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--start-maximized'],
    viewport: null,
  });
  const page = browser.pages()[0] || await browser.newPage();

  try {
    log(`Navigating to group search: ${SEARCH_URL}`);
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    if (page.url().includes('login') || page.url().includes('checkpoint')) {
      log('ERROR: Not logged in or checkpoint. Re-run save-auth.js.');
      process.exit(1);
    }

    const seenBodies = new Set();
    const collected = []; // { fullText, postUrl }
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
        log(`Scroll ${scroll + 1} — no new content (${noNewContent}/${NO_NEW_LIMIT})`);
        if (noNewContent >= NO_NEW_LIMIT) { log('Search results exhausted.'); break; }
      } else {
        noNewContent = 0;
        log(`Scroll ${scroll + 1} — ${collected.length} unique posts collected so far (+${newCount})`);
      }

      // Once we likely have enough distinct posts to cover daysBack (with buffer
      // for weekday collisions), stop scrolling — search is expensive and the
      // group has months of history we don't need for a shallow backfill.
      if (collected.length >= daysBack + 4) {
        log('Collected enough candidates for requested depth, stopping scroll.');
        break;
      }
    }

    log(`Total unique candidate posts collected: ${collected.length}`);

    // Resolve dates: count occurrences per weekday in encounter order.
    const today = new Date();
    const occurrenceCount = {};
    const resolved = [];
    for (const m of collected) {
      const dayMatch = m.fullText.match(/יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
      if (!dayMatch) {
        log('  Skipping — no weekday name found in post text.');
        continue;
      }
      const wd = dayMatch[1];
      const occIdx = occurrenceCount[wd] ?? 0;
      occurrenceCount[wd] = occIdx + 1;
      const date = resolveDate(wd, occIdx, today);
      resolved.push({ date, ...m });
    }

    resolved.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    const target = resolved.slice(0, daysBack);

    let savedCount = 0, skippedAlready = 0;
    for (const r of target) {
      if (alreadySaved(r.date)) {
        log(`  Already saved: ${r.date} — skipping`);
        skippedAlready++;
        continue;
      }
      const { support, resistance } = extractLines(r.fullText);
      savePost({
        date: r.date,
        day: getHebrewDay(r.date),
        support,
        resistance,
        fullText: r.fullText,
        postUrl: r.postUrl,
        groupUrl: `https://www.facebook.com/groups/${GROUP_ID}/`,
        capturedAt: new Date().toISOString(),
      });
      savedCount++;
    }

    log(`=== Backfill complete: ${savedCount} saved, ${skippedAlready} already existed, ${resolved.length - target.length} beyond requested depth ===`);

  } finally {
    await browser.close();
  }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
