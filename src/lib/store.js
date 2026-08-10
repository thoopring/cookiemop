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
  // This stays the one rule set the cleaning engine reads. Pro's rule
  // profiles swap its contents rather than replacing the structure, so free
  // users and the v1.0 engine paths are untouched.
  rules: {},

  // --- Pro (v1.5). Empty for free users, so behaviour is unchanged. ---

  // [{ id, name, rules }] — saved rule sets a Pro user switches between.
  profiles: [],
  // id of the profile currently loaded into `rules`, or null when none is.
  activeProfileId: null,
  // { "example.com": ["session_id", ...] } — cookie names kept even when the
  // site is cleaned. Honoured by the engine regardless of licence state: a
  // lapsed licence must never cause cookies the user marked "keep" to be
  // deleted. Editing this map is what Pro gates.
  keepCookies: {}
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // Settings saved by v1.0 have no Pro keys at all. Filling them in here
    // means no migration step ever has to rewrite a live user's storage.
    rules: stored.rules || {},
    profiles: Array.isArray(stored.profiles) ? stored.profiles : [],
    keepCookies: stored.keepCookies || {}
  };
}

// --- Rule profiles (Pro) --------------------------------------------------
// A profile is a named snapshot of `rules`. Switching saves the live rules
// back into the profile they came from, then loads the target's rules.

export async function saveProfile(name) {
  const { rules, profiles } = await getSettings();
  const profile = {
    id: `p${Date.now().toString(36)}`,
    name: String(name).trim().slice(0, 40),
    rules: { ...rules }
  };
  const next = [...profiles, profile];
  await chrome.storage.sync.set({ profiles: next, activeProfileId: profile.id });
  return profile;
}

export async function switchProfile(profileId) {
  const { rules, profiles, activeProfileId } = await getSettings();
  const target = profiles.find((p) => p.id === profileId);
  if (!target) return null;

  const updated = profiles.map((p) =>
    p.id === activeProfileId ? { ...p, rules: { ...rules } } : p
  );
  await chrome.storage.sync.set({
    profiles: updated,
    activeProfileId: target.id,
    rules: { ...target.rules }
  });
  return target;
}

export async function deleteProfile(profileId) {
  const { profiles, activeProfileId } = await getSettings();
  await chrome.storage.sync.set({
    profiles: profiles.filter((p) => p.id !== profileId),
    activeProfileId: activeProfileId === profileId ? null : activeProfileId
  });
}

// --- Per-cookie whitelist (Pro) -------------------------------------------

export async function setKeptCookies(domain, cookieNames) {
  const { keepCookies } = await getSettings();
  const names = [...new Set(cookieNames.map((n) => String(n).trim()).filter(Boolean))];
  if (names.length) {
    keepCookies[domain] = names;
  } else {
    delete keepCookies[domain];
  }
  await chrome.storage.sync.set({ keepCookies });
  return keepCookies;
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
