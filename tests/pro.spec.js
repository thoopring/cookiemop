// Pro feature tests, and the migration/regression guarantees that matter
// most now that v1.0 is live: a paying update must not change anything for
// the users who never pay.

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import {
  launchWithExtension,
  startCookieServer,
  getCookies,
  setSettings,
  sleep
} from './helpers.js';
import { signLicense } from '../server/lib/sign-license.js';

const PRIVATE_KEY_PATH =
  process.env.COOKIEMOP_PRIVATE_KEY_PATH ||
  'E:/prj/cookiemop-secrets/license-private-key.pem';
const hasSigningKey = existsSync(PRIVATE_KEY_PATH);
const privateKeyPem = hasSigningKey ? readFileSync(PRIVATE_KEY_PATH, 'utf8') : null;

function proKey() {
  return signLicense({
    email: 'pro@example.com',
    orderId: 'LS-2001',
    privateKeyPem
  });
}

let context, extensionId, sw, server;

test.beforeEach(async () => {
  ({ context, extensionId, sw } = await launchWithExtension());
});

test.afterEach(async () => {
  await context.close();
  if (server) {
    await server.close();
    server = null;
  }
});

const optionsUrl = () => `chrome-extension://${extensionId}/src/options/options.html`;

/**
 * Evaluate against the extension's modules. Service workers cannot use
 * dynamic import(), so module-level assertions run in an extension page,
 * which shares the same chrome.storage.
 */
async function inExtension(fn, arg) {
  const page = await context.newPage();
  await page.goto(optionsUrl());
  const result = await page.evaluate(fn, arg);
  await page.close();
  return result;
}

async function activatePro(page) {
  await page.evaluate(async (key) => {
    const mod = await import('/src/lib/license.js');
    await mod.activateLicense(key);
  }, proKey());
}

// --- Migration: settings written by v1.0 --------------------------------

test('v1.0 settings load unchanged, with Pro fields defaulted in', async () => {
  // Exactly the shape v1.0 wrote — no profiles, keepCookies or license keys.
  await sw.evaluate(() =>
    chrome.storage.sync.set({
      enabled: true,
      delaySeconds: 30,
      scope: 'storage',
      rules: {
        'mail.google.com': { list: 'white', addedAt: 1000 },
        'youtube.com': { list: 'grey', addedAt: 2000 }
      }
    })
  );

  const loaded = await inExtension(async () => {
    const { getSettings } = await import('/src/lib/store.js');
    return getSettings();
  });

  // Everything the user had set survives verbatim.
  expect(loaded.delaySeconds).toBe(30);
  expect(loaded.scope).toBe('storage');
  expect(loaded.rules['mail.google.com'].list).toBe('white');
  expect(loaded.rules['youtube.com'].list).toBe('grey');
  expect(loaded.rules['mail.google.com'].addedAt).toBe(1000);
  // New fields arrive empty rather than requiring a storage rewrite.
  expect(loaded.profiles).toEqual([]);
  expect(loaded.activeProfileId).toBeNull();
  expect(loaded.keepCookies).toEqual({});
});

test('a v1.0 user is not silently upgraded or downgraded', async () => {
  await sw.evaluate(() =>
    chrome.storage.sync.set({ rules: { 'example.com': { list: 'white', addedAt: 1 } } })
  );
  const pro = await inExtension(async () => {
    const { isPro } = await import('/src/lib/license.js');
    return isPro();
  });
  expect(pro).toBe(false);

  // Loading settings must not write anything back to storage.
  const keys = await inExtension(async () => {
    const { getSettings } = await import('/src/lib/store.js');
    await getSettings();
    return Object.keys(await chrome.storage.sync.get(null)).sort();
  });
  expect(keys).toEqual(['rules']);
});

// --- Free behaviour is identical to v1.0 --------------------------------

test('free user: auto-clean on tab close still deletes everything', async () => {
  server = await startCookieServer();
  await setSettings(sw, { delaySeconds: 1 });

  const page = await context.newPage();
  await page.goto(server.url);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);
  await page.close();
  await sleep(3000);
  expect(await getCookies(sw, '127.0.0.1')).toHaveLength(0);
});

test('free user: keepCookies is empty so no cookie is spared', async () => {
  server = await startCookieServer();
  await setSettings(sw, { delaySeconds: 1, keepCookies: {} });

  const page = await context.newPage();
  await page.goto(server.url);
  await page.close();
  await sleep(3000);
  expect(await getCookies(sw, '127.0.0.1')).toHaveLength(0);
});

test('free user sees a contextual upsell only after reaching for a Pro action', async () => {
  const page = await context.newPage();
  await page.goto(optionsUrl());

  // Nothing is nagging before any interaction.
  await expect(page.locator('#profile-upsell')).toBeHidden();
  await expect(page.locator('#keep-upsell')).toBeHidden();

  await page.locator('#profile-name').fill('Work');
  await page.locator('#profile-save').click();
  await expect(page.locator('#profile-upsell')).toBeVisible();
  await expect(page.locator('#profile-upsell')).toContainText('Pro');
  // The click did not quietly do the Pro thing anyway.
  await expect(page.locator('#profile-list .rule-item')).toHaveCount(0);

  await page.locator('#keep-domain').fill('example.com');
  await page.locator('#keep-names').fill('session_id');
  await page.locator('#keep-save').click();
  await expect(page.locator('#keep-upsell')).toBeVisible();
  await expect(page.locator('#keep-list .rule-item')).toHaveCount(0);
});

// --- Pro feature 1: rule profiles ---------------------------------------

