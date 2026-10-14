// Capture real popup screenshots for the store listing (replaces the mockups).
//
// The numbers on screen are not seeded: the script opens two throwaway sites,
// closes them, and lets the extension clean them, so "cookies cleaned today"
// is whatever the engine really counted. The popup itself is the shipped
// popup.html; only the caption layout around it is composed here.
//
// Usage: node tools/capture-popup-screens.mjs
// Output: assets/screenshot1_1280x800.png, assets/screenshot2_1280x800.png

import { chromium } from '@playwright/test';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

const EXT_PATH = 'E:/prj/cookiemop';
const OUT_DIR = 'E:/prj/cookiemop/assets';
const RAW_DIR = 'E:/prj/cookiemop/assets/promo/raw';
const PORT = 8098;

// Obviously fictional hosts, all mapped to the local server below.
const HOSTS = {
  'news-example.com': 5, // the site shown in the first screenshot
  'mail-example.com': 3, // whitelisted, shown in the second
  'ads-example.net': 6, // cleaned for real, feeds the counter
  'tracker-example.org': 4
};

mkdirSync(RAW_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const n = HOSTS[host] || 1;
  res.setHeader(
    'Set-Cookie',
    Array.from({ length: n }, (_, i) => `c${i + 1}=${i + 1}; Path=/; Max-Age=86400`)
  );
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><title>${host}</title></head><body>${host}</body></html>`);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const mapRules = Object.keys(HOSTS)
  .map((h) => `MAP ${h} 127.0.0.1:${PORT}`)
  .join(', ');

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  deviceScaleFactor: 2,
  viewport: { width: 420, height: 760 },
  args: [
    '--lang=en-US',
    `--host-resolver-rules=${mapRules}`,
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`
  ]
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(sw.url()).host;
const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;

const countCookies = (domain) =>
  sw.evaluate((d) => chrome.cookies.getAll({ domain: d }).then((c) => c.length), domain);

// Clean immediately for the throwaway sites, then restore the default delay
// so the popup shows the real default ("15s delay").
await sw.evaluate(() => chrome.storage.sync.set({ delaySeconds: 0 }));

for (const host of ['ads-example.net', 'tracker-example.org']) {
  const p = await context.newPage();
  await p.goto(`http://${host}/`);
  await p.waitForTimeout(400);
  const before = await countCookies(host);
  await p.close();
  for (let i = 0; i < 40; i++) {
    if ((await countCookies(host)) === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`${host}: ${before} cookies -> ${await countCookies(host)} after the tab closed`);
}

await sw.evaluate(() => chrome.storage.sync.set({ delaySeconds: 15 }));
await sw.evaluate(() =>
  chrome.storage.sync.set({ rules: { 'mail-example.com': { list: 'white', addedAt: Date.now() } } })
);

async function shootPopupFor(host, file, { armClean = false } = {}) {
  const site = await context.newPage();
  await site.goto(`http://${host}/`);
  await site.waitForTimeout(500);
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.waitForFunction(() => document.getElementById('site-domain').textContent !== '\u2014');
  if (armClean) {
    await popup.locator('#row-clean-site').click();
    await popup.waitForTimeout(150);
  }
  await popup.locator('body').screenshot({ path: file });
  const shown = await popup.locator('#site-domain').textContent();
  console.log(`popup for ${host} shows "${shown}" -> ${file}`);
  await popup.close();
  await site.close();
}

const raw1 = `${RAW_DIR}/popup-autoclean.png`;
const raw2 = `${RAW_DIR}/popup-whitelisted-confirm.png`;
await shootPopupFor('news-example.com', raw1);
await shootPopupFor('mail-example.com', raw2, { armClean: true });
await context.close();
server.close();

// --- compose the 1280x800 store images around the real popup captures ---
const b64 = async (f) => (await import('node:fs')).readFileSync(f).toString('base64');

const frame = (label, h1, sub, bullets, img) => `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1280px;height:800px;font-family:'Segoe UI',Inter,Arial,sans-serif;color:#1f2530;
    background:radial-gradient(900px 500px at 85% 0%,#ecfdf5 0%,#fff 60%),linear-gradient(#fff,#f8fafc);
    display:flex;align-items:center;justify-content:space-between;padding:0 100px}
  .l{width:560px}
  .lab{color:#10b981;font-weight:800;font-size:15px;letter-spacing:.14em;margin-bottom:14px}
  h1{font-size:46px;line-height:1.08;letter-spacing:-.02em;margin-bottom:18px}
  .sub{font-size:19px;color:#5b6472;margin-bottom:28px}
  .b{display:flex;gap:14px;align-items:center;font-size:17px;color:#2b323d;margin:14px 0}
  .n{flex:none;width:26px;height:26px;border-radius:50%;background:#d1fae5;color:#059669;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}
  .r img{display:block;width:420px;border-radius:18px;box-shadow:0 30px 70px rgba(16,24,40,.18),0 2px 8px rgba(16,24,40,.08)}
</style></head><body>
  <div class="l"><div class="lab">${label}</div><h1>${h1}</h1><div class="sub">${sub}</div>
  ${bullets.map((t, i) => `<div class="b"><span class="n">${i + 1}</span><span>${t}</span></div>`).join('')}</div>
  <div class="r"><img src="data:image/png;base64,${img}"></div></body></html>`;

const browser = await chromium.launch();
const compose = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await compose.setContent(
  frame(
    'AUTO-CLEAN',
    'Deletes a site\u2019s cookies when you close its last tab',
    'No buttons to press. No cleanup day. It just happens.',
    [
      'Browse anywhere \u2014 CookieMop watches which sites set cookies',
      'Close the tab \u2014 its cookies are wiped after a short delay (15 seconds by default)',
      'Whitelisted sites keep you logged in, always'
    ],
    await b64(raw1)
  )
);
await compose.screenshot({ path: `${OUT_DIR}/screenshot1_1280x800.png` });

await compose.setContent(
  frame(
    'WHITELIST',
    'Stay logged in where you trust',
    'One click in the popup. Sites you whitelist are never cleaned.',
    [
      'Set each site to auto-clean, whitelist or greylist',
      'Greylisted sites are kept until the browser is closed',
      'Even \u201cClean this site now\u201d asks before it touches a whitelisted site'
    ],
    await b64(raw2)
  )
);
await compose.screenshot({ path: `${OUT_DIR}/screenshot2_1280x800.png` });
await browser.close();
console.log('done: screenshot1_1280x800.png, screenshot2_1280x800.png');
