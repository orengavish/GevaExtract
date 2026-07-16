// Run once to save your Facebook session.
// After this, extract.js reuses the saved profile automatically.

const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const PROFILE_DIR = path.join(__dirname, 'fb-profile');
const GROUP_URL = 'https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY';

async function main() {
  console.log('Opening browser...');
  console.log('Session will be saved to:', PROFILE_DIR);

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--start-maximized'],
    viewport: null,
  });

  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://www.facebook.com/login');

  console.log('\n=========================================');
  console.log('  1. Log into Facebook in the browser.');
  console.log('  2. Navigate to the Geva group.');
  console.log('  3. Make sure you can see posts.');
  console.log('  4. Come back here and press ENTER.');
  console.log('=========================================\n');

  await waitForEnter();
  await browser.close();

  console.log('\nSession saved. Run "node extract.js" to extract today\'s lines.');
}

function waitForEnter() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press ENTER when ready: ', () => {
      rl.close();
      resolve();
    });
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
