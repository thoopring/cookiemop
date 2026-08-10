// Record the CookieMop demo video used for the Lemon Squeezy review and the
// store listing.
//
// Everything shown is the real extension doing real work — the cookie counts,
// the cleanup and the licence activation are genuine, not mocked. Captions
// are burned in so the file is usable as-is with no editing.
//
// Playwright records one video per page, so a single "stage" page is driven
// through the whole story. A throwaway second tab supplies the tab-close
// moment; its recording is discarded.
//
// Usage: node tools/record-demo.mjs
// Output: assets/promo/demo/cookiemop-demo.webm

import { chromium } from '@playwright/test';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { signLicense } from '../server/lib/sign-license.js';

const EXT_PATH = 'E:/prj/cookiemop';
const OUT_DIR = 'E:/prj/cookiemop/assets/promo/demo';
const RAW_DIR = join(OUT_DIR, '_raw');
const PRIVATE_KEY_PATH =
  process.env.COOKIEMOP_PRIVATE_KEY_PATH ||
  'E:/prj/cookiemop-secrets/license-private-key.pem';

if (!existsSync(PRIVATE_KEY_PATH)) {
  console.error(`Signing key not found at ${PRIVATE_KEY_PATH}`);
  process.exit(1);
}
const demoKey = signLicense({
  email: 'you@example.com',
  orderNumber: '1042',
  privateKeyPem: readFileSync(PRIVATE_KEY_PATH, 'utf8')
});

rmSync(RAW_DIR, { recursive: true, force: true });
mkdirSync(RAW_DIR, { recursive: true });

const DEMO_PORT = 8099;
const DEMO_HOST = 'shop.example.com';

