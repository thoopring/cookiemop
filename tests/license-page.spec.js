// /license page tests — specifically the test-mode warning banner.
//
// The page is static, so it asks the API whether test orders are currently
// being accepted. These tests serve the real file over http and stub that
// one response.

import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAGE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'server',
  'public',
  'license.html'
);

/** Serve license.html, with /api/license answered by `statusBody`. */
function startPageServer(statusBody) {
  const html = readFileSync(PAGE_PATH);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/license')) {
      if (statusBody === null) {
        res.statusCode = 500;
        res.end('{}');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(statusBody));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/license`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

let browser, context, server;

test.beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => {
  await browser.close();
});

test.beforeEach(async () => {
  context = await browser.newContext();
});
test.afterEach(async () => {
  await context.close();
  if (server) {
    await server.close();
    server = null;
  }
});

test('the banner is shown, in red, while test mode is active', async () => {
  server = await startPageServer({ testMode: { active: true, expiresAt: '2026-08-25' } });
  const page = await context.newPage();
  await page.goto(server.url);

  const banner = page.locator('#testbanner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('TEST MODE ACTIVE');
  await expect(banner).toContainText('expires 2026-08-25');
  await expect(banner).toContainText('Remove ALLOW_TEST_MODE before real sales.');

  // Loud enough that nobody scrolls past it on the live site.
  const background = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).toBe('rgb(220, 38, 38)');
});

test('no banner appears when test mode is off', async () => {
  server = await startPageServer({ testMode: { active: false, expiresAt: null } });
  const page = await context.newPage();
  await page.goto(server.url);

  await expect(page.locator('#testbanner')).toBeHidden();
  // The form is still the thing the buyer sees first.
  await expect(page.locator('#form')).toBeVisible();
});

test('a failing status check leaves the page usable and shows no banner', async () => {
  server = await startPageServer(null);
  const page = await context.newPage();
  await page.goto(server.url);

  await expect(page.locator('#testbanner')).toBeHidden();
  await expect(page.locator('#submit')).toBeEnabled();
});

test('the page keeps its lookup form and recovery note', async () => {
  server = await startPageServer({ testMode: { active: false, expiresAt: null } });
  const page = await context.newPage();
  await page.goto(server.url);

  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#order')).toBeVisible();
  await expect(page.locator('.foot')).toContainText('look it up again');
  await expect(page.locator('.foot')).toContainText('다시 조회할 수 있습니다');
});
