// public/js/app.js — Finman app shell: state, auth gate, header + grouped
// navigation + drawer, routing, API helpers, currency/date formatting, toasts.
//
// Classic browser script (globals are shared with the feature modules). The
// DOM calls are guarded so the pure helpers can be required under node for
// unit tests (see test/fe-shell.test.js and the module.exports at the bottom).

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initApp();
  });
}

// ---------------------------------------------------------------------------
// Global application state
// ---------------------------------------------------------------------------
const appState = {
  isAuthenticated: false,
  user: null,
  token: null,
  currentPage: 'dashboard',
  accounts: [],
  // /api/accounts returns {own, shared, all}; `accounts` above is always the
  // flat array consumers expect, `accountsByScope` keeps the split.
  accountsByScope: { own: [], shared: [], all: [] },
  baseCurrency: 'CAD',
  currencySettings: null,
  transactions: [],
  categories: [],
  budgets: [],
  families: [],
  currentFamily: null,
  bankConnections: [],
  supportedBanks: [],
  filters: {
    startDate: null,
    endDate: null,
    accountId: null,
    category: null,
    type: null,
    search: '',
    page: 1
  }
};
// A top-level const is not a window property: expose it for lib/ui.js
// (UI.baseCurrency / UI.accountsArray read root.appState).
if (typeof window !== 'undefined') window.appState = appState;

// ---------------------------------------------------------------------------
// Navigation information architecture
// ---------------------------------------------------------------------------
const NAV_PRIMARY = [
  { page: 'dashboard', label: 'Dashboard', icon: 'fa-chart-line' },
  { page: 'transactions', label: 'Transactions', icon: 'fa-exchange-alt' },
  { page: 'accounts', label: 'Accounts', icon: 'fa-wallet' },
  { page: 'budgets', label: 'Budgets', icon: 'fa-piggy-bank' },
  { page: 'ai', label: 'AI CFO', icon: 'fa-robot' }
];

const NAV_GROUPS = [
  {
    title: 'Plan',
    items: [
      { page: 'goals', label: 'Goals', icon: 'fa-bullseye' },
      { page: 'debts', label: 'Debts', icon: 'fa-hand-holding-usd' },
      { page: 'subscriptions', label: 'Subscriptions', icon: 'fa-box' },
      { page: 'recurring', label: 'Recurring', icon: 'fa-sync-alt' },
      { page: 'calendar', label: 'Calendar', icon: 'fa-calendar' },
      { page: 'forecast', label: 'Forecast', icon: 'fa-chart-area' }
    ]
  },
  {
    title: 'Wealth',
    items: [
      { page: 'investments', label: 'Investments', icon: 'fa-chart-pie' },
      { page: 'networth', label: 'Net Worth', icon: 'fa-gem' },
      { page: 'analytics', label: 'Analytics', icon: 'fa-chart-bar' },
      { page: 'reports', label: 'Reports', icon: 'fa-file-alt' }
    ]
  },
  {
    title: 'Tools',
    items: [
      { page: 'receipts', label: 'Receipts', icon: 'fa-receipt' },
      { page: 'rules', label: 'Rules', icon: 'fa-magic' },
      { page: 'reconcile', label: 'Reconcile', icon: 'fa-balance-scale' },
      { page: 'split', label: 'Split', icon: 'fa-user-friends' },
      { page: 'family', label: 'Family', icon: 'fa-users' },
      { page: 'currency', label: 'Currency', icon: 'fa-coins' },
      { page: 'bank-connections', label: 'Banks', icon: 'fa-university' },
      { page: 'data-export', label: 'Data export', icon: 'fa-download' },
      { page: 'api-tokens', label: 'API tokens', icon: 'fa-key' },
      { page: 'billing', label: 'Billing', icon: 'fa-credit-card' },
      { page: 'settings', label: 'Settings', icon: 'fa-cog' }
    ]
  }
];

const LOADING_HTML = `
  <div class="loading" role="status" aria-live="polite" aria-label="Loading">
    <div class="spinner"></div>
    <p>Loading…</p>
    <div class="fm-skeleton" aria-hidden="true">
      <div class="fm-skeleton-row w-40"></div>
      <div class="fm-skeleton-card"></div>
      <div class="fm-skeleton-grid">
        <div class="fm-skeleton-card"></div>
        <div class="fm-skeleton-card"></div>
        <div class="fm-skeleton-card"></div>
      </div>
      <div class="fm-skeleton-row w-60"></div>
      <div class="fm-skeleton-row"></div>
      <div class="fm-skeleton-row w-40"></div>
    </div>
  </div>
`;

function pageHeaderHtml(title, extra = '') {
  return `
    <div class="page-header">
      <h1 class="page-title">${title}</h1>
      ${extra}
    </div>
  `;
}

function mountHtml(html) {
  const mainContent = document.getElementById('main-content');
  if (mainContent) mainContent.innerHTML = html;
  return mainContent;
}

function callGlobal(name, ...args) {
  const fn = typeof window !== 'undefined' ? window[name] : undefined;
  if (typeof fn !== 'function') {
    throw new Error(`The "${name}" module is not loaded`);
  }
  return fn(...args);
}

// page -> renderer. Every nav item and every wave-2 module has an entry.
const PAGE_RENDERERS = {
  dashboard: () => renderDashboard(),
  accounts: () => renderAccountsPage(),
  transactions: () => renderTransactionsPage(),
  budgets: () => callGlobal('renderBudgetsPage'),
  family: () => callGlobal('renderFamilyPage'),
  recurring: () => callGlobal('renderRecurringPage'),
  currency: () => callGlobal('renderCurrencyPage'),
  goals: () => callGlobal('renderGoalsPage'),
  debts: () => callGlobal('renderDebtsPage'),
  split: () => callGlobal('renderSplitPage'),
  investments: () => callGlobal('renderInvestmentsPage'),
  analytics: () => callGlobal('renderAnalyticsPage'),
  subscriptions: () => renderSubscriptionsPage(),
  networth: () => renderNetWorthPage(),
  receipts: () => renderReceiptsPage(),
  calendar: () => renderCalendarPage(),
  reports: () => renderReportsPage(),
  forecast: () => renderForecastPage(),
  'bank-connections': () => callGlobal('renderBankConnectionsPage'),
  settings: () => renderSettingsPage(),
  ai: () => {
    mountHtml('<div id="ai-cfo-content"></div>');
    if (window.AiCfoModule && typeof window.AiCfoModule.init === 'function') {
      return window.AiCfoModule.init();
    }
    throw new Error('The AI CFO module is not loaded');
  },
  rules: () => {
    mountHtml(pageHeaderHtml('Rules') + '<div id="rules-list"></div>');
    if (!window.RulesModule) throw new Error('The Rules module is not loaded');
    return window.RulesModule.init();
  },
  reconcile: () => callGlobal('renderReconcilePage'),
  billing: () => callGlobal('renderBillingPage'),
  'api-tokens': () => {
    mountHtml('');
    if (!window.ApiTokensModule) throw new Error('The API tokens module is not loaded');
    return window.ApiTokensModule.init('main-content');
  },
  'data-export': () => {
    mountHtml(pageHeaderHtml('Data export') + '<div id="data-export-panel"></div>');
    if (!window.DataExportModule) throw new Error('The Data export module is not loaded');
    return window.DataExportModule.render(document.getElementById('data-export-panel'));
  },
  onboarding: () => renderOnboardingPage()
};