test('pro user saves, switches and deletes rule profiles', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  const page = await context.newPage();
  await page.goto(optionsUrl());
  await activatePro(page);
  await page.reload();

  // Start with one rule, save it as "Work".
  await page.locator('#add-domain').fill('work-intranet.com');
  await page.locator('#add-list').selectOption('white');
  await page.locator('#add-btn').click();
  await expect(page.locator('#rule-list .rule-item')).toHaveCount(1);

  await page.locator('#profile-name').fill('Work');
  await page.locator('#profile-save').click();
  await expect(page.locator('#profile-list .rule-item')).toHaveCount(1);
  await expect(page.locator('#profile-upsell')).toBeHidden();

  // Build a different rule set and save it as "Personal".
  await page.locator('.rule-remove').first().click();
  await page.locator('#add-domain').fill('reddit.com');
  await page.locator('#add-list').selectOption('grey');
  await page.locator('#add-btn').click();
  await page.locator('#profile-name').fill('Personal');
  await page.locator('#profile-save').click();
  await expect(page.locator('#profile-list .rule-item')).toHaveCount(2);

  // Switching back to Work restores its rules exactly.
  await page.locator('#profile-list .rule-item', { hasText: 'Work' })
    .locator('.btn-tiny').click();
  await expect(page.locator('#rule-list .rule-item')).toHaveCount(1);
  await expect(page.locator('#rule-list .rule-domain')).toHaveText('work-intranet.com');

  // And the engine sees the switched-in rules, not a stale copy.
  const activeRules = await inExtension(async () => {
    const { getSettings } = await import('/src/lib/store.js');
    return (await getSettings()).rules;
  });
  expect(Object.keys(activeRules)).toEqual(['work-intranet.com']);

  // Switching to Personal brings its own rules back.
  await page.locator('#profile-list .rule-item', { hasText: 'Personal' })
    .locator('.btn-tiny').click();
  await expect(page.locator('#rule-list .rule-domain')).toHaveText('reddit.com');

  await page.locator('#profile-list .rule-item', { hasText: 'Work' })
    .locator('.rule-remove').click();
  await expect(page.locator('#profile-list .rule-item')).toHaveCount(1);
});

// --- Pro feature 4: per-cookie whitelist --------------------------------

test('pro user keeps one cookie while the rest of the site is cleaned', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  server = await startCookieServer();
  await setSettings(sw, {
    delaySeconds: 1,
    keepCookies: { '127.0.0.1': ['cm_test'] }
  });

  const page = await context.newPage();
  await page.goto(server.url);
  expect((await getCookies(sw, '127.0.0.1')).length).toBe(2);

  await page.close();
  await sleep(3000);

  const left = await getCookies(sw, '127.0.0.1');
  expect(left.map((c) => c.name)).toEqual(['cm_test']);
});

test('kept cookies survive a manual "clean this site now" too', async () => {
  server = await startCookieServer();
  await setSettings(sw, {
    delaySeconds: 60,
    keepCookies: { '127.0.0.1': ['cm_test'] }
  });

  const site = await context.newPage();
  await site.goto(server.url);
  const page = await context.newPage();
  await page.goto(optionsUrl());

  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'clean-site',
      domain: '127.0.0.1',
      hostnames: ['127.0.0.1']
    })
  );

  const left = await getCookies(sw, '127.0.0.1');
  expect(left.map((c) => c.name)).toEqual(['cm_test']);
});

test('kept cookies survive "clean all except open tabs"', async () => {
  server = await startCookieServer();
  await setSettings(sw, {
    delaySeconds: 60,
    keepCookies: { '127.0.0.1': ['cm_extra'] }
  });

  const site = await context.newPage();
  await site.goto(server.url);
  const page = await context.newPage();
  await page.goto(optionsUrl());
  await site.close();

  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'clean-all' }));

  const left = await getCookies(sw, '127.0.0.1');
  expect(left.map((c) => c.name)).toEqual(['cm_extra']);
});

test('removing the licence keeps kept-cookies honoured, never deleting them', async () => {
  // A lapsed licence must not turn into silent data loss for cookies the
  // user explicitly marked to keep.
  server = await startCookieServer();
  await setSettings(sw, {
    delaySeconds: 1,
    keepCookies: { '127.0.0.1': ['cm_test'] }
  });

  const page = await context.newPage();
  await page.goto(optionsUrl());
  await page.evaluate(async () => {
    const mod = await import('/src/lib/license.js');
    await mod.deactivateLicense();
  });

  const site = await context.newPage();
  await site.goto(server.url);
  await site.close();
  await sleep(3000);

  const left = await getCookies(sw, '127.0.0.1');
  expect(left.map((c) => c.name)).toEqual(['cm_test']);
});

// --- Pro UI state -------------------------------------------------------

test('options page shows Pro as active after activation and reverts on removal', async () => {
  test.skip(!hasSigningKey, 'signing key not available');
  const page = await context.newPage();
  await page.goto(optionsUrl());

  await expect(page.locator('#pro-badge')).toBeHidden();
  await expect(page.locator('#pro-offer')).toBeVisible();

  await page.locator('#license-input').fill(proKey());
  await page.locator('#license-activate').click();

  await expect(page.locator('#pro-badge')).toBeVisible();
  await expect(page.locator('#pro-offer')).toBeHidden();
  await expect(page.locator('#pro-licensed')).toContainText('pro@example.com');

  await page.locator('#license-remove').click();
  await expect(page.locator('#pro-badge')).toBeHidden();
  await expect(page.locator('#pro-offer')).toBeVisible();
});

test('a bad key shows an error and leaves the page in free state', async () => {
  const page = await context.newPage();
  await page.goto(optionsUrl());

  await page.locator('#license-input').fill('CM1.garbage.garbage');
  await page.locator('#license-activate').click();

  await expect(page.locator('#license-result')).toHaveClass(/error/);
  await expect(page.locator('#pro-badge')).toBeHidden();
});
