// Core engine end-to-end tests: real cookie deletion driven by tab lifecycle.
// Covers spec edge cases ① (multi-tab same domain) and ⑥ (revisit during
// the deletion delay), plus whitelist protection and manual cleaning.

import { test, expect } from '@playwright/test';
import {
  launchWithExtension,
  startCookieServer,
  getCookies,
  setSettings,
  sleep
} from './helpers.js';

let context, sw, server;

test.beforeEach(async () => {
  ({ context, sw } = await launchWithExtension());
  server = await startCookieServer();
});

test.afterEach(async () => {
  await context.close();
  await server.close();
});

test('deletes cookies after the last tab of a domain closes', async () => {
  await setSettings(sw, { delaySeconds: 1 });
  const page = await context.newPage();
  await page.goto(server.url);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);

  await page.close();
  await sleep(3000);
  expect(await getCookies(sw, '127.0.0.1')).toHaveLength(0);
});

test('edge ①: keeps cookies while another tab of the same domain is open', async () => {
  await setSettings(sw, { delaySeconds: 1 });
  const page1 = await context.newPage();
  await page1.goto(server.url);
  const page2 = await context.newPage();
  await page2.goto(server.url + 'second');

  await page1.close();
  await sleep(3000);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);

  await page2.close();
  await sleep(3000);
  expect(await getCookies(sw, '127.0.0.1')).toHaveLength(0);
});

test('edge ⑥: revisiting the site during the delay cancels the cleanup', async () => {
  await setSettings(sw, { delaySeconds: 3 });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.close();

  // Reopen the same site well within the 3 s delay window.
  await sleep(500);
  const page2 = await context.newPage();
  await page2.goto(server.url);

  await sleep(4500);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);
});

test('whitelisted domains are never auto-cleaned', async () => {
  await setSettings(sw, {
    delaySeconds: 1,
    rules: { '127.0.0.1': { list: 'white', addedAt: 1 } }
  });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.close();
  await sleep(3000);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);
});

test('greylisted domains survive tab close (cleaned only at browser close)', async () => {
  await setSettings(sw, {
    delaySeconds: 1,
    rules: { '127.0.0.1': { list: 'grey', addedAt: 1 } }
  });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.close();
  await sleep(3000);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);
});

test('disabling the extension stops auto-cleaning', async () => {
  await setSettings(sw, { delaySeconds: 1, enabled: false });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.close();
  await sleep(3000);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);
});

test('manual "clean all except open tabs" respects whitelist and open sites', async () => {
  await setSettings(sw, {
    delaySeconds: 60, // keep auto-clean out of the way
    rules: {}
  });
  const page = await context.newPage();
  await page.goto(server.url);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);

  // Messages must come from an extension page context (the service worker
  // does not receive messages it sends itself) — use the options page.
  const extensionId = new URL(sw.url()).host;
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const cleanAll = () =>
    extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'clean-all' }));

  // Site is open → clean-all must keep its cookies.
  await cleanAll();
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);

  // Close the tab → domain no longer open → clean-all removes them.
  await page.close();
  await cleanAll();
  expect(await getCookies(sw, '127.0.0.1')).toHaveLength(0);
});

test('stats are incremented after an auto-clean', async () => {
  await setSettings(sw, { delaySeconds: 1 });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.close();
  await sleep(3000);
  const stats = await sw.evaluate(async () => {
    const { stats } = await chrome.storage.local.get('stats');
    return stats;
  });
  expect(stats.totalCleaned).toBeGreaterThan(0);
  expect(stats.todayCleaned).toBeGreaterThan(0);
});