// '/transactions?page=2' -> 'transactions'; unknown -> 'dashboard'
function resolvePageFromPath(pathname) {
  const clean = String(pathname || '').split('?')[0].split('#')[0];
  const seg = clean.split('/').filter(Boolean)[0] || 'dashboard';
  return Object.prototype.hasOwnProperty.call(PAGE_RENDERERS, seg) ? seg : 'dashboard';
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function initApp() {
  // Feature modules loaded after this file redeclare `formatCurrency` with a
  // hard-coded UAH default; re-point the global at the canonical version.
  if (typeof window !== 'undefined') {
    window.formatCurrency = fmFormatCurrency;
  }

  consumeOAuthFragment();
  const token = localStorage.getItem('token');
  appState.token = token;

  if (!token) {
    renderLoginPage();
    return;
  }

  try {
    await fetchCurrentUser();
  } catch (error) {
    if (error && error.status === 401) {
      renderLoginPage();
      return;
    }
    console.error('Could not load the current user:', error);
    renderConnectionError(error && error.message);
    return;
  }

  renderAuthenticatedUI();
  replayOfflineQueue();

  await Promise.all([
    fetchAccounts(),
    fetchSupportedBanks(),
    loadBaseCurrencySettings()
  ]);

  navigateTo(resolvePageFromPath(window.location.pathname), { replace: true });
}

// ---------------------------------------------------------------------------
// App shell (header, inline primary nav + "More", drawer)
// ---------------------------------------------------------------------------
function escapeHtmlShell(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function navLinkHtml(item, cls) {
  return `<a href="/${item.page}" class="${cls}" data-page="${item.page}">` +
    `<i class="fas ${item.icon}" aria-hidden="true"></i><span>${item.label}</span></a>`;
}

function navGroupHtml(group, cls, titleCls) {
  return `
    <div class="fm-nav-group">
      <p class="${titleCls}">${group.title}</p>
      <ul>${group.items.map((item) => `<li>${navLinkHtml(item, cls)}</li>`).join('')}</ul>
    </div>
  `;
}

const THEME_LABELS = { system: 'Auto', light: 'Light', dark: 'Dark' };

function themeToggleHtml() {
  const mode = (typeof window !== 'undefined' && window.theme) ? window.theme.getMode() : 'system';
  const label = THEME_LABELS[mode] || 'Theme';
  return `
    <button id="theme-toggle-btn" class="theme-toggle" type="button"
            aria-label="Theme: ${label}. Switch theme" title="Switch theme">
      <span class="theme-toggle-icon icon-moon" aria-hidden="true"><i class="fas fa-moon"></i></span>
      <span class="theme-toggle-icon icon-sun" aria-hidden="true"><i class="fas fa-sun"></i></span>
      <span class="theme-toggle-label" id="theme-toggle-label">${label}</span>
    </button>
  `;
}

function renderAuthenticatedUI() {
  const app = document.getElementById('app');
  const userName = escapeHtmlShell(appState.user && (appState.user.username || appState.user.email) || '');

  const userInitial = escapeHtmlShell((appState.user && (appState.user.username || appState.user.email) || '?').trim().charAt(0) || '?');

  app.innerHTML = `
    <div class="fm-app">
    <aside class="fm-sidebar" aria-label="Sidebar">
      <a href="/" class="fm-brand" id="brand-link" aria-label="Finman home">
        <span class="fm-brand-mark" aria-hidden="true"></span>
        <span><span class="fm-brand-name">Finman</span><span class="fm-brand-tag">Your money, clarified</span></span>
      </a>
      <nav class="fm-nav" aria-label="Primary">
        <ul class="fm-nav-list" id="nav-list">
          ${NAV_PRIMARY.map((item) => `<li>${navLinkHtml(item, 'fm-nav-link')}</li>`).join('')}
        </ul>
        ${NAV_GROUPS.map((g) => navGroupHtml(g, 'fm-nav-link', 'fm-nav-group-title')).join('')}
      </nav>
    </aside>
    <div class="fm-body">
    <header class="header">
      <div class="container header-content">
        <button class="fm-menu-btn" id="mobile-menu-toggle" type="button"
                aria-controls="app-drawer" aria-expanded="false" aria-haspopup="dialog" aria-label="Menu">
          <i class="fas fa-bars" aria-hidden="true"></i><span>Menu</span>
        </button>
        <div class="logo">
          <a href="/" id="logo-link" aria-label="Finman home">Finman</a>
        </div>
        <div class="fm-topbar-context" aria-hidden="true">
          <span class="fm-topbar-greeting">${topbarGreeting(userName)}</span>
          <span class="fm-topbar-date">${topbarDate()}</span>
        </div>
        <div class="fm-topbar-spacer"></div>
        <button class="fm-quick-add" id="quick-add-btn" type="button" title="Add transaction">
          <i class="fas fa-plus" aria-hidden="true"></i><span>Add transaction</span>
        </button>
        <div class="user-info">
          ${themeToggleHtml()}
          <span class="user-chip" title="${userName}">
            <span class="user-avatar" aria-hidden="true">${userInitial}</span>
            <span class="user-name">${userName}</span>
          </span>
          <button id="logout-btn" class="fm-logout" type="button" aria-label="Log out" title="Log out">
            <i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>Log out</span>
          </button>
        </div>
      </div>
    </header>

    <div class="fm-drawer" id="app-drawer" data-open="false">
      <button class="fm-drawer-backdrop" id="drawer-backdrop" type="button" aria-label="Close menu" tabindex="-1"></button>
      <nav class="fm-drawer-panel" id="drawer-panel" role="dialog" aria-modal="true" aria-label="All sections">
        <div class="fm-drawer-head">
          <span class="fm-drawer-title">Finman</span>
          <button class="fm-drawer-close" id="drawer-close" type="button">
            <i class="fas fa-times" aria-hidden="true"></i><span>Close</span>
          </button>
        </div>
        <div class="fm-drawer-body">
          ${navGroupHtml({ title: 'Main', items: NAV_PRIMARY }, 'fm-drawer-link', 'fm-drawer-group-title')}
          ${NAV_GROUPS.map((g) => navGroupHtml(g, 'fm-drawer-link', 'fm-drawer-group-title')).join('')}
        </div>
        <div class="fm-drawer-foot">
          <div class="fm-drawer-user"><i class="fas fa-user-circle" aria-hidden="true"></i><span>${userName}</span></div>
          <button id="drawer-logout-btn" class="btn btn-outline" type="button">
            <i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>Log out</span>
          </button>
        </div>
      </nav>
    </div>

    <main class="main">
      <div class="container" id="main-content">${LOADING_HTML}</div>
    </main>

    <nav class="fm-tabbar" id="app-tabbar" aria-label="Quick navigation">
      <a href="/dashboard" class="fm-nav-link fm-tab" data-page="dashboard"><i class="fas fa-house" aria-hidden="true"></i><span>Home</span></a>
      <a href="/transactions" class="fm-nav-link fm-tab" data-page="transactions"><i class="fas fa-exchange-alt" aria-hidden="true"></i><span>Activity</span></a>
      <button class="fm-tab fm-tab-add" id="tab-add-btn" type="button" aria-label="Add transaction"><i class="fas fa-plus" aria-hidden="true"></i><span>Add</span></button>
      <a href="/budgets" class="fm-nav-link fm-tab" data-page="budgets"><i class="fas fa-piggy-bank" aria-hidden="true"></i><span>Budgets</span></a>
      <button class="fm-tab" id="tab-more-btn" type="button" aria-controls="app-drawer" aria-haspopup="dialog"><i class="fas fa-grip" aria-hidden="true"></i><span>More</span></button>
    </nav>
    </div>
    </div>
  `;

  // Navigation: one delegated handler for header, popover and drawer links.
  const onNavClick = (e) => {
    const link = e.target.closest('[data-page]');
    if (!link || !link.closest('.fm-nav, .fm-drawer, .fm-tabbar')) return;
    e.preventDefault();
    navigateTo(link.dataset.page);
  };
  app.querySelector('.fm-sidebar').addEventListener('click', onNavClick);
  app.querySelector('.header').addEventListener('click', onNavClick);
  document.getElementById('app-drawer').addEventListener('click', onNavClick);
  document.getElementById('app-tabbar').addEventListener('click', onNavClick);

  ['logo-link', 'brand-link'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { e.preventDefault(); navigateTo('dashboard'); });
  });

  // Quick add (top bar on desktop, centre tab on phones)
  ['quick-add-btn', 'tab-add-btn'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', quickAddTransaction);
  });
  const moreTab = document.getElementById('tab-more-btn');
  if (moreTab) moreTab.addEventListener('click', () => { if (isDrawerOpen()) closeDrawer(); else openDrawer(); });

  // "More" popover (legacy inline nav; kept for shells that still render it)
  const more = document.getElementById('nav-more');
  const moreBtn = document.getElementById('nav-more-btn');
  if (more && moreBtn) moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMoreMenu(!more.classList.contains('open'));
  });
  // Document-level listeners survive re-renders of the shell (every login
  // rebuilds it), so they are added once and look the elements up each time.
  if (!appState._shellDocListeners) {
    appState._shellDocListeners = true;
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('nav-more');
      if (menu && menu.classList.contains('open') && !menu.contains(e.target)) setMoreMenu(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const menu = document.getElementById('nav-more');
      if (menu && menu.classList.contains('open')) {
        setMoreMenu(false);
        const btn = document.getElementById('nav-more-btn');
        if (btn) btn.focus();
      }
      if (isDrawerOpen()) closeDrawer();
    });
  }

  // Drawer (mobile / tablet)
  document.getElementById('mobile-menu-toggle').addEventListener('click', () => {
    if (isDrawerOpen()) closeDrawer(); else openDrawer();
  });
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);

  // Log out (header on desktop, drawer footer on mobile)
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('drawer-logout-btn').addEventListener('click', logout);

  // Theme toggle: system -> light -> dark -> …, persisted by theme.js
  const themeBtn = document.getElementById('theme-toggle-btn');
  if (themeBtn && typeof window !== 'undefined' && window.theme) {
    themeBtn.addEventListener('click', () => window.theme.toggle());
    if (!appState._themeUnsub) {
      appState._themeUnsub = window.theme.onChange(updateThemeToggleLabel);
    }
    updateThemeToggleLabel(window.theme.getMode());
  }

  detectIconFont();
}

