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

/**
 * Serve license.html.
 *  - GET  /api/license -> `statusBody` (null makes it fail)
 *  - POST /api/license -> `onLookup(body)` returning { status, body }
 * Recorded POST bodies are exposed for assertions.
 */
function startPageServer(statusBody, onLookup) {
  const html = readFileSync(PAGE_PATH);
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/license')) {
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          posts.push(body);
          const reply = onLookup ? onLookup(body) : { status: 404, body: { message: 'no' } };
          res.statusCode = reply.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(reply.body));
        });
        return;
      }
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
        posts,
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

// --- Lemon Squeezy redirect prefill --------------------------------------
// LS substitutes link variables into the post-purchase redirect, so most
// buyers land with everything filled in. A failed substitution must degrade
// to an ordinary form rather than block the sale.

const OFF = { testMode: { active: false, expiresAt: null } };
const KEY = 'CM1.payload.signature';

test('a redirect carrying email and order_id looks the key up by itself', async () => {
  server = await startPageServer(OFF, (body) => ({
    status: 200,
    body: { licenseKey: KEY, email: body.email, orderNumber: '1042' }
  }));
  const page = await context.newPage();
  await page.goto(`${server.url}?email=buyer%40example.com&order_id=ls-internal-77`);

  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#key')).toHaveText(KEY);
  // The order number comes back from the server, so the buyer can repeat
  // the lookup later without the redirect.
  await expect(page.locator('#order')).toHaveValue('1042');
  await expect(page.locator('#email')).toHaveValue('buyer@example.com');

  expect(server.posts).toHaveLength(1);
  expect(server.posts[0]).toMatchObject({ email: 'buyer@example.com', orderId: 'ls-internal-77' });
});

test('a redirect carrying order_number works the same way', async () => {
  server = await startPageServer(OFF, () => ({
    status: 200,
    body: { licenseKey: KEY, email: 'buyer@example.com', orderNumber: '1042' }
  }));
  const page = await context.newPage();
  await page.goto(`${server.url}?email=buyer%40example.com&order_number=1042`);

  await expect(page.locator('#key')).toHaveText(KEY);
  expect(server.posts[0]).toMatchObject({ email: 'buyer@example.com', orderNumber: '1042' });
});

test('an unsubstituted link variable is ignored, leaving a normal form', async () => {
  server = await startPageServer(OFF, () => ({ status: 200, body: { licenseKey: KEY } }));
  const page = await context.newPage();
  await page.goto(`${server.url}?email====[email]===&order_id====[order_id]===`);

  // No automatic attempt, and nothing pasted into the fields.
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('#order')).toHaveValue('');
  expect(server.posts).toHaveLength(0);
});

test('a failed automatic lookup says nothing and leaves the form usable', async () => {
  server = await startPageServer(OFF, () => ({
    status: 404,
    body: { message: 'We could not find that purchase.' }
  }));
  const page = await context.newPage();
  await page.goto(`${server.url}?email=buyer%40example.com&order_id=stale-id`);

  await expect(page.locator('#result')).toBeHidden();
  // Silent: an automatic attempt must not greet the buyer with an error.
  await expect(page.locator('#msg')).toBeHidden();
  await expect(page.locator('#submit')).toBeEnabled();
  // The email still got prefilled, so retrying by hand is one field away.
  await expect(page.locator('#email')).toHaveValue('buyer@example.com');
  expect(server.posts).toHaveLength(1);
});

test('a manual retry after a silent failure does show the error', async () => {
  server = await startPageServer(OFF, () => ({
    status: 404,
    body: { message: 'We could not find that purchase.' }
  }));
  const page = await context.newPage();
  await page.goto(`${server.url}?email=buyer%40example.com&order_id=stale-id`);
  await expect(page.locator('#msg')).toBeHidden();

  await page.locator('#order').fill('9999');
  await page.locator('#submit').click();
  await expect(page.locator('#msg')).toBeVisible();
  await expect(page.locator('#msg')).toHaveClass(/error/);
});

test('email alone in the redirect does not trigger a lookup', async () => {
  server = await startPageServer(OFF, () => ({ status: 200, body: { licenseKey: KEY } }));
  const page = await context.newPage();
  await page.goto(`${server.url}?email=buyer%40example.com`);

  await expect(page.locator('#email')).toHaveValue('buyer@example.com');
  await expect(page.locator('#result')).toBeHidden();
  expect(server.posts).toHaveLength(0);
});

// --- partial substitution (only some link variables resolved) -------------

test('order-only redirect leaves a one-field flow: type your email, get the key', async () => {
  server = await startPageServer(OFF, (body) => ({
    status: 200,
    body: { licenseKey: KEY, email: body.email, orderNumber: '1042' }
  }));
  const page = await context.newPage();
  // Email variable failed to substitute; order id came through.
  await page.goto(`${server.url}?email====[email]===&order_id=ls-internal-77`);

  // No auto-attempt without an email, but the buyer is told what remains.
  await expect(page.locator('#msg')).toBeVisible();
  await expect(page.locator('#msg')).toHaveClass(/info/);
  await expect(page.locator('#result')).toBeHidden();
  expect(server.posts).toHaveLength(0);

  await page.locator('#email').fill('buyer@example.com');
  await page.locator('#submit').click();
  await expect(page.locator('#key')).toHaveText(KEY);
  // The carried order id was used even though the order field stayed empty.
  expect(server.posts[0]).toMatchObject({ email: 'buyer@example.com', orderId: 'ls-internal-77' });
});

test('a typed order number beats the carried order id', async () => {
  server = await startPageServer(OFF, () => ({
    status: 200,
    body: { licenseKey: KEY, email: 'buyer@example.com', orderNumber: '9999' }
  }));
  const page = await context.newPage();
  await page.goto(`${server.url}?order_id=stale-id`);

  await page.locator('#email').fill('buyer@example.com');
  await page.locator('#order').fill('9999');
  await page.locator('#submit').click();
  await expect(page.locator('#key')).toHaveText(KEY);
  expect(server.posts[0].orderNumber).toBe('9999');
  expect(server.posts[0].orderId).toBeFalsy();
});

test('customer_email is accepted as an email parameter', async () => {
  server = await startPageServer(OFF, (body) => ({
    status: 200,
    body: { licenseKey: KEY, email: body.email, orderNumber: '1042' }
  }));
  const page = await context.newPage();
  await page.goto(`${server.url}?customer_email=buyer%40example.com&order_id=ls-internal-77`);

  await expect(page.locator('#key')).toHaveText(KEY);
  expect(server.posts[0]).toMatchObject({ email: 'buyer@example.com', orderId: 'ls-internal-77' });
});
