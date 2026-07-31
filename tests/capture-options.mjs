// Capture the options page at 1280x800 in en-US for the store listing.
import { chromium } from '@playwright/test';

const EXT_PATH = 'E:/prj/cookiemop';
const OUT = 'E:/prj/cookiemop/assets/screenshot3_1280x800.png';

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  viewport: { width: 1280, height: 800 },
  args: [
    '--lang=en-US',
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`
  ]
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(sw.url()).host;

// Three site rules with believable "added N ago" timestamps + demo stats.
await sw.evaluate(() => {
  const day = 24 * 60 * 60 * 1000;
  const d = new Date();
  return Promise.all([
    chrome.storage.sync.set({
      rules: {
        'mail.google.com': { list: 'white', addedAt: Date.now() - 21 * day },
        'github.com': { list: 'white', addedAt: Date.now() - 14 * day },
        'youtube.com': { list: 'grey', addedAt: Date.now() - 5 * day }
      }
    }),
    chrome.storage.local.set({
      stats: {
        todayCleaned: 47,
        totalCleaned: 1284,
        todayDate: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
      }
    })
  ]);
});

const page = await context.newPage();
await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await page.waitForSelector('.rule-item');
await page.waitForTimeout(300); // let stats/i18n settle

// Screenshot-only spacing tweak so the Cleanup card and the full Site rules
// card (incl. the Add row) both fit inside the 1280x800 frame.
await page.addStyleTag({
  content: `
    .page { padding-top: 14px; }
    .page-header { margin-bottom: 14px; }
    .card { padding: 16px 20px; margin-bottom: 12px; }
    .radio { padding: 5px 0; }
  `
});
console.log(
  'add-row bottom:',
  await page.evaluate(() => Math.round(document.querySelector('.add-row').getBoundingClientRect().bottom))
);

console.log('lang:', await page.evaluate(() => chrome.i18n.getUILanguage()));
console.log('rules rendered:', await page.locator('.rule-item').count());
await page.screenshot({ path: OUT });
console.log('saved:', OUT);

await context.close();