// Top bar context: a greeting by time of day and today's date (English shell).
function topbarGreeting(name, now = new Date()) {
  const h = now.getHours();
  const word = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${word}, ${name}` : word;
}
function topbarDate(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  } catch (e) {
    return now.toDateString();
  }
}

// The "+" in the shell: open the transaction form wherever the user is.
function quickAddTransaction() {
  if (typeof showAddTransactionModal === 'function') {
    showAddTransactionModal('expense');
    return;
  }
  navigateTo('transactions');
}

function setMoreMenu(open) {
  const more = document.getElementById('nav-more');
  const btn = document.getElementById('nav-more-btn');
  if (!more || !btn) return;
  more.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function isDrawerOpen() {
  const drawer = document.getElementById('app-drawer');
  return !!drawer && drawer.getAttribute('data-open') === 'true';
}

function openDrawer() {
  const drawer = document.getElementById('app-drawer');
  const toggle = document.getElementById('mobile-menu-toggle');
  if (!drawer) return;
  drawer.setAttribute('data-open', 'true');
  document.body.classList.add('fm-drawer-open');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  const panel = document.getElementById('drawer-panel');
  if (window.a11y && typeof window.a11y.trapFocus === 'function') {
    appState._drawerRelease = window.a11y.trapFocus(panel, { onEscape: closeDrawer });
  } else {
    const first = panel.querySelector('button, a');
    if (first) first.focus();
  }
}

function closeDrawer() {
  const drawer = document.getElementById('app-drawer');
  const toggle = document.getElementById('mobile-menu-toggle');
  if (!drawer) return;
  drawer.setAttribute('data-open', 'false');
  document.body.classList.remove('fm-drawer-open');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (typeof appState._drawerRelease === 'function') {
    appState._drawerRelease();
    appState._drawerRelease = null;
  }
}

function updateThemeToggleLabel(mode) {
  const label = THEME_LABELS[mode] || 'Theme';
  const el = document.getElementById('theme-toggle-label');
  const btn = document.getElementById('theme-toggle-btn');
  if (el) el.textContent = label;
  if (btn) btn.setAttribute('aria-label', `Theme: ${label}. Switch theme`);
}

// Font Awesome is self-hosted, but if it still fails to load we flip
// html.no-icons so text fallbacks replace icon-only glyphs in the shell.
function detectIconFont() {
  if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.check !== 'function') return;
  const apply = () => {
    let ok = true;
    try {
      ok = document.fonts.check('900 1em "Font Awesome 6 Free"');
    } catch (e) { ok = true; }
    document.documentElement.classList.toggle('no-icons', !ok);
  };
  if (document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    document.fonts.ready.then(apply).catch(() => {});
  } else {
    apply();
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function navigateTo(page, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(PAGE_RENDERERS, page)) page = 'dashboard';
  appState.currentPage = page;

  // The family page used to wipe #app; rebuild the shell if it is gone.
  if (!document.getElementById('main-content') && appState.isAuthenticated) {
    renderAuthenticatedUI();
  }

  document.querySelectorAll('.fm-nav-link[data-page], .fm-drawer-link[data-page]').forEach((link) => {
    const on = link.dataset.page === page;
    link.classList.toggle('active', on);
    if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });

  const url = `/${page}`;
  if (options.replace) {
    window.history.replaceState({}, '', url);
  } else if (window.location.pathname !== url) {
    window.history.pushState({}, '', url);
  }

  const mainContent = mountHtml(LOADING_HTML);
  closeDrawer();
  setMoreMenu(false);
  if (!mainContent) return;

  const title = findNavLabel(page);
  document.title = title ? `${title} · Finman` : 'Finman';

  try {
    const result = PAGE_RENDERERS[page]();
    if (result && typeof result.catch === 'function') {
      result.catch((error) => reportPageError(page, error));
    }
  } catch (error) {
    reportPageError(page, error);
  }
}

function findNavLabel(page) {
  const all = [...NAV_PRIMARY, ...NAV_GROUPS.flatMap((g) => g.items)];
  const hit = all.find((i) => i.page === page);
  if (hit) return hit.label;
  return page === 'onboarding' ? 'Getting started' : '';
}

function reportPageError(page, error) {
  console.error(`Failed to render "${page}":`, error);
  const message = (error && error.message) || 'Unknown error';
  const mainContent = document.getElementById('main-content');
  if (mainContent && mainContent.querySelector('.loading')) {
    mainContent.innerHTML = `
      ${pageHeaderHtml(findNavLabel(page) || 'Page')}
      <div class="card">
        <p class="fm-error-detail">This page could not be loaded: ${escapeHtmlShell(message)}</p>
        <div class="fm-error-actions">
          <button class="btn btn-primary" id="page-retry-btn" type="button">Try again</button>
          <button class="btn btn-outline" id="page-home-btn" type="button">Back to dashboard</button>
        </div>
      </div>
    `;
    const retry = document.getElementById('page-retry-btn');
    const home = document.getElementById('page-home-btn');
    if (retry) retry.addEventListener('click', () => navigateTo(page, { replace: true }));
    if (home) home.addEventListener('click', () => navigateTo('dashboard'));
  }
  showNotification(`Could not load ${findNavLabel(page) || page}: ${message}`, 'error');
}

// Global entry to the AI CFO — used by the dashboard hero and other CTAs.
if (typeof window !== 'undefined') {
  window.AIAssistant = {
    open() { navigateTo('ai'); },
    toggle() { navigateTo('ai'); }
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

// Build an Error from a failed response, preferring the server's message.
async function readApiError(response, fallback) {
  let message = '';
  try {
    const data = await response.clone().json();
    if (data) {
      if (typeof data.message === 'string') message = data.message;
      else if (data.error && typeof data.error.message === 'string') message = data.error.message;
      else if (typeof data.error === 'string') message = data.error;
    }
  } catch (e) {
    // body was not JSON
  }
  if (!message) message = `${fallback || 'Request failed'} (HTTP ${response.status})`;
  const err = new Error(message);
  err.status = response.status;
  return err;
}

async function fetchWithAuth(url, options = {}) {
  const token = localStorage.getItem('token');

  if (!token) {
    const err = new Error('Not signed in');
    err.status = 401;
    throw err;
  }

  // A FormData body needs the browser's multipart boundary: never force JSON on it.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const defaultHeaders = { 'Authorization': `Bearer ${token}` };
  if (!isFormData) defaultHeaders['Content-Type'] = 'application/json';
  const defaultOptions = { headers: defaultHeaders };

  const mergedOptions = { ...defaultOptions, ...options };

  if (options.headers) {
    mergedOptions.headers = { ...defaultOptions.headers, ...options.headers };
    if (isFormData) {
      Object.keys(mergedOptions.headers).forEach((k) => {
        if (k.toLowerCase() === 'content-type') delete mergedOptions.headers[k];
      });
    }
  }

  const response = await fetch(url, mergedOptions);

  if (response.status === 401) {
    // Token rejected: drop the session state (cached base currency, filters…)
    // and go back to the login page.
    logout();
    const err = new Error('Your session has expired. Please sign in again.');
    err.status = 401;
    throw err;
  }

  return response;
}

async function fetchCurrentUser() {
  try {
    const response = await fetchWithAuth('/api/auth/me');

    if (!response.ok) {
      throw await readApiError(response, 'Could not load your profile');
    }

    const data = await response.json();
    appState.isAuthenticated = true;
    appState.user = data;

    return data;
  } catch (error) {
    appState.isAuthenticated = false;
    appState.user = null;
    throw error;
  }
}

// {own, shared, all} | array | null -> flat array
function normalizeAccounts(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.all)) return data.all;
    const own = Array.isArray(data.own) ? data.own : [];
    const shared = Array.isArray(data.shared) ? data.shared : [];
    return [...own, ...shared];
  }
  return [];
}

async function fetchAccounts() {
  try {
    const response = await fetchWithAuth('/api/accounts');

    if (!response.ok) {
      throw await readApiError(response, 'Could not load accounts');
    }

    const data = await response.json();
    const all = normalizeAccounts(data);
    appState.accounts = all;
    appState.accountsByScope = {
      own: Array.isArray(data && data.own) ? data.own : all,
      shared: Array.isArray(data && data.shared) ? data.shared : [],
      all
    };

    return all;
  } catch (error) {
    if (error && error.status === 401) return [];
    console.error('Could not load accounts:', error);
    showNotification(error.message || 'Could not load accounts', 'error');
    return [];
  }
}

async function fetchSupportedBanks() {
  try {
    const response = await fetchWithAuth('/api/bank-api/supported-banks');

    if (!response.ok) {
      throw await readApiError(response, 'Could not load the list of supported banks');
    }

    const data = await response.json();
    appState.supportedBanks = data;

    return data;
  } catch (error) {
    if (!(error && error.status === 401)) console.error('Could not load supported banks:', error);
    return [];
  }
}

// Base currency for formatCurrency; falls back to CAD silently. (Named to avoid
// the global `fetchCurrencySettings` that currency.js declares later.)
async function loadBaseCurrencySettings() {
  try {
    const response = await fetchWithAuth('/api/currency/settings');
    if (!response.ok) return null;
    const data = await response.json();
    const settings = data && data.settings ? data.settings : data;
    if (settings && typeof settings.base_currency === 'string' && settings.base_currency) {
      appState.baseCurrency = settings.base_currency.toUpperCase();
      if (typeof UI !== 'undefined' && UI && typeof UI.setBaseCurrency === 'function') {
        UI.setBaseCurrency(appState.baseCurrency);
      }
    }
    appState.currencySettings = settings || null;
    return settings;
  } catch (error) {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Google sign-in (wave3/auth): button only when the server has it configured;
// the OAuth callback returns the token in the URL fragment so it never reaches
// the query string or server access logs.
// ---------------------------------------------------------------------------
async function revealGoogleSignIn() {
  try {
    const r = await fetch('/api/auth/google/status');
    if (!r.ok) return;
    const { enabled } = await r.json();
    const el = document.getElementById('auth-social');
    if (el && enabled) el.hidden = false;
  } catch (_) { /* keep hidden */ }
}

function consumeOAuthFragment() {
  if (typeof window === 'undefined') return false;
  const h = window.location.hash || '';
  const m = h.match(/[#&]token=([^&]+)/);
  if (m) {
    localStorage.setItem('token', decodeURIComponent(m[1]));
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  }
  const q = new URLSearchParams(window.location.search);
  const err = q.get('auth_error');
  if (err) {
    history.replaceState(null, '', window.location.pathname);
    console.warn('Google sign-in failed:', err);
    const msg = err === 'email_exists'
      ? 'An account with this email already exists. Sign in with your password.'
      : 'Google sign-in failed. Try again or use your password.';
    // Login page renders after this call; show the message once it exists.
    setTimeout(() => { try { showNotification(msg, 'error'); } catch (_) {} }, 0);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Login / register
// ---------------------------------------------------------------------------
function renderLoginPage() {
  const app = document.getElementById('app');
  closeDrawer();
  // /reset-password?token=… (link from the "forgot password" email)
  const resetToken = window.location.pathname === '/reset-password'
    ? (new URLSearchParams(window.location.search).get('token') || '')
    : '';

  app.innerHTML = `
    <div class="auth-container">
      <aside class="auth-aside" aria-label="About Finman">
        <a href="/" class="fm-brand" aria-label="Finman home">
          <span class="fm-brand-mark" aria-hidden="true"></span>
          <span><span class="fm-brand-name">Finman</span><span class="fm-brand-tag">Personal finance, clarified</span></span>
        </a>
        <div class="auth-pitch">
          <h2>Every account, every currency, one clear picture.</h2>
          <p>Budgets, goals, debts and investments in one place, with an AI CFO that only ever reasons over your own numbers.</p>
          <ul class="auth-points">
            <li><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i><span><strong>AI CFO</strong><small>Weekly briefs, what-if plans and categorisation, grounded in your data.</small></span></li>
            <li><i class="fas fa-building-columns" aria-hidden="true"></i><span><strong>Banks and imports</strong><small>CSV and OFX from 10 banks, Monobank sync, receipts by photo.</small></span></li>
            <li><i class="fas fa-shield-halved" aria-hidden="true"></i><span><strong>Yours to keep</strong><small>Self-hosted, encrypted bank tokens, one-click export.</small></span></li>
          </ul>
        </div>
        <p class="auth-aside-foot"><i class="fas fa-lock" aria-hidden="true"></i> Your data is never sold.</p>
      </aside>
      <div class="auth-main">
      <div class="auth-card">
        <div class="auth-header">
          <h1>Welcome back</h1>
          <p>Sign in to your Finman, or create an account.</p>
        </div>

        <div class="auth-social" id="auth-social" hidden>
          <a class="btn-google" href="/api/auth/google">
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
              <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
            </svg>
            <span>Continue with Google</span>
          </a>
          <div class="auth-divider"><span>or</span></div>
        </div>

        <div class="auth-tabs" role="tablist">
          <button class="auth-tab active" data-tab="login" type="button" role="tab" aria-selected="true">Sign in</button>
          <button class="auth-tab" data-tab="register" type="button" role="tab" aria-selected="false">Create account</button>
        </div>

        <div class="auth-form-container">
          <form id="login-form" class="auth-form">
            <div class="form-group">
              <label for="login-username" class="form-label">Username</label>
              <input type="text" id="login-username" class="form-control" autocomplete="username" required>
            </div>

            <div class="form-group">
              <label for="login-password" class="form-label">Password</label>
              <input type="password" id="login-password" class="form-control" autocomplete="current-password" required>
            </div>

            <div id="login-error" class="auth-error" role="alert"></div>

            <button type="submit" class="btn btn-primary w-100">Sign in</button>
            <p class="auth-links"><button type="button" class="auth-link" id="forgot-password-link">Forgot your password?</button></p>
          </form>

          <form id="forgot-form" class="auth-form hidden">
            <p class="auth-form-intro">Enter the email of your account and we will send a link to choose a new password.</p>
            <div class="form-group">
              <label for="forgot-email" class="form-label">Email</label>
              <input type="email" id="forgot-email" class="form-control" autocomplete="email" required>
            </div>
            <div id="forgot-error" class="auth-error" role="alert"></div>
            <div id="forgot-success" class="auth-success" role="status"></div>
            <button type="submit" class="btn btn-primary w-100">Send reset link</button>
            <p class="auth-links"><button type="button" class="auth-link" id="forgot-back-link">Back to sign in</button></p>
          </form>

          <form id="reset-form" class="auth-form hidden">
            <p class="auth-form-intro">Choose a new password for your account.</p>
            <input type="hidden" id="reset-token" value="${escapeHtmlShell(resetToken)}">
            <div class="form-group">
              <label for="reset-password" class="form-label">New password</label>
              <input type="password" id="reset-password" class="form-control" autocomplete="new-password" minlength="6" required>
            </div>
            <div class="form-group">
              <label for="reset-confirm-password" class="form-label">Confirm new password</label>
              <input type="password" id="reset-confirm-password" class="form-control" autocomplete="new-password" minlength="6" required>
            </div>
            <div id="reset-error" class="auth-error" role="alert"></div>
            <button type="submit" class="btn btn-primary w-100">Change password</button>
            <p class="auth-links"><button type="button" class="auth-link" id="reset-back-link">Back to sign in</button></p>
          </form>

          <form id="register-form" class="auth-form hidden">
            <div class="form-group">
              <label for="register-username" class="form-label">Username</label>
              <input type="text" id="register-username" class="form-control" autocomplete="username" required>
            </div>

            <div class="form-group">
              <label for="register-email" class="form-label">Email</label>
              <input type="email" id="register-email" class="form-control" autocomplete="email" required>
            </div>

            <div class="form-group">
              <label for="register-fullname" class="form-label">Full name</label>
              <input type="text" id="register-fullname" class="form-control" autocomplete="name">
            </div>

            <div class="form-group">
              <label for="register-password" class="form-label">Password</label>
              <input type="password" id="register-password" class="form-control" autocomplete="new-password" required>
            </div>

            <div class="form-group">
              <label for="register-confirm-password" class="form-label">Confirm password</label>
              <input type="password" id="register-confirm-password" class="form-control" autocomplete="new-password" required>
            </div>

            <div id="register-error" class="auth-error" role="alert"></div>

            <button type="submit" class="btn btn-primary w-100">Create account</button>
          </form>
        </div>

        <p class="auth-footer">
          <i class="fas fa-lock" aria-hidden="true"></i>
          <span>Bank connections are encrypted · your data is never sold</span>
        </p>
      </div>
      </div>
    </div>
  `;

  const authTabs = document.querySelectorAll('.auth-tab');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  authTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;

      authTabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      if (tabName === 'login') {
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
      } else {
        loginForm.classList.add('hidden');
        registerForm.classList.remove('hidden');
      }
    });
  });

  loginForm.addEventListener('submit', withBusyForm(handleLogin));
  registerForm.addEventListener('submit', withBusyForm(handleRegister));

  // Forgot / reset password: the two extra forms share the card with sign-in.
  const forgotForm = document.getElementById('forgot-form');
  const resetForm = document.getElementById('reset-form');
  const authTabsEl = document.querySelector('.auth-tabs');
  const showAuthForm = (which) => {
    [loginForm, registerForm, forgotForm, resetForm].forEach((f) => f.classList.add('hidden'));
    which.classList.remove('hidden');
    if (authTabsEl) authTabsEl.classList.toggle('hidden', which !== loginForm && which !== registerForm);
    const first = which.querySelector('input:not([type="hidden"])');
    if (first) first.focus();
  };
  document.getElementById('forgot-password-link').addEventListener('click', () => showAuthForm(forgotForm));
  document.getElementById('forgot-back-link').addEventListener('click', () => showAuthForm(loginForm));
  document.getElementById('reset-back-link').addEventListener('click', () => {
    history.replaceState(null, '', '/');
    showAuthForm(loginForm);
  });
  forgotForm.addEventListener('submit', withBusyForm(handleForgotPassword));
  resetForm.addEventListener('submit', withBusyForm(handleResetPassword));
  if (resetToken) showAuthForm(resetForm);

  revealGoogleSignIn();
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim();
  const errorElement = document.getElementById('forgot-error');
  const okElement = document.getElementById('forgot-success');
  errorElement.textContent = '';
  okElement.textContent = '';
  if (!email) {
    errorElement.textContent = 'Enter the email of your account';
    return;
  }
  try {
    const response = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      errorElement.textContent = data.message || 'Could not send the reset link';
      return;
    }
    okElement.textContent = data.emailConfigured === false
      ? 'This server has no email provider configured. Ask the person who runs it to reset your password.'
      : (data.message || 'If an account exists for that email, a reset link is on its way.');
  } catch (error) {
    errorElement.textContent = 'Could not reach the server. Try again.';
  }
}

async function handleResetPassword(e) {
  e.preventDefault();
  const token = document.getElementById('reset-token').value;
  const password = document.getElementById('reset-password').value;
  const confirm = document.getElementById('reset-confirm-password').value;
  const errorElement = document.getElementById('reset-error');
  errorElement.textContent = '';
  if (password.length < 6) {
    errorElement.textContent = 'Password must be at least 6 characters';
    return;
  }
  if (password !== confirm) {
    errorElement.textContent = 'The passwords do not match';
    return;
  }
  try {
    const response = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      errorElement.textContent = data.message || 'This reset link is invalid or has expired';
      return;
    }
    history.replaceState(null, '', '/');
    renderLoginPage();
    showNotification(data.message || 'Your password has been changed. Sign in with the new one.', 'success');
  } catch (error) {
    errorElement.textContent = 'Could not reach the server. Try again.';
  }
}

// Shown when the token exists but the server could not be reached (network
// error, 429, 5xx). Keeps the session instead of bouncing to the login page.
function renderConnectionError(message) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <h1>Finman</h1>
          <p>We could not reach the server.</p>
        </div>
        <p class="fm-error-detail">${escapeHtmlShell(message || 'Please check your connection and try again.')}</p>
        <div class="fm-error-actions">
          <button class="btn btn-primary" id="retry-btn" type="button">Try again</button>
          <button class="btn btn-outline" id="error-logout-btn" type="button">Sign out</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('retry-btn').addEventListener('click', () => initApp());
  document.getElementById('error-logout-btn').addEventListener('click', logout);
}

// Submit handler wrapper: the form's submit button stays disabled while the
// request is in flight, so a double click cannot send it twice.
function withBusyForm(handler) {
  return (e) => {
    e.preventDefault();
    const form = e.currentTarget || e.target;
    if (typeof UI !== 'undefined' && UI && typeof UI.busy === 'function') {
      return UI.busy(form, () => handler(e)).catch((err) => console.error(err));
    }
    return handler(e);
  };
}

async function handleLogin(e) {
  e.preventDefault();

  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const errorElement = document.getElementById('login-error');

  if (!username || !password) {
    errorElement.textContent = 'Please fill in all fields';
    return;
  }

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });

    let data = null;
    try { data = await response.json(); } catch (err) { data = null; }

    if (!response.ok) {
      errorElement.textContent = (data && data.message) || `Sign-in failed (HTTP ${response.status})`;
      return;
    }

    localStorage.setItem('token', data.token);

    appState.isAuthenticated = true;
    appState.user = data.user;

    initApp();
  } catch (error) {
    console.error('Sign-in error:', error);
    errorElement.textContent = 'Could not sign in. Please check your connection and try again.';
  }
}

async function handleRegister(e) {
  e.preventDefault();

  const username = document.getElementById('register-username').value;
  const email = document.getElementById('register-email').value;
  const fullName = document.getElementById('register-fullname').value;
  const password = document.getElementById('register-password').value;
  const confirmPassword = document.getElementById('register-confirm-password').value;
  const errorElement = document.getElementById('register-error');

  if (!username || !email || !password || !confirmPassword) {
    errorElement.textContent = 'Please fill in all required fields';
    return;
  }

  if (password !== confirmPassword) {
    errorElement.textContent = 'Passwords do not match';
    return;
  }

  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, email, password, fullName })
    });

    let data = null;
    try { data = await response.json(); } catch (err) { data = null; }

    if (!response.ok) {
      errorElement.textContent = (data && data.message) || `Registration failed (HTTP ${response.status})`;
      return;
    }

    localStorage.setItem('token', data.token);

    appState.isAuthenticated = true;
    appState.user = data.user;

    initApp();
  } catch (error) {
    console.error('Registration error:', error);
    errorElement.textContent = 'Could not create the account. Please check your connection and try again.';
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function renderDashboard() {
  const mainContent = document.getElementById('main-content');

  const recentTransactions = await fetchTransactions({ limit: 5 });
  const statsData = (await fetchTransactionStats()) || {};

  const accountsHtml = appState.accounts.map((account) => `
    <div class="account-summary">
      <div class="account-info">
        <div class="account-icon">
          <i class="fas ${getAccountIcon(account.account_type)}"></i>
        </div>
        <div class="account-details">
          <h3 class="account-name">${escapeHtmlShell(account.name)}</h3>
          <p class="account-number">${escapeHtmlShell(account.account_number || '')}</p>
        </div>
      </div>
      <div class="account-balance">${escapeHtmlShell(fmFormatCurrency(account.balance, account.currency))}</div>
    </div>
  `).join('') || '<p>You have no accounts yet. <a href="#" class="add-account-link">Add an account</a></p>';

  const transactionsHtml = recentTransactions.length > 0
    ? recentTransactions.map((transaction) => `
      <div class="transaction-item">
        <div class="transaction-info">
          <div class="transaction-date">${escapeHtmlShell(formatDate(transaction.date))}</div>
          <div class="transaction-description">${escapeHtmlShell(transaction.description || '')}</div>
          <div class="transaction-category">${escapeHtmlShell(transaction.category || '')}</div>
        </div>
        <div class="transaction-amount ${transaction.type === 'income' ? 'income' : 'expense'}">
          ${escapeHtmlShell(fmFormatCurrency(transaction.amount, typeof transactionCurrency === 'function' ? transactionCurrency(transaction) : transaction.currency))}
        </div>
      </div>
    `).join('')
    : '<p>You have no transactions yet. <a href="#" class="add-transaction-link">Add a transaction</a></p>';

  // ---- Signature hero ----
  // Balance: the server's figure converted into the base currency; without it,
  // one line per account currency (never a cross-currency sum).
  const hasTotal = statsData.totalBalance != null && Number.isFinite(Number(statsData.totalBalance));
  const balanceCurrency = statsData.balanceCurrency || appState.baseCurrency;
  const totalBalance = hasTotal ? Number(statsData.totalBalance) : 0;
  const balanceText = hasTotal
    ? fmFormatCurrency(totalBalance, balanceCurrency)
    : formatTotals(statsData.balanceByCurrency, balanceCurrency);
  // Cash flow per currency (opening balances and transfers excluded).
  const flowCurrency = statsData.currency || appState.baseCurrency;
  const monthIn = Number(statsData.monthlyIncome) || 0;
  const monthOut = Number(statsData.monthlyExpense) || 0;
  const netFlow = monthIn - monthOut;
  const flowUp = netFlow >= 0;
  const incomeText = statsData.incomeByCurrency
    ? formatTotals(statsData.incomeByCurrency, flowCurrency) : fmFormatCurrency(monthIn, flowCurrency);
  const expenseText = statsData.expenseByCurrency
    ? formatTotals(statsData.expenseByCurrency, flowCurrency) : fmFormatCurrency(monthOut, flowCurrency);
  const netText = statsData.mixedCurrencies
    ? formatTotals(netByCurrency(statsData.incomeByCurrency, statsData.expenseByCurrency), flowCurrency)
    : fmFormatCurrency(Math.abs(netFlow), flowCurrency);
  const aiInsight = (typeof getDashboardInsight === 'function')
    ? getDashboardInsight(statsData)
    : (flowUp
        ? 'You are spending less than you earn this month, so your balance is growing.'
        : 'Spending exceeded income this month. Check the categories to get back on track.');
  const symbol = currencySymbol(balanceCurrency);

  const heroHtml = `
    <section class="fm-hero" aria-label="Your finances">
      <div class="fm-hero-grid">
        <div class="fm-hero-main">
          <span class="fm-hero-eyebrow"><i class="fas fa-wand-magic-sparkles"></i> Your money, clarified</span>
          <h1 class="fm-hero-title">Total balance</h1>
          ${hasTotal ? `<div class="fm-hero-figure" id="hero-networth"
               data-countup="${totalBalance}" data-currency="${escapeHtmlShell(symbol)}">
            <span class="fm-hero-currency">${escapeHtmlShell(symbol)}</span><span class="fm-hero-amount">${formatPlainNumber(totalBalance)}</span>
          </div>` : `<div class="fm-hero-figure"><span class="fm-hero-amount">${escapeHtmlShell(balanceText)}</span></div>`}
          <span class="fm-hero-delta ${flowUp ? 'up' : 'down'}">
            <i class="fas fa-arrow-${flowUp ? 'up' : 'down'}"></i>
            ${escapeHtmlShell(netText)} this month
          </span>
          <div class="fm-hero-cashflow">
            <div class="fm-cashflow-item">
              <span class="fm-cashflow-label">Income</span>
              <span class="fm-cashflow-value in">${escapeHtmlShell(incomeText)}</span>
            </div>
            <div class="fm-cashflow-item">
              <span class="fm-cashflow-label">Expenses</span>
              <span class="fm-cashflow-value out">${escapeHtmlShell(expenseText)}</span>
            </div>
          </div>
        </div>
        <aside class="fm-insight-card" aria-label="AI insight">
          <span class="fm-insight-label"><span class="fm-insight-dot"></span> AI CFO</span>
          <p class="fm-insight-text">${aiInsight}</p>
          <div class="fm-insight-foot">
            <button class="btn btn-sm" id="hero-ai-more" type="button">Ask the AI CFO</button>
          </div>
        </aside>
      </div>
    </section>
  `;

  mainContent.innerHTML = `
    ${heroHtml}

    <div class="dashboard-summary">
      <div class="summary-card income">
        <div class="summary-icon">
          <i class="fas fa-arrow-down"></i>
        </div>
        <div class="summary-data">
          <h3>Income this month</h3>
          <div class="summary-amount">${escapeHtmlShell(incomeText)}</div>
        </div>
      </div>

      <div class="summary-card expense">
        <div class="summary-icon">
          <i class="fas fa-arrow-up"></i>
        </div>
        <div class="summary-data">
          <h3>Expenses this month</h3>
          <div class="summary-amount">${escapeHtmlShell(expenseText)}</div>
        </div>
      </div>

      <div class="summary-card balance">
        <div class="summary-icon">
          <i class="fas fa-wallet"></i>
        </div>
        <div class="summary-data">
          <h3>Total balance</h3>
          <div class="summary-amount">${escapeHtmlShell(balanceText)}</div>
        </div>
      </div>
    </div>

    <div class="dashboard-content">
      <div class="dashboard-section">
        <div class="section-header">
          <h2>Your accounts</h2>
          <button id="add-account-btn" class="btn btn-sm btn-primary">
            <i class="fas fa-plus"></i> Add account
          </button>
        </div>

        <div class="accounts-list">
          ${accountsHtml}
        </div>
      </div>

      <div class="dashboard-section">
        <div class="section-header">
          <h2>Recent transactions</h2>
          <button id="add-transaction-btn" class="btn btn-sm btn-primary">
            <i class="fas fa-plus"></i> Add transaction
          </button>
        </div>

        <div class="transactions-list">
          ${transactionsHtml}
        </div>

        <div class="section-footer">
          <a href="#" class="btn btn-sm btn-outline" id="view-all-transactions">
            View all transactions
          </a>
        </div>
      </div>
    </div>

    <div class="dashboard-charts">
      <div class="chart-container">
        <h2>Income and expenses</h2>
        <canvas id="income-expense-chart"></canvas>
      </div>

      <div class="chart-container">
        <h2>Expenses by category</h2>
        <canvas id="expense-categories-chart"></canvas>
      </div>
    </div>
  `;

  if (typeof initCharts === 'function') {
    try { initCharts(statsData); } catch (error) { console.error('Charts failed to render:', error); }
  }

  animateHeroNetWorth();

  const heroAiBtn = document.getElementById('hero-ai-more');
  if (heroAiBtn) {
    heroAiBtn.addEventListener('click', () => {
      if (typeof window !== 'undefined' && window.AIAssistant && typeof window.AIAssistant.open === 'function') {
        window.AIAssistant.open();
      } else if (typeof window !== 'undefined' && typeof window.toggleAIPanel === 'function') {
        window.toggleAIPanel();
      }
    });
  }

  document.getElementById('add-account-btn').addEventListener('click', () => {
    showAddAccountModal();
  });

  document.getElementById('add-transaction-btn').addEventListener('click', () => {
    showAddTransactionModal();
  });

  document.getElementById('view-all-transactions').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('transactions');
  });

  document.querySelectorAll('.add-account-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showAddAccountModal();
    });
  });

  document.querySelectorAll('.add-transaction-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showAddTransactionModal();
    });
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
async function renderAccountsPage() {
  const mainContent = document.getElementById('main-content');

  await fetchAccounts();

  mainContent.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Accounts</h1>
      <button id="add-account-btn" class="btn btn-primary">
        <i class="fas fa-plus"></i> Add account
      </button>
    </div>

    <div class="accounts-container">
      <div id="accounts-list" class="card-grid">
        ${appState.accounts.length > 0 ? renderAccountsList(appState.accounts) : `
          <div class="empty-state">
            <div class="empty-state-icon">
              <i class="fas fa-wallet"></i>
            </div>
            <h2>No accounts yet</h2>
            <p>Add your first account to start tracking your money</p>
            <button id="empty-add-account-btn" class="btn btn-primary">
              <i class="fas fa-plus"></i> Add account
            </button>
          </div>
        `}
      </div>
    </div>
  `;

  document.getElementById('add-account-btn').addEventListener('click', () => {
    showAddAccountModal();
  });

  const emptyAddAccountBtn = document.getElementById('empty-add-account-btn');
  if (emptyAddAccountBtn) {
    emptyAddAccountBtn.addEventListener('click', () => {
      showAddAccountModal();
    });
  }

  document.querySelectorAll('[data-account-action]').forEach((button) => {
    button.addEventListener('click', handleAccountAction);
  });
}

