// CookieMop options page. Reads and writes chrome.storage directly via the
// shared lib modules — no build step, no external dependencies.

import { normalizeDomainInput } from '../lib/domain.js';
import {
  getSettings,
  saveSettings,
  setRule,
  getStats,
  resetStats,
  saveProfile,
  switchProfile,
  deleteProfile,
  setKeptCookies
} from '../lib/store.js';
import {
  activateLicense,
  deactivateLicense,
  getStoredLicense,
  isPro,
  LicenseStatus
} from '../lib/license.js';
import { CHECKOUT_URL, LICENSE_LOOKUP_URL } from '../lib/config.js';

const $ = (id) => document.getElementById(id);
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

let settings = null;
let activeTab = 'all';

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18nPlaceholder);
    if (m) el.placeholder = m;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (m) el.title = m;
  });
  document.title = msg('optionsTitle');
}

function relativeTime(epochMs) {
  if (!epochMs) return '';
  const rtf = new Intl.RelativeTimeFormat(chrome.i18n.getUILanguage(), { numeric: 'auto' });
  const diffMs = epochMs - Date.now();
  const days = Math.round(diffMs / 86_400_000);
  if (Math.abs(days) >= 21) return rtf.format(Math.round(days / 7), 'week');
  if (Math.abs(days) >= 1) return rtf.format(days, 'day');
  const hours = Math.round(diffMs / 3_600_000);
  if (Math.abs(hours) >= 1) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(diffMs / 60_000), 'minute');
}

function renderRules() {
  const list = $('rule-list');
  list.textContent = '';
  const entries = Object.entries(settings.rules)
    .map(([domain, rule]) => ({ domain, ...rule }))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  $('count-all').textContent = String(entries.length);
  const filtered = entries.filter((e) => activeTab === 'all' || e.list === activeTab);
  $('rule-empty').classList.toggle('hidden', filtered.length > 0);

  for (const entry of filtered) {
    const li = document.createElement('li');
    li.className = 'rule-item';

    const info = document.createElement('div');
    info.className = 'rule-info';
    const name = document.createElement('p');
    name.className = 'rule-domain';
    name.textContent = entry.domain;
    const added = document.createElement('p');
    added.className = 'rule-added';
    added.textContent = msg('ruleAdded', [relativeTime(entry.addedAt)]);
    info.append(name, added);

    const badge = document.createElement('span');
    badge.className = `badge ${entry.list === 'white' ? 'badge-white' : 'badge-grey'}`;
    badge.textContent = entry.list === 'white' ? msg('badgeWhitelist') : msg('badgeGreylist');

    const remove = document.createElement('button');
    remove.className = 'rule-remove';
    remove.title = msg('removeRule');
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      settings.rules = await setRule(entry.domain, null);
      renderRules();
    });

    li.append(info, badge, remove);
    list.appendChild(li);
  }
}

async function renderStats() {
  const stats = await getStats();
  $('stat-today').textContent = stats.todayCleaned.toLocaleString();
  $('stat-total').textContent = stats.totalCleaned.toLocaleString();
}

function renderSettings() {
  $('delay').value = String(settings.delaySeconds);
  $('delay-value').textContent = String(settings.delaySeconds);
  const scopeInput = document.querySelector(`input[name="scope"][value="${settings.scope}"]`);
  if (scopeInput) scopeInput.checked = true;
}

// --- Cleanup settings ---

$('delay').addEventListener('input', () => {
  $('delay-value').textContent = $('delay').value;
});
$('delay').addEventListener('change', async () => {
  settings.delaySeconds = Number($('delay').value);
  await saveSettings({ delaySeconds: settings.delaySeconds });
});

document.querySelectorAll('input[name="scope"]').forEach((input) => {
  input.addEventListener('change', async () => {
    if (input.checked) {
      settings.scope = input.value;
      await saveSettings({ scope: settings.scope });
    }
  });
});

// --- Rules ---

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderRules();
  });
});

async function addRule() {
  const domain = normalizeDomainInput($('add-domain').value);
  if (!domain) {
    $('add-domain').focus();
    return;
  }
  settings.rules = await setRule(domain.replace(/^\*\./, ''), $('add-list').value);
  $('add-domain').value = '';
  renderRules();
}
$('add-btn').addEventListener('click', addRule);
$('add-domain').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addRule();
});

