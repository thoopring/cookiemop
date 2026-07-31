// Cookie & site-data deletion engine.
// All deletions are local chrome.* API calls — nothing ever leaves the browser.

import { getRuleFor } from './domain.js';
import { addCleanedCount } from './store.js';

// Chrome cookie store ids: "0" = default profile, "1" = incognito (spanning mode).
export const STORE_DEFAULT = '0';
export const STORE_INCOGNITO = '1';

function cookieUrl(cookie) {
  const host = cookie.domain.replace(/^\./, '');
  return (cookie.secure ? 'https://' : 'http://') + host + cookie.path;
}

async function removeCookie(cookie) {
  try {
    await chrome.cookies.remove({
      url: cookieUrl(cookie),
      name: cookie.name,
      storeId: cookie.storeId
    });
    return true;
  } catch {
    return false;
  }
}

async function getStoreIds() {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.map((s) => s.id);
  } catch {
    return [STORE_DEFAULT];
  }
}

/**
 * Delete cookies whose domain matches `domain` (includes subdomains).
 * `filter(cookie)` decides per cookie; return true to delete.
 * Returns the number of cookies removed.
 */
export async function cleanCookiesForDomain(domain, { storeId, filter } = {}) {
  const storeIds = storeId ? [storeId] : await getStoreIds();
  let removed = 0;
  for (const id of storeIds) {
    let cookies = [];
    try {
      cookies = await chrome.cookies.getAll({ domain, storeId: id });
    } catch {
      continue;
    }
    for (const cookie of cookies) {
      if (filter && !filter(cookie)) continue;
      if (await removeCookie(cookie)) removed++;
    }
  }
  return removed;
}

export function dataTypesForScope(scope) {
  if (scope === 'storage') {
    return { localStorage: true };
  }
  if (scope === 'all') {
    return {
      localStorage: true,
      indexedDB: true,
      cacheStorage: true,
      serviceWorkers: true
    };
  }
  return null; // 'cookies' — nothing beyond cookies
}

/**
 * Remove site data (localStorage / IndexedDB / CacheStorage / SW registrations)
 * for the given hostnames, according to the configured scope.
 */
export async function cleanSiteData(hostnames, scope) {
  const dataTypes = dataTypesForScope(scope);
  if (!dataTypes || !hostnames.length) return;
  const origins = [];
  for (const host of hostnames) {
    origins.push('https://' + host, 'http://' + host);
  }
  try {
    await chrome.browsingData.remove({ origins }, dataTypes);
  } catch {
    // browsingData can reject on unsupported origins — cookies were already
    // handled, so a failure here must not break the cleanup pass.
  }
}

/**
 * Count cookies for a registrable domain (badge / popup display).
 */
export async function countCookies(domain, storeId = STORE_DEFAULT) {
  if (!domain) return 0;
  try {
    const cookies = await chrome.cookies.getAll({ domain, storeId });
    return cookies.length;
  } catch {
    return 0;
  }
}

/**
 * Automatic cleanup of one registrable domain after its last tab closed.
 * Skips cookies that are covered by a whitelist or greylist rule
 * (a whitelisted subdomain survives cleanup of its parent domain).
 */
export async function autoCleanDomain({ domain, hostnames, storeId, rules, scope }) {
  const removed = await cleanCookiesForDomain(domain, {
    storeId,
    filter: (cookie) => {
      const cookieHost = cookie.domain.replace(/^\./, '');
      return getRuleFor(cookieHost, rules) === null;
    }
  });
  const cleanHosts = (hostnames || []).filter((h) => getRuleFor(h, rules) === null);
  await cleanSiteData(cleanHosts, scope);
  await addCleanedCount(removed);
  return removed;
}

/**
 * Manual "clean this site now": explicit user action, ignores list rules.
 */
export async function manualCleanSite({ domain, hostnames, storeId, scope }) {
  const removed = await cleanCookiesForDomain(domain, { storeId });
  await cleanSiteData(hostnames || [domain], scope);
  await addCleanedCount(removed);
  return removed;
}

/**
 * Manual "clean everything except open tabs".
 * Respects whitelist and greylist rules; skips domains open in any tab.
 * `openDomains` is a Set of registrable domains currently open.
 */
export async function cleanAllExceptOpen({ openDomains, rules, getDomain }) {
  const storeIds = await getStoreIds();
  let removed = 0;
  for (const id of storeIds) {
    let cookies = [];
    try {
      cookies = await chrome.cookies.getAll({ storeId: id });
    } catch {
      continue;
    }
    for (const cookie of cookies) {
      const cookieHost = cookie.domain.replace(/^\./, '');
      if (openDomains.has(getDomain(cookieHost))) continue;
      if (getRuleFor(cookieHost, rules) !== null) continue;
      if (await removeCookie(cookie)) removed++;
    }
  }
  await addCleanedCount(removed);
  return removed;
}

/**
 * Browser-startup pass: greylisted domains are cleaned "on browser close",
 * implemented as clean-on-next-startup (the only reliable MV3 hook).
 */
export async function cleanGreylistOnStartup(rules, scope) {
  let removed = 0;
  const greyDomains = Object.entries(rules)
    .filter(([, r]) => r.list === 'grey')
    .map(([d]) => d);
  for (const domain of greyDomains) {
    const hostnames = new Set([domain]);
    removed += await cleanCookiesForDomain(domain, {
      filter: (cookie) => {
        const cookieHost = cookie.domain.replace(/^\./, '');
        hostnames.add(cookieHost);
        // A more specific whitelist rule wins over the greylist entry.
        return getRuleFor(cookieHost, rules) !== 'white';
      }
    });
    await cleanSiteData(
      [...hostnames].filter((h) => getRuleFor(h, rules) !== 'white'),
      scope
    );
  }
  await addCleanedCount(removed);
  return removed;
}
