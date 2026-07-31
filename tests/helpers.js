// Shared test helpers: launch Chromium with the extension loaded and
// run a throwaway HTTP server that sets cookies.

import { chromium } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// COOKIEMOP_EXT_PATH lets the suite run against a packaged build
// (e.g. the unzipped store ZIP) instead of the repo working tree.
const EXT_PATH =
  process.env.COOKIEMOP_EXT_PATH ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function launchWithExtension(userDataDir = '') {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`
    ]
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;
  return { context, extensionId, sw };
}

/**
 * Minimal HTTP server on 127.0.0.1 that sets a cookie on every response.
 * Returns { url, port, close }.
 */
export function startCookieServer() {
  const server = http.createServer((req, res) => {
    // Max-Age makes them persistent cookies, so they survive browser
    // restarts (needed for the greylist-on-restart test).
    res.setHeader('Set-Cookie', [
      'cm_test=1; Path=/; Max-Age=86400',
      'cm_extra=2; Path=/; Max-Age=86400'
    ]);
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>cookie server</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/** Read cookies for a domain from inside the extension service worker. */
export function getCookies(sw, domain) {
  return sw.evaluate((d) => chrome.cookies.getAll({ domain: d }), domain);
}

/** Overwrite extension settings from inside the service worker. */
export function setSettings(sw, patch) {
  return sw.evaluate((p) => chrome.storage.sync.set(p), patch);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
