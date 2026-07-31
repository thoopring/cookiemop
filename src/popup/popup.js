// CookieMop popup logic. All state comes from the background service worker
// via runtime messages; the popup itself never touches cookies directly.

const $ = (id) => document.getElementById(id);
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

let state = null;

// Inline confirm step for cleaning a whitelisted site: first click arms the
// row for 3 s, only a second click within that window actually cleans.
let confirmingClean = false;
let confirmTimer = null;

function disarmCleanConfirm() {
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = null;
  confirmingClean = false;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (m) el.title = m;
  });
}

function scopeLabel(scope) {
  if (scope === 'storage') return msg('scopeStorageShort');
  if (scope === 'all') return msg('scopeAllShort');
  return msg('scopeCookiesShort');
}

function render() {
  const s = state;
  const onSite = !!s.hostname;

  // Current site
  $('site-domain').textContent = onSite ? s.hostname : msg('popupNoSite');
  const pill = $('cookie-pill');
  pill.classList.toggle('hidden', !onSite);
  pill.textContent = msg('popupCookieCount', [String(s.cookieCount)]);

  // Rule segment
  const active = s.rule === 'white' ? 'white' : s.rule === 'grey' ? 'grey' : 'auto';
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.rule === active);
    btn.disabled = !onSite;
  });

  // Enabled toggle + subtitle
  $('toggle-enabled').setAttribute('aria-checked', String(s.settings.enabled));
  $('delete-sub').textContent = msg('popupDeleteSub', [
    String(s.settings.delaySeconds),
    scopeLabel(s.settings.scope)
  ]);
  $('header-status').textContent = s.settings.enabled
    ? msg('popupProtecting')
    : msg('popupPaused');

  // Clean-site row (title switches to an inline confirm when armed)
  const cleanRow = $('row-clean-site');
  cleanRow.querySelector('.row-title').textContent = confirmingClean
    ? msg('popupCleanConfirm')
    : msg('popupCleanSiteNow');
  cleanRow.classList.toggle('confirm', confirmingClean);
  $('clean-site-sub').textContent = onSite
    ? msg('popupCleanSiteSubN', [String(s.cookieCount)])
    : msg('popupCleanSiteSub');
  cleanRow.classList.toggle('busy', !onSite);

  // Stats
  $('stats-count').textContent = s.stats.todayCleaned.toLocaleString();

  // Review ask
  $('review-box').classList.toggle('hidden', !s.showReview);
}

function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1600);
}

async function send(payload) {
  return chrome.runtime.sendMessage(payload);
}

async function refresh() {
  state = await send({ type: 'get-popup-state' });
  render();
}

// --- Event handlers ---

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!state?.domain) return;
    disarmCleanConfirm();
    const rule = btn.dataset.rule;
    state = await send({
      type: 'set-rule',
      domain: state.domain,
      hostname: state.hostname,
      list: rule === 'auto' ? null : rule
    });
    render();
  });
});

$('toggle-enabled').addEventListener('click', async () => {
  const next = !state.settings.enabled;
  await send({ type: 'toggle-enabled', enabled: next });
  await refresh();
});

$('row-clean-site').addEventListener('click', async () => {
  if (!state?.domain) return;
  if (state.rule === 'white' && !confirmingClean) {
    // Whitelisted site: arm the inline confirm instead of cleaning right away.
    confirmingClean = true;
    render();
    confirmTimer = setTimeout(() => {
      disarmCleanConfirm();
      render();
    }, 3000);
    return;
  }
  disarmCleanConfirm();
  const row = $('row-clean-site');
  row.classList.add('busy');
  const res = await send({
    type: 'clean-site',
    domain: state.domain,
    hostnames: [state.hostname, state.domain],
    storeId: state.storeId
  });
  row.classList.remove('busy');
  toast(msg('popupCleanedToast', [String(res.removed)]));
  await refresh();
});

$('row-clean-all').addEventListener('click', async () => {
  const row = $('row-clean-all');
  row.classList.add('busy');
  const res = await send({ type: 'clean-all' });
  row.classList.remove('busy');
  toast(msg('popupCleanedToast', [String(res.removed)]));
  await refresh();
});

$('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('btn-review').addEventListener('click', async () => {
  await send({ type: 'review-handled' });
  chrome.tabs.create({
    url: `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`
  });
  window.close();
});

$('btn-review-dismiss').addEventListener('click', async () => {
  await send({ type: 'review-handled' });
  $('review-box').classList.add('hidden');
});

// Keyboard access for action rows
document.querySelectorAll('.row-action').forEach((row) => {
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      row.click();
    }
  });
});

applyI18n();
refresh();