// --- Cookie AutoDelete import ---
// CAD "export expressions" produces either an array of expression objects or
// an object keyed by container/store id whose values are such arrays:
//   { "expression": "*.example.com", "listType": "WHITE" | "GREY", ... }

function extractCadExpressions(json) {
  const out = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      if (typeof value.expression === 'string' && typeof value.listType === 'string') {
        out.push(value);
      } else {
        Object.values(value).forEach(visit);
      }
    }
  };
  visit(json);
  return out;
}

$('import-btn').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  if (!file) return;
  const result = $('import-result');
  result.classList.remove('error');
  try {
    const json = JSON.parse(await file.text());
    const expressions = extractCadExpressions(json);
    let imported = 0;
    for (const expr of expressions) {
      const domain = normalizeDomainInput(expr.expression.replace(/^\*\./, ''));
      if (!domain) continue;
      const listType = expr.listType.toUpperCase();
      const list = listType === 'WHITE' ? 'white' : listType === 'GREY' ? 'grey' : null;
      if (!list) continue;
      settings.rules = await setRule(domain, list);
      imported++;
    }
    if (imported === 0) throw new Error('no entries');
    result.textContent = msg('importResult', [String(imported)]);
    renderRules();
  } catch {
    result.textContent = msg('importError');
    result.classList.add('error');
  }
  $('import-file').value = '';
});

// --- Pro gating ---
//
// The upsell appears only when someone actually reaches for a Pro feature,
// and it says what they would get rather than what they are missing. There
// is no timer, no banner and nothing to dismiss.