function renderAccountsList(accounts) {
  return accounts.map((account) => `
    <div class="account-card card" data-account-id="${escapeHtmlShell(account.id)}">
      <div class="account-header">
        <div class="account-icon">
          <i class="fas ${getAccountIcon(account.account_type)}"></i>
        </div>
        <div class="account-details">
          <h3 class="account-name">${escapeHtmlShell(account.name)}</h3>
          <p class="account-number">${escapeHtmlShell(account.account_number || 'No account number')}</p>
        </div>
      </div>

      <div class="account-balance">
        ${escapeHtmlShell(fmFormatCurrency(account.balance, account.currency))}
      </div>

      <div class="account-info">
        <p class="account-bank">${escapeHtmlShell(account.bank_name || 'Personal account')}</p>
        <p class="account-type">${getAccountTypeName(account.account_type)}</p>
      </div>

      <div class="account-actions">
        <button class="btn btn-sm btn-outline" data-account-action="view" data-account-id="${escapeHtmlShell(account.id)}">
          <i class="fas fa-eye"></i> Details
        </button>
        <button class="btn btn-sm btn-outline" data-account-action="edit" data-account-id="${escapeHtmlShell(account.id)}">
          <i class="fas fa-edit"></i> Edit
        </button>
        <button class="btn btn-sm btn-danger" data-account-action="delete" data-account-id="${escapeHtmlShell(account.id)}">
          <i class="fas fa-trash"></i> Delete
        </button>
      </div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
async function renderTransactionsPage() {
  const mainContent = document.getElementById('main-content');

  const transactions = await fetchTransactions(appState.filters);
  const categories = await fetchCategories();

  mainContent.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Transactions</h1>
      <button id="add-transaction-btn" class="btn btn-primary">
        <i class="fas fa-plus"></i> Add transaction
      </button>
    </div>

    <div class="filters-container card">
      <div class="filters-header">
        <h2>Filters</h2>
        <button id="toggle-filters-btn" class="btn btn-sm btn-outline">
          <i class="fas fa-filter"></i> Show filters
        </button>
      </div>

      <div id="filters-form" class="filters-form hidden">
        <div class="filters-row">
          <div class="form-group">
            <label for="filter-date-start" class="form-label">From</label>
            <input type="date" id="filter-date-start" class="form-control" value="${escapeHtmlShell(appState.filters.startDate || '')}">
          </div>

          <div class="form-group">
            <label for="filter-date-end" class="form-label">To</label>
            <input type="date" id="filter-date-end" class="form-control" value="${escapeHtmlShell(appState.filters.endDate || '')}">
          </div>

          <div class="form-group">
            <label for="filter-account" class="form-label">Account</label>
            <select id="filter-account" class="form-control">
              <option value="">All accounts</option>
              ${appState.accounts.map((account) => `
                <option value="${escapeHtmlShell(account.id)}" ${appState.filters.accountId == account.id ? 'selected' : ''}>
                  ${escapeHtmlShell(account.name)}
                </option>
              `).join('')}
            </select>
          </div>
        </div>

        <div class="filters-row">
          <div class="form-group">
            <label for="filter-category" class="form-label">Category</label>
            <select id="filter-category" class="form-control">
              <option value="">All categories</option>
              ${categories.map((category) => `
                <option value="${escapeHtmlShell(category)}" ${appState.filters.category === category ? 'selected' : ''}>
                  ${escapeHtmlShell(category)}
                </option>
              `).join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="filter-type" class="form-label">Type</label>
            <select id="filter-type" class="form-control">
              <option value="">All types</option>
              <option value="income" ${appState.filters.type === 'income' ? 'selected' : ''}>Income</option>
              <option value="expense" ${appState.filters.type === 'expense' ? 'selected' : ''}>Expenses</option>
            </select>
          </div>

          <div class="form-group">
            <label for="filter-search" class="form-label">Search</label>
            <input type="text" id="filter-search" class="form-control" placeholder="Search by description" value="${escapeHtmlShell(appState.filters.search || '')}">
          </div>
        </div>

        <div class="filters-actions">
          <button id="apply-filters-btn" class="btn btn-primary">Apply</button>
          <button id="reset-filters-btn" class="btn btn-outline">Reset</button>
        </div>
      </div>
    </div>

    <div class="transactions-container card">
      <div class="transactions-header">
        <div class="transactions-summary">
          <span>Transactions found: <strong id="transactions-count">${transactions.length}</strong></span>
        </div>
        <div class="transactions-actions">
          <button id="import-transactions-btn" class="btn btn-sm btn-outline">
            <i class="fas fa-file-import"></i> Import CSV
          </button>
        </div>
      </div>

      <div class="table-container">
        <table class="table transactions-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Category</th>
              <th>Account</th>
              <th class="text-right">Amount</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="transactions-list">
            ${transactions.length > 0 ? renderTransactionsList(transactions) : `
              <tr>
                <td colspan="6" class="text-center">
                  <div class="empty-state-mini">
                    <p>No transactions found</p>
                  </div>
                </td>
              </tr>
            `}
          </tbody>
        </table>
      </div>

      <div class="pagination-container" id="pagination-container">
        ${renderPagination(appState.filters.page)}
      </div>
    </div>
  `;

  document.getElementById('add-transaction-btn').addEventListener('click', () => {
    showAddTransactionModal();
  });

  document.getElementById('toggle-filters-btn').addEventListener('click', toggleFilters);
  document.getElementById('apply-filters-btn').addEventListener('click', applyTransactionFilters);
  document.getElementById('reset-filters-btn').addEventListener('click', resetTransactionFilters);
  document.getElementById('import-transactions-btn').addEventListener('click', showImportTransactionsModal);

  document.querySelectorAll('.pagination-link').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (button.classList.contains('disabled')) return;

      const page = parseInt(button.dataset.page);
      appState.filters.page = page;
      renderTransactionsPage();
    });
  });

  document.querySelectorAll('[data-transaction-action]').forEach((button) => {
    button.addEventListener('click', handleTransactionAction);
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function renderSettingsPage() {
  const mainContent = document.getElementById('main-content');
  const user = appState.user || {};

  mainContent.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Settings</h1>
    </div>

    <div class="settings-container">
      <div class="card">
        <h2 class="card-title">Profile</h2>

        <form id="profile-form" class="settings-form">
          <div class="form-group">
            <label for="settings-username" class="form-label">Username</label>
            <input type="text" id="settings-username" class="form-control" value="${escapeHtmlShell(user.username || '')}" disabled>
          </div>

          <div class="form-group">
            <label for="settings-email" class="form-label">Email</label>
            <input type="email" id="settings-email" class="form-control" value="${escapeHtmlShell(user.email || '')}">
          </div>

          <div class="form-group">
            <label for="settings-fullname" class="form-label">Full name</label>
            <input type="text" id="settings-fullname" class="form-control" value="${escapeHtmlShell(user.fullName || user.full_name || '')}">
          </div>

          <button type="submit" class="btn btn-primary">Save</button>
        </form>
      </div>

      <div class="card">
        <h2 class="card-title">Change password</h2>

        <form id="password-form" class="settings-form">
          <div class="form-group">
            <label for="settings-current-password" class="form-label">Current password</label>
            <input type="password" id="settings-current-password" class="form-control" autocomplete="current-password" required>
          </div>

          <div class="form-group">
            <label for="settings-new-password" class="form-label">New password</label>
            <input type="password" id="settings-new-password" class="form-control" autocomplete="new-password" required>
          </div>

          <div class="form-group">
            <label for="settings-confirm-password" class="form-label">Confirm new password</label>
            <input type="password" id="settings-confirm-password" class="form-control" autocomplete="new-password" required>
          </div>

          <button type="submit" class="btn btn-primary">Change password</button>
        </form>
      </div>

      <div class="card">
        <h2 class="card-title">Export transactions</h2>

        <div class="settings-section">
          <p>Download your transactions as a CSV file for use in other applications.</p>

          <div class="form-group">
            <label for="export-period" class="form-label">Period</label>
            <select id="export-period" class="form-control">
              <option value="all">All time</option>
              <option value="year">This year</option>
              <option value="month">This month</option>
              <option value="custom">Custom range</option>
            </select>
          </div>

          <div id="custom-period" class="custom-period hidden">
            <div class="form-group">
              <label for="export-start-date" class="form-label">From</label>
              <input type="date" id="export-start-date" class="form-control">
            </div>

            <div class="form-group">
              <label for="export-end-date" class="form-label">To</label>
              <input type="date" id="export-end-date" class="form-control">
            </div>
          </div>

          <button id="export-btn" class="btn btn-primary">Export CSV</button>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">More</h2>
        <div class="fm-link-grid">
          <button class="btn btn-outline" type="button" data-settings-page="data-export"><i class="fas fa-download" aria-hidden="true"></i> Backups and data export</button>
          <button class="btn btn-outline" type="button" data-settings-page="api-tokens"><i class="fas fa-key" aria-hidden="true"></i> API tokens</button>
          <button class="btn btn-outline" type="button" data-settings-page="billing"><i class="fas fa-credit-card" aria-hidden="true"></i> Plan and billing</button>
          <button class="btn btn-outline" type="button" data-settings-page="currency"><i class="fas fa-coins" aria-hidden="true"></i> Base currency</button>
          <button class="btn btn-outline" type="button" data-settings-page="onboarding"><i class="fas fa-flag-checkered" aria-hidden="true"></i> Getting started guide</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('profile-form').addEventListener('submit', withBusyForm(handleProfileUpdate));
  document.getElementById('password-form').addEventListener('submit', withBusyForm(handlePasswordUpdate));
  document.getElementById('export-btn').addEventListener('click', handleDataExport);

  const exportPeriod = document.getElementById('export-period');
  const customPeriod = document.getElementById('custom-period');

  exportPeriod.addEventListener('change', () => {
    if (exportPeriod.value === 'custom') {
      customPeriod.classList.remove('hidden');
    } else {
      customPeriod.classList.add('hidden');
    }
  });

  document.querySelectorAll('[data-settings-page]').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.settingsPage));
  });
}

