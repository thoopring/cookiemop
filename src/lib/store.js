// Settings, rules and statistics storage helpers.
// - Settings & rules live in chrome.storage.sync (roam across devices).
// - Stats, pending cleanups and install metadata live in chrome.storage.local.
// - Per-tab domain tracking lives in chrome.storage.session (see background.js).

export const DEFAULT_SETTINGS = {
  enabled: true,
  // Seconds to wait after a tab closes before cleaning (0-60).
  delaySeconds: 15,
  // 'cookies' | 'storage' (cookies + local/sessionStorage) | 'all' (+ IndexedDB, CacheStorage, Service Workers)
  scope: 'cookies',
  // { "example.com": { list: "white" | "grey", addedAt: epochMs } }
  rules: {}
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored, rules: stored.rules || {} };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

export async function setRule(domain, list) {
  const { rules } = await getSettings();
  if (list === null) {
    delete rules[domain];
  } else {
    rules[domain] = { list, addedAt: rules[domain]?.addedAt ?? Date.now() };
  }
  await chrome.storage.sync.set({ rules });
  return rules;
}

const STATS_DEFAULTS = { totalCleaned: 0, todayCleaned: 0, todayDate: '' };

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export async function getStats() {
  const { stats } = await chrome.storage.local.get({ stats: STATS_DEFAULTS });
  const merged = { ...STATS_DEFAULTS, ...stats };
  if (merged.todayDate !== todayKey()) {
    merged.todayCleaned = 0;
    merged.todayDate = todayKey();
  }
  return merged;
}

export async function addCleanedCount(count) {
  if (!count) return;
  const stats = await getStats();
  stats.totalCleaned += count;
  stats.todayCleaned += count;
  stats.todayDate = todayKey();
  await chrome.storage.local.set({ stats });
}

export async function resetStats() {
  await chrome.storage.local.set({ stats: { ...STATS_DEFAULTS, todayDate: todayKey() } });
}

// --- Pending cleanups (survive service-worker sleep AND browser restart) ---

export async function getPendingCleanups() {
  const { pendingCleanups } = await chrome.storage.local.get({ pendingCleanups: [] });
  return pendingCleanups;
}

export async function setPendingCleanups(list) {
  await chrome.storage.local.set({ pendingCleanups: list });
}
