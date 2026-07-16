// Diagnostic — finds which selector actually contains the Hebrew post text.
// Run: node debug.js
// Results saved to debug.txt

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, 'fb-profile');
const GROUP_URL = 'https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY';

const SEARCH = 'קווי תמיכה'; // קווי תמיכה

async function main() {
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--start-maximized'],
    viewport: null,
  });

  const page = browser.pages()[0] || await browser.newPage();
  console.log('Navigating...');
  await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);

  // Scroll a bit to load some posts
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(2500);
  }

  const lines = [];

  // ── 1. Is the text anywhere on the page at all? ──────────────────────────
  const inBody = await page.evaluate(s => document.body.textContent.includes(s), SEARCH);
  const msg1 = `"קווי תמיכה" in document.body.textContent: ${inBody}`;
  console.log(msg1);
  lines.push('=== 1. BODY TEXT CHECK ===', msg1, '');

  // ── 2. Candidate selector counts ─────────────────────────────────────────
  const selectors = [
    'div[role="article"]',
    'div[role="feed"] > div',
    'div[role="feed"] > div > div',
    '[data-pagelet^="FeedUnit"]',
    '[data-pagelet^="GroupsFeed"]',
    '[data-ad-preview="message"]',
    '[data-testid="post_message"]',
    'div[class*="userContent"]',
    'div[aria-posinset]',
    'div[data-virtualized]',
    'div[data-ft]',
    'div[role="main"] > div > div > div > div',
  ];

  lines.push('=== 2. SELECTOR COUNTS ===');
  const counts = await page.evaluate((sels) => {
    return sels.map(sel => {
      try { return [sel, document.querySelectorAll(sel).length]; }
      catch(e) { return [sel, 'ERROR']; }
    });
  }, selectors);

  for (const [sel, count] of counts) {
    const line = `${count}\t${sel}`;
    console.log(line);
    lines.push(line);
  }
  lines.push('');

  // ── 3. Which selector actually contains the target text? ─────────────────
  lines.push('=== 3. WHICH SELECTOR CONTAINS THE TEXT? ===');
  const matchResults = await page.evaluate((args) => {
    const [sels, search] = args;
    const results = [];
    for (const sel of sels) {
      try {
        const els = Array.from(document.querySelectorAll(sel));
        for (let i = 0; i < els.length; i++) {
          if ((els[i].textContent || '').includes(search)) {
            results.push({ sel, index: i, textLen: els[i].textContent.length,
              preview: els[i].textContent.slice(0, 200).replace(/\s+/g, ' ') });
          }
        }
      } catch(e) {}
    }
    return results;
  }, [selectors, SEARCH]);

  if (matchResults.length === 0) {
    lines.push('NONE of the tested selectors contain the text!');
    console.log('No selector matched.');
  } else {
    for (const r of matchResults) {
      lines.push(`MATCH: ${r.sel}[${r.index}]  textLen=${r.textLen}`);
      lines.push(`  preview: ${r.preview}`);
      console.log(`MATCH: ${r.sel}[${r.index}]  textLen=${r.textLen}`);
    }
  }
  lines.push('');

  // ── 4. Walk up the DOM from the text node to find stable ancestors ────────
  lines.push('=== 4. ANCESTOR CHAIN FROM TEXT NODE ===');
  const ancestorInfo = await page.evaluate((search) => {
    // Find a text node containing the search string
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes(search)) {
        // Walk up and collect tag+role+data-* info for 8 ancestors
        const chain = [];
        let el = node.parentElement;
        for (let i = 0; i < 8 && el && el !== document.body; i++) {
          chain.push({
            tag: el.tagName,
            role: el.getAttribute('role'),
            id: el.id || null,
            dataPagelet: el.getAttribute('data-pagelet'),
            dataFt: el.hasAttribute('data-ft') ? '(has data-ft)' : null,
            ariaPosInSet: el.getAttribute('aria-posinset'),
            classPrefix: (el.className || '').toString().slice(0, 60),
          });
          el = el.parentElement;
        }
        return chain;
      }
    }
    return null;
  }, SEARCH);

  if (!ancestorInfo) {
    lines.push('Text node not found — text may not be in the DOM at all.');
    console.log('Text node not found in DOM.');
  } else {
    lines.push('Ancestor chain (innermost first):');
    for (const a of ancestorInfo) {
      const info = [
        `<${a.tag}>`,
        a.role ? `role="${a.role}"` : '',
        a.id ? `id="${a.id}"` : '',
        a.dataPagelet ? `data-pagelet="${a.dataPagelet}"` : '',
        a.dataFt || '',
        a.ariaPosInSet ? `aria-posinset="${a.ariaPosInSet}"` : '',
        `class="${a.classPrefix}"`,
      ].filter(Boolean).join(' ');
      lines.push('  ' + info);
      console.log('  ' + info);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'debug.txt'), lines.join('\n'), 'utf8');
  console.log('\nSaved debug.txt — paste its contents here.');

  await browser.close();
}

main().catch(err => { console.error(err.message); process.exit(1); });