// ---------------------------------------------------------------------------
// Getting started (onboarding wizard entry point)
// ---------------------------------------------------------------------------
function humanizeStepKey(key) {
  return String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

async function renderOnboardingPage() {
  const mainContent = document.getElementById('main-content');
  let status = null;
  try {
    const response = await fetchWithAuth('/api/onboarding/status');
    if (response.ok) {
      const body = await response.json();
      status = body && body.data ? body.data : body;
    }
  } catch (error) {
    status = null;
  }

  const steps = status && Array.isArray(status.steps) ? status.steps : [];
  const stepsHtml = steps.length
    ? `<ul class="fm-steps">${steps.map((s) => `
        <li class="${s.done ? 'done' : ''}">
          <i class="fas ${s.done ? 'fa-check-circle' : 'fa-circle'}" aria-hidden="true"></i>
          <span>${escapeHtmlShell(s.title || s.label || humanizeStepKey(s.key))}</span>
        </li>`).join('')}</ul>`
    : '';

  mainContent.innerHTML = `
    ${pageHeaderHtml('Getting started')}
    <div class="card">
      <p>The setup guide walks you through the first account, your base currency and the first transactions.</p>
      ${stepsHtml}
      <button class="btn btn-primary" id="open-onboarding-btn" type="button">
        <i class="fas fa-flag-checkered" aria-hidden="true"></i> Open the setup guide
      </button>
    </div>
  `;

  document.getElementById('open-onboarding-btn').addEventListener('click', openOnboardingWizard);
}

function openOnboardingWizard() {
  const wizard = typeof window !== 'undefined' ? window.OnboardingWizard : null;
  if (!wizard || typeof wizard.render !== 'function') {
    showNotification('The setup guide is not available', 'error');
    return;
  }
  const show = (status) => {
    wizard.status = status && status.steps ? status : { showWizard: true, steps: [] };
    wizard.activeIndex = typeof wizard.firstIncompleteIndex === 'function' ? wizard.firstIncompleteIndex() : 0;
    wizard.render();
  };
  if (typeof wizard.fetchStatus === 'function') {
    wizard.fetchStatus().then(show).catch(() => show(null));
  } else {
    show(null);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
// Offline queue (offline.js): items queued before a sign-in (or that hit a
// 401 during replay) are sent as soon as there is a valid session again.
function replayOfflineQueue() {
  try {
    const ctl = typeof window !== 'undefined' && window.offlineSync && window.offlineSync.controller;
    if (ctl && typeof ctl.sync === 'function') {
      Promise.resolve(ctl.sync()).catch(() => {});
    }
  } catch (e) { /* offline support is optional */ }
}

// Drops any per-user API responses an older service worker cached.
function clearApiCaches() {
  try {
    if (typeof caches !== 'undefined' && caches && typeof caches.keys === 'function') {
      caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => /-api$/.test(k)).map((k) => caches.delete(k))))
        .catch(() => {});
    }
    if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'clear-api-cache' });
    }
  } catch (e) { /* ignore */ }
}