function showUpsell(elementId, benefitKey) {
  const el = $(elementId);
  el.textContent = '';
  el.append(document.createTextNode(msg(benefitKey) + ' '));
  const link = document.createElement('a');
  link.href = '#pro-card';
  link.textContent = msg('proSeeDetails');
  link.addEventListener('click', () => {
    $('pro-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  el.append(link);
  el.classList.remove('hidden');
}

/** Runs `action` when licensed; otherwise surfaces the contextual upsell. */
async function withPro(elementId, benefitKey, action) {
  if (await isPro()) {
    $(elementId).classList.add('hidden');
    return action();
  }
  showUpsell(elementId, benefitKey);
}

// --- Rule profiles (Pro) ---

function renderProfiles() {
  const list = $('profile-list');
  list.textContent = '';
  for (const profile of settings.profiles) {
    const li = document.createElement('li');
    li.className = 'rule-item';

    const info = document.createElement('div');
    info.className = 'rule-info';
    const name = document.createElement('p');
    name.className = 'rule-domain';
    name.textContent = profile.name;
    const meta = document.createElement('p');
    meta.className =
      profile.id === settings.activeProfileId ? 'profile-active' : 'rule-added';
    meta.textContent =
      profile.id === settings.activeProfileId
        ? msg('profilesInUse')
        : msg('profilesRuleCount', [String(Object.keys(profile.rules || {}).length)]);
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'rule-actions';
    if (profile.id !== settings.activeProfileId) {
      const useBtn = document.createElement('button');
      useBtn.className = 'btn-tiny';
      useBtn.textContent = msg('profilesUse');
      useBtn.addEventListener('click', () =>
        withPro('profile-upsell', 'profilesBenefit', async () => {
          await switchProfile(profile.id);
          settings = await getSettings();
          renderProfiles();
          renderRules();
        })
      );
      actions.append(useBtn);
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'rule-remove';
    removeBtn.textContent = '×';
    removeBtn.title = msg('profilesDelete');
    removeBtn.addEventListener('click', async () => {
      await deleteProfile(profile.id);
      settings = await getSettings();
      renderProfiles();
    });
    actions.append(removeBtn);

    li.append(info, actions);
    list.appendChild(li);
  }
}

$('profile-save').addEventListener('click', () =>
  withPro('profile-upsell', 'profilesBenefit', async () => {
    const name = $('profile-name').value.trim();
    if (!name) {
      $('profile-name').focus();
      return;
    }
    await saveProfile(name);
    $('profile-name').value = '';
    settings = await getSettings();
    renderProfiles();
  })
);

// --- Per-cookie whitelist (Pro) ---

function renderKeepCookies() {
  const list = $('keep-list');
  list.textContent = '';
  for (const [domain, names] of Object.entries(settings.keepCookies)) {
    const li = document.createElement('li');
    li.className = 'rule-item';

    const info = document.createElement('div');
    info.className = 'rule-info';
    const title = document.createElement('p');
    title.className = 'rule-domain';
    title.textContent = domain;
    const detail = document.createElement('p');
    detail.className = 'keep-names';
    detail.textContent = names.join(', ');
    info.append(title, detail);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'rule-remove';
    removeBtn.textContent = '×';
    removeBtn.title = msg('keepRemove');
    removeBtn.addEventListener('click', async () => {
      await setKeptCookies(domain, []);
      settings = await getSettings();
      renderKeepCookies();
    });

    li.append(info, removeBtn);
    list.appendChild(li);
  }
}

$('keep-save').addEventListener('click', () =>
  withPro('keep-upsell', 'keepBenefit', async () => {
    const domain = normalizeDomainInput($('keep-domain').value);
    const names = $('keep-names').value.split(',').map((n) => n.trim()).filter(Boolean);
    if (!domain || !names.length) {
      $(domain ? 'keep-names' : 'keep-domain').focus();
      return;
    }
    await setKeptCookies(domain, names);
    $('keep-domain').value = '';
    $('keep-names').value = '';
    settings = await getSettings();
    renderKeepCookies();
  })
);

// --- Pro / license ---

function licenseMessage(status) {
  switch (status) {
    case LicenseStatus.VALID:
      return msg('proActivated');
    case LicenseStatus.EMPTY:
      return msg('proErrorEmpty');
    case LicenseStatus.UNSUPPORTED:
      return msg('proErrorUnsupported');
    default:
      // Malformed and bad-signature read the same to the user: the key they
      // pasted is not a working key. No need to teach them the difference.
      return msg('proErrorInvalid');
  }
}

async function renderPro() {
  const pro = await isPro();
  const license = pro ? await getStoredLicense() : null;

  $('pro-badge').classList.toggle('hidden', !pro);
  $('pro-offer').classList.toggle('hidden', pro);
  $('pro-activate').classList.toggle('hidden', pro);
  $('pro-status').classList.toggle('hidden', !pro);

  if (pro && license) {
    const licensed = $('pro-licensed');
    licensed.textContent = '';
    licensed.append(
      document.createTextNode(msg('proLicensedTo') + ' '),
      Object.assign(document.createElement('b'), { textContent: license.email })
    );
  }
  $('pro-buy').href = CHECKOUT_URL;
  $('license-lookup-link').href = LICENSE_LOOKUP_URL;
}

$('license-activate').addEventListener('click', async () => {
  const result = $('license-result');
  const { status } = await activateLicense($('license-input').value);
  result.textContent = licenseMessage(status);
  result.classList.toggle('error', status !== LicenseStatus.VALID);
  if (status === LicenseStatus.VALID) {
    $('license-input').value = '';
    await renderPro();
    renderRules();
  }
});

$('license-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('license-activate').click();
});

$('license-remove').addEventListener('click', async () => {
  await deactivateLicense();
  $('license-result').textContent = '';
  await renderPro();
  renderRules();
});

// --- Stats ---

$('stats-reset').addEventListener('click', async () => {
  await resetStats();
  renderStats();
});

// --- Init ---

(async () => {
  applyI18n();
  settings = await getSettings();
  renderSettings();
  renderRules();
  renderStats();
  renderProfiles();
  renderKeepCookies();
  renderPro();
})();

// Live-refresh rules if changed from the popup while this page is open.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes.rules) {
    settings.rules = changes.rules.newValue || {};
    renderRules();
  }
  if (area === 'local' && changes.stats) renderStats();
  // A license activated on another device arrives through sync.
  if (area === 'sync' && changes.license) {
    renderPro();
    renderRules();
  }
});
