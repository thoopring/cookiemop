// CookieMop service worker (Manifest V3).
//
// Core flow:
//   1. tabs.onUpdated       — record every domain a tab visits (storage.session,
//                             survives service-worker sleep).
//   2. tabs.onRemoved       — schedule a delayed cleanup for the tab's domains
//                             (storage.local, survives browser restart).
//   3. delay elapses        — re-check that no other open tab uses the domain,
//                             then delete its cookies (and site data per scope).
//
// The delay runs on a setTimeout while the worker is alive, with a
// chrome.alarms fallback (alarms are clamped to >= 30 s by Chrome) so the
// cleanup still fires if the worker is killed. Overdue cleanups are also
// processed on worker startup and browser startup.

import { getHostname, getRegistrableDomain, getRuleFor } from './lib/domain.js';
import {
  getSettings,
  getStats,
  setRule,
  getPendingCleanups,
  setPendingCleanups
} from './lib/store.js';
import {
  autoCleanDomain,
  manualCleanSite,
  cleanAllExceptOpen,
  cleanGreylistOnStartup,
  countCookies,
  STORE_DEFAULT,
  STORE_INCOGNITO
} from './lib/cleaner.js';

const ALARM_NAME = 'cookiemop-pending';
const ALARM_MIN_MS = 30_000; // Chrome clamps MV3 alarms to a 30 s minimum
const BADGE_COLOR = '#10b981';
const UNINSTALL_URL = 'https://github.com/thoopring/cookiemop/issues';

// ---------------------------------------------------------------------------
// Tab → domain tracking (chrome.storage.session)
// ---------------------------------------------------------------------------

const tabKey = (tabId) => `tab:${tabId}`;

async function recordTabUrl(tabId, url, incognito) {
  const hostname = getHostname(url);
  if (!hostname) return;
  const key = tabKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const rec = stored[key] || { hosts: [], incognito: !!incognito };
  if (!rec.hosts.includes(hostname)) {
    rec.hosts.push(hostname);
    await chrome.storage.session.set({ [key]: rec });
  }
}

async function takeTabRecord(tabId) {
  const key = tabKey(tabId);
  const stored = await chrome.storage.session.get(key);
  if (stored[key]) await chrome.storage.session.remove(key);
  return stored[key] || null;
}

/** Snapshot all currently open tabs into the session store (used at startup). */
async function seedOpenTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id !== undefined && tab.url) {
      await recordTabUrl(tab.id, tab.url, tab.incognito);
    }
  }
}

/** Map of storeId -> Set of registrable domains currently open in tabs. */
async function getOpenDomainsByStore() {
  const tabs = await chrome.tabs.query({});
  const map = { [STORE_DEFAULT]: new Set(), [STORE_INCOGNITO]: new Set() };
  for (const tab of tabs) {
    const hostname = getHostname(tab.url || tab.pendingUrl);
    if (!hostname) continue;
    const store = tab.incognito ? STORE_INCOGNITO : STORE_DEFAULT;
    map[store].add(getRegistrableDomain(hostname));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Delayed cleanup scheduling
// ---------------------------------------------------------------------------

let timeoutHandle = null;

async function scheduleTick() {
  const pendings = await getPendingCleanups();
  if (!pendings.length) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  const earliest = Math.min(...pendings.map((p) => p.fireAt));
  const now = Date.now();
  // Alarm fallback: survives service-worker death (clamped to >= 30 s).
  chrome.alarms.create(ALARM_NAME, { when: Math.max(earliest, now + ALARM_MIN_MS) });
  // Precise timer while the worker is alive.
  if (timeoutHandle) clearTimeout(timeoutHandle);
  timeoutHandle = setTimeout(() => {
    timeoutHandle = null;
    processPendingCleanups();
  }, Math.max(0, earliest - now) + 100);
}

async function onTabClosed(tabId) {
  const rec = await takeTabRecord(tabId);
  if (!rec || !rec.hosts.length) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  const storeId = rec.incognito ? STORE_INCOGNITO : STORE_DEFAULT;
  const openByStore = await getOpenDomainsByStore();

  // Group visited hostnames by registrable domain.
  const byDomain = new Map();
  for (const host of rec.hosts) {
    const domain = getRegistrableDomain(host);
    if (!byDomain.has(domain)) byDomain.set(domain, new Set());
    byDomain.get(domain).add(host);
  }

  const pendings = await getPendingCleanups();
  const fireAt = Date.now() + settings.delaySeconds * 1000;
  let added = false;

  for (const [domain, hosts] of byDomain) {
    // Whitelist / greylist: never cleaned on tab close.
    if (getRuleFor(domain, settings.rules) !== null) continue;
    // Another open tab still uses this domain — skip (re-checked again at fire time).
    if (openByStore[storeId]?.has(domain)) continue;

    const existing = pendings.find((p) => p.domain === domain && p.storeId === storeId);
    if (existing) {
      existing.fireAt = fireAt;
      existing.hostnames = [...new Set([...existing.hostnames, ...hosts])];
    } else {
      pendings.push({ domain, hostnames: [...hosts], storeId, fireAt });
    }
    added = true;
  }

  if (added) {
    await setPendingCleanups(pendings);
    if (settings.delaySeconds === 0) {
      await processPendingCleanups();
    } else {
      await scheduleTick();
    }
  }
}

async function processPendingCleanups() {
  const pendings = await getPendingCleanups();
  if (!pendings.length) return;

  const settings = await getSettings();
  if (!settings.enabled) {
    await setPendingCleanups([]);
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const now = Date.now();
  const openByStore = await getOpenDomainsByStore();
  const remaining = [];

  for (const pending of pendings) {
    if (pending.fireAt > now + 250) {
      remaining.push(pending);
      continue;
    }
    // Re-check: was the domain re-opened during the delay? Rules may also
    // have changed since scheduling.
    if (openByStore[pending.storeId]?.has(pending.domain)) continue;
    if (getRuleFor(pending.domain, settings.rules) !== null) continue;
    await autoCleanDomain({
      domain: pending.domain,
      hostnames: pending.hostnames,
      storeId: pending.storeId,
      rules: settings.rules,
      scope: settings.scope
    });
  }

  await setPendingCleanups(remaining);
  await scheduleTick();
  updateBadgeForActiveTabs();
}

// ---------------------------------------------------------------------------
// Badge: cookie count for the active tab's site
// ---------------------------------------------------------------------------

let badgeTimer = null;

async function updateBadge(tab) {
  if (!tab || tab.id === undefined) return;
  const hostname = getHostname(tab.url || tab.pendingUrl);
  if (!hostname) {
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    } catch { /* tab may be gone */ }
    return;
  }
  const domain = getRegistrableDomain(hostname);
  const storeId = tab.incognito ? STORE_INCOGNITO : STORE_DEFAULT;
  const count = await countCookies(domain, storeId);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({
      tabId: tab.id,
      text: count > 0 ? String(count) : ''
    });
  } catch { /* tab may be gone */ }
}

async function updateBadgeForActiveTabs() {
  const tabs = await chrome.tabs.query({ active: true });
  for (const tab of tabs) await updateBadge(tab);
}

function updateBadgeDebounced() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    updateBadgeForActiveTabs();
  }, 250);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    recordTabUrl(tabId, changeInfo.url, tab.incognito);
  }
  if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) {
    updateBadge(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  onTabClosed(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tab);
  } catch { /* tab may be gone */ }
});

