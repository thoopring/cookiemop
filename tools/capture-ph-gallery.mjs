// Product Hunt gallery images: 1270x760, real UI only, no overlay text.
//
// Options-page shots are the shipped options.html rendered in a 1270x760
// viewport (browser zoom 1.2 so the 640px column fills the frame). The popup
// shot places the real popup capture (assets/promo/raw/popup-autoclean.png,
// taken by capture-popup-screens.mjs) on a plain page-coloured canvas.
// The rule list is seeded storage, the same way the store screenshots are.
//
// Usage: node tools/capture-ph-gallery.mjs
// Output: assets/ph/ph-1-popup.png .. ph-4-import.png, ph-thumb-240.png

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const EXT_PATH = 'E:/prj/cookiemop';
const OUT = 'E:/prj/cookiemop/assets/ph';
const RAW_POPUP = 'E:/prj/cookiemop/assets/promo/raw/popup-autoclean.png';
const W = 1270;
const H = 760;
const BG = '#f6f7f9';

mkdirSync(OUT, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  deviceScaleFactor: 1,
  viewport: { width: W, height: H },
  args: ['--lang=en-US', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(sw.url()).host;

const day = 24 * 3600 * 1000;
await sw.evaluate((d) => {
  const now = Date.now();
  return chrome.storage.sync.set({
    delaySeconds: 15,
    rules: {
      'github.com': { list: 'white', addedAt: now - 14 * d },
      'mail.google.com': { list: 'white', addedAt: now - 21 * d },
      'youtube.com': { list: 'grey', addedAt: now - 5 * d }
    }
  });
}, day);

const page = await context.newPage();
await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await page.waitForFunction(() => document.getElementById('count-all').textContent === '3');
await page.evaluate(() => {
  document.documentElement.style.zoom = '1.2';
});

// Scroll a card to the top of the frame, then grab the viewport.
async function shootCard(selector, file) {
  await page.locator(selector).evaluate((el) => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 24));
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file });
  console.log(`${selector} -> ${file}`);
}

await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/ph-3-options.png` });
console.log('options top -> ph-3-options.png');

const rulesCard = page.locator('#rule-list').locator('xpath=ancestor::section[1]');
await rulesCard.evaluate((el) => el.setAttribute('id', 'ph-rules-card'));
await shootCard('#ph-rules-card', `${OUT}/ph-2-site-rules.png`);

const importCard = page.locator('#import-btn').locator('xpath=ancestor::section[1]');
await importCard.evaluate((el) => el.setAttribute('id', 'ph-import-card'));
await shootCard('#ph-import-card', `${OUT}/ph-4-import.png`);
await page.close();
await context.close();

// --- popup shot and the 240x240 thumbnail ---
const browser = await chromium.launch();
const compose = await browser.newPage({ viewport: { width: W, height: H } });
const popup64 = readFileSync(RAW_POPUP).toString('base64');
await compose.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${BG};display:flex;align-items:center;justify-content:center">
  <img src="data:image/png;base64,${popup64}" style="height:680px;border-radius:16px;box-shadow:0 30px 70px rgba(16,24,40,.18),0 2px 8px rgba(16,24,40,.08)">
</body></html>`);
await compose.screenshot({ path: `${OUT}/ph-1-popup.png` });

const svg = readFileSync('E:/prj/cookiemop/assets/cookiemop_icon.svg', 'utf8');
const thumb = await browser.newPage({ viewport: { width: 240, height: 240 } });
await thumb.setContent(`<!doctype html><html><body style="margin:0;width:240px;height:240px;background:transparent">
  <div style="width:240px;height:240px">${svg.replace(/<svg /, '<svg width="240" height="240" ')}</div></body></html>`);
await thumb.screenshot({ path: `${OUT}/ph-thumb-240.png`, omitBackground: true });
await browser.close();
console.log('done');