function logout() {
  localStorage.removeItem('token');

  appState.isAuthenticated = false;
  appState.user = null;
  appState.token = null;
  appState.accounts = [];
  appState.accountsByScope = { own: [], shared: [], all: [] };
  appState.transactions = [];
  appState.categories = [];
  appState.bankConnections = [];
  appState.supportedBanks = [];
  appState.currencySettings = null;
  appState.baseCurrency = 'CAD';
  appState.filters = {
    startDate: null, endDate: null, accountId: null, category: null, type: null, search: '', page: 1
  };
  if (typeof UI !== 'undefined' && UI && typeof UI.resetBaseCurrency === 'function') UI.resetBaseCurrency();
  clearApiCaches();

  closeDrawer();
  document.title = 'Finman';
  renderLoginPage();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// Number locale follows the UI language (en -> browser's English locale or
// en-CA, uk -> uk-UA, ru -> ru-RU).
function numberLocale() {
  let lang = 'en';
  try {
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.getLanguage === 'function') {
      lang = window.i18n.getLanguage();
    }
  } catch (e) { /* ignore */ }
  if (lang === 'uk') return 'uk-UA';
  if (lang === 'ru') return 'ru-RU';
  try {
    const nav = (typeof navigator !== 'undefined' && navigator.language) || '';
    if (/^en-[A-Za-z]{2}$/.test(nav)) return nav;
  } catch (e) { /* ignore */ }
  return 'en-CA';
}