// Serves three things on one origin:
//   /              a stand-in site that sets cookies
//   /license       the real licence page, byte for byte
//   /api/license   its API — GET reports test mode off, POST returns the key
//
// The licence page is served locally so the recording shows the page a buyer
// sees, without the operational TEST MODE banner that is currently switched
// on in production for end-to-end testing.
function startSite() {
  const licencePage = readFileSync(join(EXT_PATH, 'server', 'public', 'license.html'));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${DEMO_HOST}`);

    if (url.pathname === '/api/license') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          res.end(JSON.stringify({
            licenseKey: demoKey,
            email: body.email,
            orderNumber: body.orderNumber || '1042'
          }));
        });
        return;
      }
      res.end(JSON.stringify({ testMode: { active: false, expiresAt: null } }));
      return;
    }

    if (url.pathname === '/license') {
      res.setHeader('Content-Type', 'text/html');
      res.end(licencePage);
      return;
    }

    res.setHeader('Set-Cookie', [
      'session_id=abc123; Path=/; Max-Age=86400',
      'cart=2items; Path=/; Max-Age=86400',
      'ad_track=xyz; Path=/; Max-Age=86400',
      'prefs=dark; Path=/; Max-Age=86400'
    ]);
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:0;background:#fff;color:#22252b}
      .bar{height:56px;border-bottom:1px solid #eef0f2;display:flex;align-items:center;padding:0 28px;font-weight:800;font-size:17px}
      .wrap{padding:40px 28px;max-width:760px}
      h1{font-size:28px;margin:0 0 10px}
      p{color:#6b7280;line-height:1.6}
      .cards{display:flex;gap:14px;margin-top:24px}
      .card{flex:1;height:120px;border:1px solid #eef0f2;border-radius:12px;background:#f8fafb}
    </style></head><body>
      <div class="bar">shop.example.com</div>
      <div class="wrap"><h1>Any site you visit</h1>
      <p>This page just set four cookies: a session, a cart, an ad tracker and a preference.</p>
      <div class="cards"><div class="card"></div><div class="card"></div><div class="card"></div></div></div>
    </body></html>`);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(DEMO_PORT, '127.0.0.1', () => {
      resolve({
        url: `http://${DEMO_HOST}/`,
        licenceUrl: `http://${DEMO_HOST}/license`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

const site = await startSite();

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: RAW_DIR, size: { width: 1280, height: 720 } },
  args: [
    '--lang=en-US',
    // Point the example domain at the local demo server, so the recording
    // shows a readable hostname instead of a loopback address.
    `--host-resolver-rules=MAP ${DEMO_HOST} 127.0.0.1:${DEMO_PORT}`,
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`
  ]
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(sw.url()).host;
const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html`;

await sw.evaluate(() => chrome.storage.sync.set({ delaySeconds: 1, rules: {}, profiles: [], keepCookies: {} }));

// The stage: one page, recorded end to end.
const stage = await context.newPage();

const CAPTION_CSS = `
  /* pointer-events:none so the caption never swallows a click. */
  #cm-cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;
    background:linear-gradient(transparent,rgba(15,17,20,.92) 38%);
    padding:56px 40px 34px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
    color:#fff;font-size:27px;font-weight:700;letter-spacing:-.01em;text-align:center;
    opacity:0;transition:opacity .35s}
  #cm-cap.on{opacity:1}
  #cm-cap small{display:block;font-size:16px;font-weight:500;opacity:.8;margin-top:7px}
`;

async function caption(page, text, sub = '') {
  await page.evaluate(
    ({ text, sub, css }) => {
      let el = document.getElementById('cm-cap');
      if (!el) {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        el = document.createElement('div');
        el.id = 'cm-cap';
        document.body.appendChild(el);
      }
      el.textContent = text;
      if (sub) {
        const s = document.createElement('small');
        s.textContent = sub;
        el.appendChild(s);
      }
      requestAnimationFrame(() => el.classList.add('on'));
    },
    { text, sub, css: CAPTION_CSS }
  );
}

async function clearCaption(page) {
  await page.evaluate(() => {
    const el = document.getElementById('cm-cap');
    if (el) el.classList.remove('on');
  });
}

const hold = (ms) => stage.waitForTimeout(ms);

// Popup is 360px wide; centre it on the 1280px stage so it reads well.
async function showPopup() {
  await stage.goto(popupUrl);
  await stage.addStyleTag({
    content: `html{background:#f6f8f9}
      body{width:420px!important;margin:40px auto!important;
        box-shadow:0 12px 40px rgba(34,37,43,.14);border-radius:16px;overflow:hidden}`
  });
}

// --- 1. The problem ------------------------------------------------------

const siteTab = await context.newPage();
await siteTab.goto(site.url);
await stage.bringToFront();

await showPopup();
await caption(stage, 'Every site you visit leaves cookies behind', 'CookieMop counts them on the toolbar');
await hold(4200);
await clearCaption(stage);
await hold(600);

// --- 2. The core behaviour ----------------------------------------------

await caption(stage, 'Close the tab…');
await hold(1600);
await siteTab.close();
await stage.waitForTimeout(3200); // 1s delay + cleanup
await showPopup();
await caption(stage, '…and that site\u2019s cookies are gone', 'Automatically, with no cleanup day');
await hold(4200);
await clearCaption(stage);
await hold(500);

// --- 3. Whitelist --------------------------------------------------------

const siteTab2 = await context.newPage();
await siteTab2.goto(site.url);
await stage.bringToFront();
await showPopup();
await caption(stage, 'Keep the sites you trust', 'One click, and you stay logged in');
await hold(1800);
await stage.locator('.seg-btn[data-rule="white"]').click();
await hold(2600);
await clearCaption(stage);
await siteTab2.close();
await hold(500);

// --- 4. Options ----------------------------------------------------------

await stage.goto(optionsUrl);
await stage.addStyleTag({ content: 'html{scroll-behavior:auto}' });
await caption(stage, 'You choose what gets deleted', 'Cookies, localStorage, or all site data');
await hold(4000);
await clearCaption(stage);

await stage.evaluate(() => {
  const el = document.querySelector('#rule-list').closest('section.card');
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 40 });
});
await hold(600);
await caption(stage, 'Whitelist, greylist, or clean everything else', 'Import your Cookie AutoDelete list in one click');
await hold(4000);
await clearCaption(stage);
await hold(400);

// --- 5. Pro --------------------------------------------------------------

await stage.evaluate(async (key) => {
  const mod = await import('/src/lib/license.js');
  await mod.activateLicense(key);
}, demoKey);
const day = 86400000;
await stage.evaluate((d) => chrome.storage.sync.set({
  rules: { 'work-intranet.com': { list: 'white', addedAt: Date.now() - 12 * d } },
  profiles: [
    { id: 'p-work', name: 'Work', rules: { 'work-intranet.com': { list: 'white', addedAt: Date.now() - 12 * d } } },
    { id: 'p-personal', name: 'Personal', rules: { 'reddit.com': { list: 'grey', addedAt: Date.now() - 6 * d } } }
  ],
  activeProfileId: 'p-work',
  keepCookies: { 'github.com': ['user_session'], 'mail.google.com': ['SID'] }
}), day);
await stage.reload();
await stage.evaluate(() => {
  const el = document.querySelector('#profile-list').closest('section.card');
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 40 });
});
await hold(700);
await caption(stage, 'Pro: separate rules for work and personal', 'Switch with one click — $9.99 once, no subscription');
await hold(4200);
await clearCaption(stage);

