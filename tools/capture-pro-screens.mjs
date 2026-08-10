// Capture the two Pro screens for the store listing, 1280x800, en-US.
// Output goes to assets/promo/raw/ as unretouched source material.
//
// Usage: node tools/capture-pro-screens.mjs
// Requires the signing key so Pro can be activated for the capture.

import { chromium } from '@playwright/test';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { signLicense } from '../server/lib/sign-license.js';

const EXT_PATH = 'E:/prj/cookiemop';
const OUT_DIR = 'E:/prj/cookiemop/assets/promo/raw';
const PRIVATE_KEY_PATH =
  process.env.COOKIEMOP_PRIVATE_KEY_PATH ||
  'E:/prj/cookiemop-secrets/license-private-key.pem';

if (!existsSync(PRIVATE_KEY_PATH)) {
  console.error(`Signing key not found at ${PRIVATE_KEY_PATH} — cannot activate Pro for capture.`);
  process.exit(1);
}
const licenseKey = signLicense({
  email: 'you@example.com',
  orderNumber: '1042',
  privateKeyPem: readFileSync(PRIVATE_KEY_PATH, 'utf8')
});

mkdirSync(OUT_DIR, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  viewport: { width: 1280, height: 800 },
  args: ['--lang=en-US', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(sw.url()).host;
const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html`;

const page = await context.newPage();
await page.goto(optionsUrl);

// Activate Pro and seed believable content for both screens.
await page.evaluate(async (key) => {
  const mod = await import('/src/lib/license.js');
  await mod.activateLicense(key);
}, licenseKey);

const day = 24 * 60 * 60 * 1000;
await page.evaluate((d) => {
  return chrome.storage.sync.set({
    rules: {
      'work-intranet.com': { list: 'white', addedAt: Date.now() - 12 * d },
      'jira.company.com': { list: 'white', addedAt: Date.now() - 9 * d },
      'docs.google.com': { list: 'white', addedAt: Date.now() - 4 * d }
    },
    profiles: [
      {
        id: 'p-work',
        name: 'Work',
        rules: {
          'work-intranet.com': { list: 'white', addedAt: Date.now() - 12 * d },
          'jira.company.com': { list: 'white', addedAt: Date.now() - 9 * d },
          'docs.google.com': { list: 'white', addedAt: Date.now() - 4 * d }
        }
      },
      {
        id: 'p-personal',
        name: 'Personal',
        rules: {
          'reddit.com': { list: 'grey', addedAt: Date.now() - 6 * d },
          'youtube.com': { list: 'grey', addedAt: Date.now() - 3 * d }
        }
      }
    ],
    activeProfileId: 'p-work',
    keepCookies: {
      'github.com': ['user_session', 'dotcom_user'],
      'mail.google.com': ['SID'],
      'news.ycombinator.com': ['user']
    }
  });
}, day);

// Plausible counters, so the raw frames do not show a brand-new install.
await page.evaluate(() => {
  const d = new Date();
  return chrome.storage.local.set({
    stats: {
      todayCleaned: 47,
      totalCleaned: 1284,
      todayDate: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    }
  });
});

await page.reload();
await page.waitForSelector('#profile-list .rule-item');

// Screenshot-only spacing so a whole section fits the 1280x800 frame.
const tighten = () =>
  page.addStyleTag({
    content: `
      .page { padding-top: 16px; }
      .page-header { margin-bottom: 16px; }
      .card { padding: 18px 20px; margin-bottom: 14px; }
    `
  });

async function shoot(name, selector) {
  await tighten();
  const box = await page.locator(selector).boundingBox();
  // Frame the section with a little breathing room, clamped to the viewport.
  const pad = 24;
  await page.screenshot({
    path: `${OUT_DIR}/${name}`,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(1280, box.width + pad * 2),
      height: Math.min(800, box.height + pad * 2)
    }
  });
  console.log(`saved ${name} (${Math.round(box.width)}x${Math.round(box.height)} content)`);
}

// Full-frame captures at exactly 1280x800, scrolled so the whole card —
// heading, Pro tag and all — sits inside the frame.
async function shootFrame(name, selector) {
  await tighten();
  const offset = await page.evaluate((sel) => {
    const card = document.querySelector(sel).closest('section.card');
    const top = card.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, top - 40) });
    return { cardTop: Math.round(top), height: Math.round(card.getBoundingClientRect().height) };
  }, selector);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT_DIR}/${name}` });
  console.log(`saved ${name} — card height ${offset.height}px, fits 800px frame: ${offset.height <= 760}`);
}

await shootFrame('pro-1-rule-profiles_1280x800.png', '#profile-list');
await shootFrame('pro-2-keep-cookies_1280x800.png', '#keep-list');

console.log('\nUI language:', await page.evaluate(() => chrome.i18n.getUILanguage()));
console.log('Pro active:', await page.evaluate(async () => (await import('/src/lib/license.js')).isPro()));

await context.close();
