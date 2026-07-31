// CookieMop options page. Reads and writes chrome.storage directly via the
// shared lib modules — no build step, no external dependencies.

import { normalizeDomainInput } from '../lib/domain.js';
import { getSettings, saveSettings, setRule, getStats, resetStats } from '../lib/store.js';

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
})();

// Live-refresh rules if changed from the popup while this page is open.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes.rules) {
    settings.rules = changes.rules.newValue || {};
    renderRules();
  }
  if (area === 'local' && changes.stats) renderStats();
});
