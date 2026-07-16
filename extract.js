// Daily extraction script.
// Usage: node extract.js [YYYY-MM-DD]
// The optional date is an anchor for weekday resolution (defaults to today) —
// see resolveDateFromWeekday() below for why the post date is derived from the
// Hebrew weekday name Geva writes into the post rather than from DOM metadata.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, 'fb-profile');
const OUTPUT_DIR = path.join(__dirname, 'output');
const LOGS_DIR = path.join(__dirname, 'logs');
const GROUP_URL = 'https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY';
const MAX_SCROLLS = 40;
const SCROLL_PAUSE_MS = 2800;

// ── Date helpers ─────────────────────────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

function getHebrewDay(dateStr) {
  const days = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'יום שבת'];
  return days[new Date(dateStr).getDay()];
}

const WEEKDAY_MAP = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };

// Facebook no longer exposes usable post-timestamp metadata (no data-utime or
// title attributes, and the visible "time ago" text is deliberately scrambled
// so it survives even computed-style filtering). The reliable signal is the
// Hebrew weekday name Geva writes into the post itself ("...יום שלישי,...").
// Resolve it to the most recent date <= anchorDate with that weekday.
function resolveDateFromWeekday(text, anchorDate) {
  const m = text.match(/יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
  if (!m) return null;
  const targetDow = WEEKDAY_MAP[m[1]];
  const d = new Date(anchorDate);
  while (d.getDay() !== targetDow) d.setDate(d.getDate() - 1);
  return toDateStr(d);
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, 'extract.log'), line + '\n');
  } catch {}
}

// ── Text normalization ────────────────────────────────────────────────────────

// Facebook injects invisible Unicode control/directional characters into DOM text
// to prevent scraping. Strip them before any string matching.
function clean(text) {
  // Strip invisible Unicode chars Facebook injects (directional marks, bidi overrides, BOM, etc.)
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      c === 0x00AD ||                      // soft hyphen
      (c >= 0x200B && c <= 0x200F) ||      // zero-width space + directional marks
      (c >= 0x202A && c <= 0x202E) ||      // bidi embedding / override
      (c >= 0x2060 && c <= 0x2064) ||      // invisible operators
      c === 0xFEFF                          // BOM / zero-width no-break space
    ) continue;
    out += text[i];
  }
  return out;
}

// ── Post scanning ─────────────────────────────────────────────────────────────

// Hebrew search strings as Unicode escapes so encoding never matters.
// קווי = קווי
// תמיכה = תמיכה
// התנגדות = התנגדות
const SEARCH_SUPPORT    = 'קווי תמיכה';
const SEARCH_RESISTANCE = 'קווי התנגדות';

async function findMatchingPost(page) {
  for (let scroll = 0; scroll <= MAX_SCROLLS; scroll++) {
    // Run the entire search inside the browser to avoid any Node.js/Playwright
    // text-serialization issues with Hebrew and invisible Unicode.
    const result = await page.evaluate(([sa, sr]) => {
      // Try selectors from most specific to least; stop at first that has > 3 matches
      const candidates = [
        'div[role="feed"] > div',
        '[aria-posinset]',
        'div[role="article"]',
      ];
      let posts = [];
      let usedSel = '';
      for (const sel of candidates) {
        const els = Array.from(document.querySelectorAll(sel));
        if (els.length > 3) { posts = els; usedSel = sel; break; }
      }
      for (let i = 0; i < posts.length; i++) {
        const t = posts[i].textContent || '';
        if (t.includes(sa) && t.includes(sr)) return { found: true, index: i, sel: usedSel };
      }
      return { found: false, count: posts.length, sel: usedSel };
    }, [SEARCH_SUPPORT, SEARCH_RESISTANCE]);

    if (result.found) {
      log(`Matching post found (selector: ${result.sel}).`);
      const posts = await page.$$(result.sel);
      return posts[result.index] ?? null;
    }

    if (scroll === MAX_SCROLLS) break;

    log(`Scroll ${scroll + 1}/${MAX_SCROLLS} — ${result.count ?? 0} posts [${result.sel}] visible, no match yet...`);

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5));
    await page.waitForTimeout(SCROLL_PAUSE_MS);

    const atBottom = await page.evaluate(
      () => window.scrollY + window.innerHeight >= document.body.scrollHeight - 200
    );
    if (atBottom) {
      log('Reached bottom of page.');
      break;
    }
  }

  return null;
}

// ── See more ──────────────────────────────────────────────────────────────────

async function expandSeeMore(article) {
  const selectors = [
    'div[role="button"]:has-text("See more")',
    'div[role="button"]:has-text("ראה עוד")',
    'span[role="button"]:has-text("See more")',
    'span[role="button"]:has-text("ראה עוד")',
  ];
  for (const sel of selectors) {
    try {
      const btn = await article.$(sel);
      if (btn) {
        await btn.click();
        await article.page().waitForTimeout(1200);
        log('Expanded "See more".');
        return;
      }
    } catch {}
  }
  log('No "See more" button found (post may already be fully expanded).');
}

// ── Date detection ────────────────────────────────────────────────────────────

