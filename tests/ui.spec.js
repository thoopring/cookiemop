// Popup and options page UI tests: rendering, persistence, rules, import.

import { test, expect } from '@playwright/test';
import { launchWithExtension, setSettings, startCookieServer } from './helpers.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let context, extensionId, sw, server;

test.beforeEach(async () => {
  ({ context, extensionId, sw } = await launchWithExtension());
});

test.afterEach(async () => {
  // Close the browser before the HTTP server — open keep-alive connections
  // would make server.close() wait forever otherwise.
  await context.close();
  if (server) {
    await server.close();
    server = null;
  }
});

const popupUrl = () => `chrome-extension://${extensionId}/src/popup/popup.html`;
const optionsUrl = () => `chrome-extension://${extensionId}/src/options/options.html`;

test('popup renders header, segments, toggle and footer', async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());
  await expect(page.locator('h1')).toHaveText('CookieMop');
  await expect(page.locator('.seg-btn')).toHaveCount(3);
  await expect(page.locator('#toggle-enabled')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.local-only')).toBeVisible();
  await expect(page.locator('#stats-line')).toContainText('0');
});

test('popup enable toggle persists across reloads', async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());
  await page.locator('#toggle-enabled').click();
  await expect(page.locator('#toggle-enabled')).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.locator('#toggle-enabled')).toHaveAttribute('aria-checked', 'false');
});

test('popup delete subtitle reflects delay and scope settings', async () => {
  await setSettings(sw, { delaySeconds: 30, scope: 'all' });
  const page = await context.newPage();
  await page.goto(popupUrl());
  await expect(page.locator('#delete-sub')).toContainText('30');
  await expect(page.locator('#delete-sub')).toContainText('site data');
});

test('options: delay and scope save and restore', async () => {
  const page = await context.newPage();
  await page.goto(optionsUrl());

  await page.locator('#delay').evaluate((el) => {
    el.value = '30';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('input[name="scope"][value="all"]').check();

  await page.reload();
  await expect(page.locator('#delay')).toHaveValue('30');
  await expect(page.locator('input[name="scope"][value="all"]')).toBeChecked();
});

test('options: add, filter and remove rules', async () => {
  const page = await context.newPage();
  await page.goto(optionsUrl());

  await page.locator('#add-domain').fill('example.com');
  await page.locator('#add-list').selectOption('white');
  await page.locator('#add-btn').click();
  await expect(page.locator('.rule-item')).toHaveCount(1);
  await expect(page.locator('.rule-domain')).toHaveText('example.com');
  await expect(page.locator('.badge-white')).toBeVisible();

  await page.locator('#add-domain').fill('https://news.ycombinator.com/item?id=1');
  await page.locator('#add-list').selectOption('grey');
  await page.locator('#add-btn').click();
  await expect(page.locator('.rule-item')).toHaveCount(2);
  await expect(page.locator('#count-all')).toHaveText('2');

  // Filter tabs
  await page.locator('.tab[data-tab="white"]').click();
  await expect(page.locator('.rule-item')).toHaveCount(1);
  await page.locator('.tab[data-tab="grey"]').click();
  await expect(page.locator('.rule-item')).toHaveCount(1);
  await expect(page.locator('.rule-domain')).toHaveText('news.ycombinator.com');

  // Persists across reload
  await page.reload();
  await expect(page.locator('#count-all')).toHaveText('2');

  // Remove
  await page.locator('.tab[data-tab="all"]').click();
  await page.locator('.rule-remove').first().click();
  await expect(page.locator('.rule-item')).toHaveCount(1);
});

test('options: imports a Cookie AutoDelete JSON export', async () => {
  const page = await context.newPage();
  await page.goto(optionsUrl());

  const cad = [
    { expression: '*.github.com', listType: 'WHITE', storeId: 'default' },
    { expression: 'youtube.com', listType: 'GREY', storeId: 'default' },
    { expression: 'mail.google.com', listType: 'WHITE', storeId: 'default' }
  ];
  const file = join(tmpdir(), 'cad-export.json');
  writeFileSync(file, JSON.stringify(cad));

  await page.locator('#import-file').setInputFiles(file);
  await expect(page.locator('#import-result')).toContainText('3');
  await expect(page.locator('#count-all')).toHaveText('3');
  await expect(page.locator('.rule-domain').first()).toBeVisible();
});

test('options: rejects an invalid import file', async () => {
  const page = await context.newPage();
  await page.goto(optionsUrl());
  const file = join(tmpdir(), 'cad-bad.json');
  writeFileSync(file, '{"not": "cad"}');
  await page.locator('#import-file').setInputFiles(file);
  await expect(page.locator('#import-result')).toHaveClass(/error/);
});

test('review ask appears 7 days after install and never again once dismissed', async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());
  await expect(page.locator('#review-box')).toBeHidden(); // fresh install → hidden

  // Pretend the install happened 8 days ago.
  await sw.evaluate(() =>
    chrome.storage.local.set({ installedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
  );
  await page.reload();
  await expect(page.locator('#review-box')).toBeVisible();

  await page.locator('#btn-review-dismiss').click();
  await expect(page.locator('#review-box')).toBeHidden();
  await page.reload();
  await expect(page.locator('#review-box')).toBeHidden(); // policy: never re-shown
});

test('popup rule segment sets and clears a whitelist rule for the current site', async () => {
  // Popup opened as a page uses the last-focused site tab — open one first.
  server = await startCookieServer();
  const site = await context.newPage();
  await site.goto(server.url);
  // Headless tab activation is flaky — make sure the site tab (not the
  // context's initial about:blank tab) is the active/fallback tab.
  await site.bringToFront();

  const popup = await context.newPage();
  await popup.goto(popupUrl());
  await expect(popup.locator('#site-domain')).toHaveText('127.0.0.1');

  await popup.locator('.seg-btn[data-rule="white"]').click();
  await expect(popup.locator('.seg-btn[data-rule="white"]')).toHaveClass(/active/);
  let rules = await sw.evaluate(async () => (await chrome.storage.sync.get('rules')).rules);
  expect(rules['127.0.0.1'].list).toBe('white');

  await popup.locator('.seg-btn[data-rule="auto"]').click();
  await expect(popup.locator('.seg-btn[data-rule="auto"]')).toHaveClass(/active/);
  rules = await sw.evaluate(async () => (await chrome.storage.sync.get('rules')).rules);
  expect(rules['127.0.0.1']).toBeUndefined();
});