chrome.cookies.onChanged.addListener(() => {
  updateBadgeDebounced();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    processPendingCleanups();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ installedAt: Date.now() });
  }
  chrome.runtime.setUninstallURL(UNINSTALL_URL);
  await seedOpenTabs();
  updateBadgeForActiveTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.runtime.setUninstallURL(UNINSTALL_URL);
  const settings = await getSettings();
  if (settings.enabled) {
    // Greylist contract: cleaned when the browser closes — implemented as
    // clean-on-next-startup (the only reliable MV3 hook).
    await cleanGreylistOnStartup(settings.rules, settings.scope);
    // Cleanups scheduled right before the browser quit are overdue now.
    await processPendingCleanups();
  }
  await seedOpenTabs();
  updateBadgeForActiveTabs();
});

// Worker woke up (any reason): recover precise timers lost with the old
// worker instance and catch up on anything overdue.
processPendingCleanups();

// ---------------------------------------------------------------------------
// Messaging (popup / options)
// ---------------------------------------------------------------------------

const REVIEW_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

async function getPopupState() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const settings = await getSettings();
  const stats = await getStats();
  const local = await chrome.storage.local.get({ installedAt: 0, reviewHandled: false });

  const hostname = tab ? getHostname(tab.url || tab.pendingUrl) : null;
  const domain = hostname ? getRegistrableDomain(hostname) : null;
  const storeId = tab?.incognito ? STORE_INCOGNITO : STORE_DEFAULT;
  const cookieCount = domain ? await countCookies(domain, storeId) : 0;

  return {
    hostname,
    domain,
    storeId,
    cookieCount,
    rule: hostname ? getRuleFor(hostname, settings.rules) : null,
    settings,
    stats,
    showReview:
      !local.reviewHandled &&
      local.installedAt > 0 &&
      Date.now() - local.installedAt >= REVIEW_AFTER_MS
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'get-popup-state':
        sendResponse(await getPopupState());
        break;

      case 'set-rule': {
        if (message.list === null && message.hostname) {
          // "Auto-clean" clears any rule covering this site, whether it was
          // stored at the hostname or at the registrable-domain level.
          await setRule(message.hostname, null);
        }
        await setRule(message.domain, message.list);
        sendResponse(await getPopupState());
        break;
      }

      case 'toggle-enabled': {
        await chrome.storage.sync.set({ enabled: !!message.enabled });
        if (!message.enabled) {
          await setPendingCleanups([]);
          await chrome.alarms.clear(ALARM_NAME);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'clean-site': {
        const settings = await getSettings();
        const removed = await manualCleanSite({
          domain: message.domain,
          hostnames: message.hostnames || [message.domain],
          storeId: message.storeId || STORE_DEFAULT,
          scope: settings.scope
        });
        updateBadgeForActiveTabs();
        sendResponse({ removed });
        break;
      }

      case 'clean-all': {
        const settings = await getSettings();
        const openByStore = await getOpenDomainsByStore();
        const allOpen = new Set([
          ...openByStore[STORE_DEFAULT],
          ...openByStore[STORE_INCOGNITO]
        ]);
        const removed = await cleanAllExceptOpen({
          openDomains: allOpen,
          rules: settings.rules,
          getDomain: getRegistrableDomain
        });
        updateBadgeForActiveTabs();
        sendResponse({ removed });
        break;
      }

      case 'review-handled': {
        await chrome.storage.local.set({ reviewHandled: true });
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ error: 'unknown-message' });
    }
  })();
  return true; // keep the message channel open for the async response
});