async function detectPostDate(article) {
  // Strategy 1: data-utime (Unix timestamp on abbr elements)
  try {
    const utime = await article.$eval('[data-utime]', el => el.getAttribute('data-utime'));
    if (utime) return toDateStr(new Date(parseInt(utime, 10) * 1000));
  } catch {}

  // Strategy 2: aria-label on timestamp links (e.g. "July 12, 2026 at 7:30 AM")
  const timeSelectors = ['a[aria-label]', 'span[aria-label]', 'abbr[aria-label]'];
  for (const sel of timeSelectors) {
    try {
      const labels = await article.$$eval(sel, els =>
        els.map(el => el.getAttribute('aria-label')).filter(Boolean)
      );
      for (const label of labels) {
        const parsed = new Date(label);
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2020) {
          return toDateStr(parsed);
        }
      }
    } catch {}
  }

  // Strategy 3: title attribute on time/abbr elements
  try {
    const titles = await article.$$eval('abbr[title], time[title]', els =>
      els.map(el => el.getAttribute('title')).filter(Boolean)
    );
    for (const t of titles) {
      const parsed = new Date(t);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2020) {
        return toDateStr(parsed);
      }
    }
  } catch {}

  return null;
}

// ── Post URL ──────────────────────────────────────────────────────────────────

async function detectPostUrl(article) {
  // Try several link patterns; Facebook uses different URL shapes per context
  const patterns = [
    'a[href*="/groups/"][href*="/posts/"]',
    'a[href*="facebook.com"][href*="fbid="]',
    'a[href*="facebook.com"][href*="/permalink/"]',
    'a[href*="facebook.com"][href*="/groups/"]',
  ];
  for (const pat of patterns) {
    try {
      const hrefs = await article.$$eval(pat, els => els.map(el => el.href));
      if (hrefs.length) return hrefs[0];
    } catch {}
  }
  return null;
}

// ── Clean post body ───────────────────────────────────────────────────────────

async function extractPostBody(article) {
  // Use browser innerText (respects CSS visibility) then trim to the Hebrew post body.
  const raw = await article.evaluate(el => el.innerText || el.textContent || '').catch(() => '');
  // The post starts at "בוקר טוב" and the useful content ends at "בלבד." (disclaimer end)
  // Fall back to full raw text if the pattern isn't found.
  const match = raw.match(/בוקר טוב[\s\S]+?בלבד\./);
  return (match ? match[0] : raw).trim();
}

// ── Text extraction ───────────────────────────────────────────────────────────

function extractLines(text) {
  // textContent has no newlines between sections; stop each line at the next section marker.
  // Support stops at "קווי התנגדות"; resistance stops at "סימן" (legend text).
  const support    = text.match(/קווי תמיכה[\s\S]+?(?=קווי התנגדות)/)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  const resistance = text.match(/קווי התנגדות[\s\S]+?(?=סימן|https?:|$)/)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  return { support, resistance };
}

// ── File output ───────────────────────────────────────────────────────────────

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

function saveFiles(data) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const base = `Geva_${data.date}`;
  const txtPath = path.join(OUTPUT_DIR, `${base}.txt`);
  const jsonPath = path.join(OUTPUT_DIR, `${base}.json`);

  if (fs.existsSync(txtPath)) {
    log(`WARNING: ${base}.txt already exists — saving as duplicate.`);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(OUTPUT_DIR, `${base}_dup_${ts}.txt`), buildTxt(data));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${base}_dup_${ts}.json`), JSON.stringify(data, null, 2));
    return;
  }

  fs.writeFileSync(txtPath, buildTxt(data));
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  log(`Saved: ${txtPath}`);
  log(`Saved: ${jsonPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const anchorDate = process.argv[2] ? new Date(process.argv[2]) : new Date();
  log(`=== Starting extraction — anchor date: ${toDateStr(anchorDate)} ===`);

  if (!fs.existsSync(PROFILE_DIR)) {
    log('ERROR: Facebook session not found. Run "node save-auth.js" first.');
    process.exit(1);
  }

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--start-maximized'],
    viewport: null,
  });

  const page = browser.pages()[0] || await browser.newPage();

  try {
    log('Navigating to Facebook group...');
    await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);

    // Detect login/checkpoint
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      log('ERROR: Not logged in or Facebook checkpoint detected. Re-run save-auth.js.');
      process.exit(1);
    }

    log('Page loaded. Scanning for matching post...');
    const article = await findMatchingPost(page);

    if (!article) {
      log('ERROR: No post found containing both "קווי תמיכה" and "קווי התנגדות".');
      log('The post may not be published yet, or Facebook loaded differently today.');
      process.exit(1);
    }

    await expandSeeMore(article);

    const fullText = await extractPostBody(article);
    const { support, resistance } = extractLines(fullText);

    const domDate = await detectPostDate(article);
    const weekdayDate = resolveDateFromWeekday(fullText, anchorDate);
    if (domDate && weekdayDate && domDate !== weekdayDate) {
      log(`WARNING: DOM-detected date (${domDate}) disagrees with weekday-derived date (${weekdayDate}); using weekday-derived.`);
    }
    const postDate = weekdayDate ?? domDate ?? toDateStr(anchorDate);
    const postUrl = await detectPostUrl(article);

    log(`Post date detected: ${postDate}`);
    log(`Support : ${support}`);
    log(`Resistance: ${resistance}`);

    const data = {
      date: postDate,
      day: getHebrewDay(postDate),
      support,
      resistance,
      fullText,
      postUrl,
      groupUrl: GROUP_URL,
      capturedAt: new Date().toISOString(),
    };

    saveFiles(data);
    log('=== Extraction complete ===');

  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