await stage.evaluate(() => {
  const el = document.querySelector('#keep-list').closest('section.card');
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 40 });
});
await hold(600);
await caption(stage, 'Pro: clean a site but keep your login cookie');
await hold(3800);
await clearCaption(stage);
await hold(400);

// --- 6. Buying and activating -------------------------------------------

await stage.goto(site.licenceUrl, { waitUntil: 'domcontentloaded' });
await caption(stage, 'Buy once, and your key is waiting immediately', 'No email to wait for, nothing sent by hand');
await hold(3000);
await stage.locator('#email').type('you@example.com', { delay: 55 });
await stage.locator('#order').type('1042', { delay: 90 });
await hold(500);
await stage.locator('#submit').click();
await stage.waitForSelector('#result.show', { timeout: 10_000 });
await hold(2600);
await clearCaption(stage);
await caption(stage, 'Lose it? Look it up again — same key, every time');
await hold(3200);
await clearCaption(stage);
await hold(400);

await stage.goto(optionsUrl);
await stage.evaluate(async () => {
  const mod = await import('/src/lib/license.js');
  await mod.deactivateLicense();
});
await stage.reload();
await stage.evaluate(() => {
  const el = document.querySelector('#pro-card');
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 40 });
});
await hold(700);
await caption(stage, 'Paste it once, and Pro is on', 'Verified on your device — no licence server');
await stage.locator('#license-input').type(demoKey.slice(0, 46), { delay: 16 });
await hold(300);
await stage.locator('#license-input').fill(demoKey);
await hold(400);
await stage.locator('#license-activate').click();
await hold(3400);
await clearCaption(stage);
await hold(400);

// --- 7. Close ------------------------------------------------------------

await caption(
  stage,
  '100% local. Open source. Zero network requests.',
  'Free to install · Pro is $9.99 once, no subscription'
);
await hold(4600);
await clearCaption(stage);
await hold(900);

const stageVideo = stage.video();
await context.close();
await site.close();

// Keep the stage recording, drop the throwaway tabs' videos.
mkdirSync(OUT_DIR, { recursive: true });
const finalPath = join(OUT_DIR, 'cookiemop-demo.webm');
const stagePath = await stageVideo.path();
renameSync(stagePath, finalPath);
for (const file of readdirSync(RAW_DIR)) rmSync(join(RAW_DIR, file), { force: true });
rmSync(RAW_DIR, { recursive: true, force: true });

const { size } = statSync(finalPath);
console.log(`\nRecorded ${finalPath}`);
console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB, 1280x720`);
