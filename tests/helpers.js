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
    // Pin the UI language: the popup picks its strings from the browser
    // locale, and the assertions below expect English. Without this the suite
    // passes or fails depending on the machine it runs on.
    locale: 'en-US',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--lang=en-US'
    ]
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;
  return { context, extensionId, sw };
}

// Chromium refuses to connect to these ports (net::ERR_UNSAFE_PORT). listen(0)
// can hand one out on some hosts, which turns a good test into a random failure.
const UNSAFE_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

/** server.listen(0) that retries until the OS-assigned port is one Chromium will connect to. */
export async function listenOnSafePort(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const { port } = server.address();
    if (!UNSAFE_PORTS.has(port)) return port;
    await new Promise((r) => server.close(r));
  }
  throw new Error('could not get a Chromium-safe port after 20 attempts');
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
  return listenOnSafePort(server).then((port) => ({
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise((r) => server.close(r))
  }));
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