// ISO 4217 shape check: only these codes are handed to Intl.
function isCurrencyCode(code) {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code);
}

// A non-ISO code is still shown (e.g. "US$"), but HTML-escaped and short:
// it comes from the server and ends up in innerHTML.
function fallbackCurrencyLabel(code) {
  return escapeHtmlShell(String(code == null ? '' : code).toUpperCase().slice(0, 10));
}

// Canonical currency formatter. Default currency = the user's base currency
// (from /api/currency/settings), falling back to CAD. Never throws, and the
// result is safe to interpolate into innerHTML (Intl text or escaped fallback).
function fmFormatCurrency(amount, currency) {
  const code = String(currency || appState.baseCurrency || 'CAD').toUpperCase();
  const value = Number(amount);
  const safe = Number.isFinite(value) ? value : 0;
  if (isCurrencyCode(code)) {
    try {
      return new Intl.NumberFormat(numberLocale(), {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(safe);
    } catch (e) { /* fall through */ }
  }
  const label = fallbackCurrencyLabel(code);
  return `${formatPlainNumber(safe)}${label ? ' ' + label : ''}`;
}

// Global alias used by the feature modules.
function formatCurrency(amount, currency) {
  return fmFormatCurrency(amount, currency);
}

// { CAD: 10, EUR: 5 } -> "$10.00 · €5.00" (zero lines dropped; one line minimum).
function formatTotals(totals, fallbackCurrency) {
  const map = totals || {};
  const codes = Object.keys(map).filter((c) => Number(map[c]) !== 0);
  if (!codes.length) return fmFormatCurrency(0, fallbackCurrency);
  return codes.map((c) => fmFormatCurrency(map[c], c)).join(' · ');
}

function netByCurrency(income, expense) {
  const out = {};
  Object.keys(income || {}).forEach((c) => { out[c] = (out[c] || 0) + Number(income[c] || 0); });
  Object.keys(expense || {}).forEach((c) => { out[c] = (out[c] || 0) - Number(expense[c] || 0); });
  return out;
}

function currencySymbol(code) {
  const c = String(code || appState.baseCurrency || 'CAD').toUpperCase();
  if (!isCurrencyCode(c)) return fallbackCurrencyLabel(c);
  try {
    const parts = new Intl.NumberFormat(numberLocale(), { style: 'currency', currency: c }).formatToParts(0);
    const part = parts.find((p) => p.type === 'currency');
    return part ? part.value : c;
  } catch (e) {
    return c;
  }
}

function formatPlainNumber(value, fractionDigits = 2) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat(numberLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).format(safe);
  } catch (e) {
    return safe.toFixed(fractionDigits);
  }
}

