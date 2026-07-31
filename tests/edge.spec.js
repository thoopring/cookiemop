// Edge-case tests from the spec: subdomains (②), service-worker death
// during the delay (④, simulated via extension reload), and greylist
// cleanup on browser restart (⑤).

import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchWithExtension,
  startCookieServer,
  getCookies,
  setSettings,
  sleep
} from './helpers.js';

test('edge ②: subdomain and parent domain count as the same site', async () => {
  const { context, sw } = await launchWithExtension();
  const server = await startCookieServer();
  await setSettings(sw, { delaySeconds: 1 });

  // Chrome resolves *.localhost to 127.0.0.1 without any hosts-file setup.
  const sub = await context.newPage();
  await sub.goto(`http://mail.foo.localhost:${server.port}/`);
  const parent = await context.newPage();
  await parent.goto(`http://foo.localhost:${server.port}/`);
  expect((await getCookies(sw, 'foo.localhost')).length).toBeGreaterThan(0);

  // Closing the subdomain tab must NOT clean: foo.localhost is still open
  // and both share the registrable domain "foo.localhost".
  await sub.close();
  await sleep(3000);
  expect((await getCookies(sw, 'foo.localhost')).length).toBeGreaterThan(0);

  // Closing the last tab of the domain cleans cookies for parent + subdomains.
  await parent.close();
  await sleep(3000);
  expect(await getCookies(sw, 'foo.localhost')).toHaveLength(0);
  expect(await getCookies(sw, 'mail.foo.localhost')).toHaveLength(0);

  await context.close();
  await server.close();
});

test('edge ④: alarm fires the pending cleanup after the service worker is killed', async () => {
  test.setTimeout(120_000);
  const { context, extensionId, sw } = await launchWithExtension();
  const server = await startCookieServer();
  await setSettings(sw, { delaySeconds: 8 });

  // Assert cookies through an extension page so we don't depend on any
  // particular service-worker instance being alive.
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const cookieCount = () =>
    extPage.evaluate(async () => (await chrome.cookies.getAll({ domain: '127.0.0.1' })).length);

  const page = await context.newPage();
  await page.goto(server.url);
  expect(await cookieCount()).toBeGreaterThan(0);
  await page.close();
  await sleep(700); // pending cleanup persisted to storage.local

  // Kill the worker mid-delay via CDP — the real chrome://serviceworker-internals
  // "Stop" equivalent. The in-worker setTimeout dies with it; the chrome.alarms
  // fallback (clamped to +30 s) must wake a fresh worker and finish the job.
  const cdp = await context.newCDPSession(extPage);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');

  await sleep(38_000); // alarm fallback fires ~30 s after scheduling
  expect(await cookieCount()).toBe(0);

  await context.close();
  await server.close();
});

test('edge ⑤: greylisted domains are cleaned when the browser restarts', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cookiemop-profile-'));
  const server = await startCookieServer();

  // Session 1: greylist the site, visit it, quit the browser with cookies present.
  let { context, sw } = await launchWithExtension(userDataDir);
  await setSettings(sw, {
    delaySeconds: 1,
    rules: { '127.0.0.1': { list: 'grey', addedAt: 1 } }
  });
  const page = await context.newPage();
  await page.goto(server.url);
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);
  await page.close();
  await sleep(3000); // greylisted → tab close must NOT clean
  expect((await getCookies(sw, '127.0.0.1')).length).toBeGreaterThan(0);
  await context.close();

  // Session 2: same profile → the new-session greylist pass cleans the
  // cookies. Poll: extension init can be slow on a loaded machine.
  ({ context, sw } = await launchWithExtension(userDataDir));
  await expect
    .poll(async () => (await getCookies(sw, '127.0.0.1')).length, { timeout: 15_000 })
    .toBe(0);

  await context.close();
  await server.close();
});