// Count-up animation for the hero figure; disabled with prefers-reduced-motion.
function animateHeroNetWorth() {
  const el = document.getElementById('hero-networth');
  if (!el) return;
  const amountEl = el.querySelector('.fm-hero-amount');
  const target = parseFloat(el.getAttribute('data-countup')) || 0;
  const fmt = (v) => formatPlainNumber(Math.round(v), 0);
  const reduce = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!amountEl) return;
  if (reduce || target === 0) {
    amountEl.textContent = fmt(target);
    return;
  }
  const duration = 900;
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    amountEl.textContent = fmt(target * ease(t));
    if (t < 1) requestAnimationFrame(step);
    else amountEl.textContent = fmt(target);
  }
  requestAnimationFrame(step);
}

// 'YYYY-MM-DD' (optionally with a time) -> local Date; null when invalid.
// Same rules as UI.parseYMD (lib/ui.js), which app.js cannot require.
function parseLocalDate(value) {
  if (typeof UI !== 'undefined' && UI && typeof UI.parseYMD === 'function') return UI.parseYMD(value);
  const str = String(value == null ? '' : value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(str);
  return str && !Number.isNaN(d.getTime()) ? d : null;
}

// Localized date; '' for anything that is not a date (never echoes raw input).
function formatDate(dateString) {
  const date = parseLocalDate(dateString);
  if (!date || Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleDateString(numberLocale());
  } catch (e) {
    return date.toLocaleDateString();
  }
}

function getAccountIcon(accountType) {
  switch (accountType) {
    case 'checking':
      return 'fa-wallet';
    case 'savings':
      return 'fa-piggy-bank';
    case 'credit':
      return 'fa-credit-card';
    case 'loan':
      return 'fa-hand-holding-usd';
    default:
      return 'fa-wallet';
  }
}

function getAccountTypeName(accountType) {
  switch (accountType) {
    case 'checking':
      return 'Checking account';
    case 'savings':
      return 'Savings account';
    case 'credit':
      return 'Credit card';
    case 'loan':
      return 'Loan';
    default:
      return 'Account';
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function ensureToastStack() {
  let stack = document.getElementById('fm-toasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'fm-toasts';
    stack.className = 'fm-toasts';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}

const TOAST_FALLBACKS = {
  error: 'Something went wrong. Please try again.',
  success: 'Done',
  warning: 'Please check this',
  info: ''
};

function showNotification(message, type = 'info') {
  if (typeof document === 'undefined') return null;
  const kind = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
  let text = message instanceof Error ? message.message : message;
  if (text == null || text === '' || text === 'undefined' || text === 'null' || text === '[object Object]') {
    text = TOAST_FALLBACKS[kind];
  }
  text = String(text);
  if (!text) return null;

  const notification = document.createElement('div');
  notification.className = `notification notification-${kind}`;
  notification.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  const content = document.createElement('div');
  content.className = 'notification-content';
  const span = document.createElement('span');
  span.textContent = text;
  content.appendChild(span);

  const closeButton = document.createElement('button');
  closeButton.className = 'notification-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Dismiss');
  closeButton.innerHTML = '&times;';

  notification.appendChild(content);
  notification.appendChild(closeButton);
  ensureToastStack().appendChild(notification);

  requestAnimationFrame(() => notification.classList.add('show'));

  const timeout = setTimeout(() => {
    hideNotification(notification);
  }, kind === 'error' ? 8000 : 5000);

  closeButton.addEventListener('click', () => {
    clearTimeout(timeout);
    hideNotification(notification);
  });

  return notification;
}

function hideNotification(notification) {
  if (!notification) return;
  notification.classList.remove('show');

  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// Browser history
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (appState.isAuthenticated) {
      navigateTo(resolvePageFromPath(window.location.pathname), { replace: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Render wrappers for page-object modules
// ---------------------------------------------------------------------------
function renderSubscriptionsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = SubscriptionsModule.getPage();
  return SubscriptionsModule.init();
}

function renderNetWorthPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = NetWorthModule.getPage();
  return NetWorthModule.init();
}

function renderReceiptsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = ReceiptsModule.getPage();
  return ReceiptsModule.init();
}

function renderCalendarPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = CalendarModule.getPage();
  return CalendarModule.init();
}

function renderReportsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = ReportsModule.getPage();
  return ReportsModule.init();
}

function renderForecastPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = ForecastModule.getPage();
  return ForecastModule.init();
}

// Pure helpers for node-based unit tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    appState,
    formatCurrency: fmFormatCurrency,
    formatDate,
    formatTotals,
    netByCurrency,
    isCurrencyCode,
    currencySymbol,
    numberLocale,
    formatPlainNumber,
    normalizeAccounts,
    resolvePageFromPath,
    readApiError,
    NAV_PRIMARY,
    NAV_GROUPS,
    PAGE_RENDERERS
  };
}
