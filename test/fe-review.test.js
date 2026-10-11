// test/fe-review.test.js — regressions for the frontend review fixes
// (review/fix-fe): stored XSS in the app shell, formatter fallbacks, opening
// rows in the edit modal, offline queue, service worker /api caching,
// FormData uploads, local dates, dashboard totals, base currency, reports,
// subscriptions, double submit, recurring weekdays, CSV injection, widgets.
//
// The browser scripts are loaded into a real jsdom window as classic scripts
// (same global scope as in index.html); fetch is stubbed per route.

process.env.TZ = 'America/Toronto';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUB = path.join(__dirname, '..', 'public');
const JS = path.join(PUB, 'js');
const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

const SHELL = ['locales/en.js', 'i18n.js', 'app.js', 'lib/ui.js', 'transactions.js'];

const reply = (status, body) => ({ __reply: true, status, body });

async function boot({ scripts = SHELL, routes = {}, before } = {}) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><body><div id="app"><div id="main-content"></div></div></body></html>',
    { runScripts: 'dangerously', url: 'http://localhost/', virtualConsole: vc, pretendToBeVisual: true }
  );
  const w = dom.window;
  await new Promise((r) => (w.document.readyState === 'complete' ? r() : w.addEventListener('load', r)));
  w.localStorage.setItem('token', 'tok');
  w.localStorage.setItem('finman_lang', 'en');
  const calls = [];
  w.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost/');
    const method = String(opts.method || 'GET').toUpperCase();
    calls.push({ method, path: u.pathname, search: u.search, opts });
    const h = routes[`${method} ${u.pathname}`] || routes[u.pathname];
    let out = typeof h === 'function' ? h(u, opts) : h;
    if (out === undefined) out = reply(404, { message: 'not found' });
    if (!out || !out.__reply) out = reply(200, out);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  };
  w.confirm = () => true;
  w.alert = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, addListener() {} });
  if (before) before(w);
  for (const s of scripts) {
    const el = w.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(JS, s), 'utf8');
    w.document.head.appendChild(el);
  }
  if (scripts.includes('app.js')) w.eval('window.formatCurrency = fmFormatCurrency;');
  return { w, calls, errors };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const submit = (w, form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

// ---------------------------------------------------------------------------
describe('stored XSS in the app shell', () => {
  const evilAccount = {
    id: 1, name: XSS, account_number: XSS, bank_name: XSS, currency: 'CAD', balance: 100, account_type: 'checking',
  };
  const evilTx = {
    id: 7, account_id: 1, date: '2026-10-05', description: XSS, category: XSS, amount: -12.5, type: 'expense', account_name: XSS,
  };

  test('dashboard renders account and transaction fields as text', async () => {
    const { w, errors } = await boot({
      routes: {
        '/api/accounts': [evilAccount],
        '/api/transactions': [evilTx],
        '/api/analytics/overview': { totalBalance: 100, baseCurrency: 'CAD' },
      },
    });
    w.eval('appState.accounts = ' + JSON.stringify([evilAccount]));
    await w.eval('renderDashboard()');
    const main = w.document.getElementById('main-content');
    expect(main.querySelectorAll('img').length).toBe(0);
    expect(main.textContent).toContain('<img src=x');
    expect(w.__xss).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('accounts list escapes name, number and bank', async () => {
    const { w } = await boot();
    const html = w.eval('renderAccountsList')([evilAccount]);
    const div = w.document.createElement('div');
    div.innerHTML = html;
    expect(div.querySelectorAll('img').length).toBe(0);
    expect(div.querySelector('.account-bank').textContent).toContain('<img');
  });

  test('transaction filter <option>s escape account names and categories', async () => {
    const { w } = await boot({ routes: { '/api/transactions': [evilTx] } });
    w.eval('appState.accounts = ' + JSON.stringify([evilAccount]));
    w.eval('appState.filters.search = ' + JSON.stringify('"><img src=x onerror=1>'));
    await w.eval('renderTransactionsPage()');
    const main = w.document.getElementById('main-content');
    expect(main.querySelectorAll('img').length).toBe(0);
    expect(w.document.getElementById('filter-search').value).toBe('"><img src=x onerror=1>');
    const cats = [...w.document.querySelectorAll('#filter-category option')].map((o) => o.value);
    expect(cats).toContain(XSS);
  });

  test('invalid dates and currency codes cannot inject markup', async () => {
    const { w } = await boot();
    const row = { ...evilTx, date: XSS, currency: '<IMG SRC=X ONERROR=alert(1)>' };
    const tbody = w.document.createElement('tbody');
    w.document.createElement('table').appendChild(tbody);
    tbody.innerHTML = w.eval('renderTransactionsList')([row]);
    expect(tbody.querySelectorAll('img').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('formatters', () => {
  let w;
  beforeAll(async () => { ({ w } = await boot()); });

  test('formatCurrency only hands ISO codes to Intl; the fallback is escaped', () => {
    const fmt = w.eval('fmFormatCurrency');
    expect(fmt(5, 'CAD')).toMatch(/\$5\.00/);
    const bad = fmt(5, '<b onmouseover=x>');
    expect(bad).not.toMatch(/[<>"]/);
    expect(bad).toMatch(/^5\.00 /);
    expect(fmt(5, 'US$')).toBe('5.00 US$');
  });

  test('UI.money never returns raw markup', () => {
    expect(w.UI.money(5, '<script>')).not.toMatch(/[<>]/);
    expect(w.UI.money(5, 'EUR')).toMatch(/€/);
  });

  test('formatDate: invalid -> empty string, YYYY-MM-DD is a local calendar day', () => {
    const fd = w.eval('formatDate');
    expect(fd('<img src=x>')).toBe('');
    expect(fd(null)).toBe('');
    // 2026-10-01 must stay Oct 1 west of Greenwich (new Date('2026-10-01') is UTC midnight).
    expect(fd('2026-10-01')).toBe(w.eval('new Date(2026, 9, 1).toLocaleDateString(numberLocale())'));
    expect(fd('2026-10-01')).not.toBe(w.eval('new Date(2026, 8, 30).toLocaleDateString(numberLocale())'));
  });
});

// ---------------------------------------------------------------------------
describe('local dates (UI.ymd / todayYMD / parseYMD / monthRange)', () => {
  let UI;
  beforeAll(async () => { ({ w: { UI } } = await boot({ scripts: ['lib/ui.js'] })); });

  test('ymd uses the local calendar, late evening included', () => {
    const lateEvening = new Date(2026, 9, 31, 23, 30);
    expect(UI.ymd(lateEvening)).toBe('2026-10-31');
    // toISOString() would already say November in Toronto:
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-11-01');
  });

  test('parseYMD builds a local midnight date and rejects garbage', () => {
    const d = UI.parseYMD('2026-03-08');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 2, 8, 0]);
    expect(UI.parseYMD('2026-02-31')).toBeNull();
    expect(UI.parseYMD('nope')).toBeNull();
    expect(UI.parseYMD('')).toBeNull();
  });

  test('monthRange and todayYMD', () => {
    expect(UI.monthRange(new Date(2026, 1, 15))).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(UI.todayYMD()).toBe(UI.ymd(new Date()));
  });

  test('calendar month navigation from the 31st does not skip a month', async () => {
    const { w } = await boot({ scripts: ['locales/en.js', 'i18n.js', 'lib/ui.js', 'calendar.js'] });
    w.eval('CalendarModule.loadEvents = function () {}; CalendarModule.currentDate = new Date(2026, 0, 31);');
    w.eval('CalendarModule.nextMonth()');
    expect(w.eval('CalendarModule.currentDate.getMonth()')).toBe(1); // February
    w.eval('CalendarModule.currentDate = new Date(2026, 2, 31); CalendarModule.prevMonth()');
    expect(w.eval('CalendarModule.currentDate.getMonth()')).toBe(1); // February again
  });
});

// ---------------------------------------------------------------------------
describe('base currency', () => {
  test('UI.baseCurrency: loaded value -> appState.baseCurrency -> CAD; reset on logout', async () => {
    const { w } = await boot({ scripts: ['lib/ui.js'] });
    expect(w.UI.baseCurrency()).toBe('CAD');
    w.appState = { baseCurrency: 'EUR' };
    expect(w.UI.baseCurrency()).toBe('EUR');
    w.UI.setBaseCurrency('uah');
    expect(w.UI.baseCurrency()).toBe('UAH');
    w.UI.resetBaseCurrency();
    expect(w.UI.baseCurrency()).toBe('EUR');
  });

  test('logout clears the cached base currency and session state', async () => {
    const { w } = await boot();
    w.eval("appState.baseCurrency = 'EUR'; UI.setBaseCurrency('EUR'); appState.filters.search = 'x';");
    w.eval('logout()');
    expect(w.UI.baseCurrency()).toBe('CAD');
    expect(w.eval('appState.baseCurrency')).toBe('CAD');
    expect(w.eval('appState.filters.search')).toBe('');
    expect(w.localStorage.getItem('token')).toBeNull();
  });

  test('currency settings are sent in camelCase (models/currency.js reads baseCurrency)', async () => {
    let body = null;
    const { w } = await boot({
      scripts: [...SHELL, 'currency.js'],
      routes: {
        'PUT /api/currency/settings': (u, o) => { body = JSON.parse(o.body); return { success: true, settings: { base_currency: 'EUR' } }; },
      },
    });
    w.document.getElementById('main-content').innerHTML = '<div id="currency-tab-content"></div>';
    w.eval("currencyState.supportedCurrencies = [{ code: 'CAD', symbol: '$', name: 'Canadian dollar' }, { code: 'EUR', symbol: '€', name: 'Euro' }]");
    await w.eval('renderCurrencySettingsTab()');
    w.document.getElementById('base-currency').value = 'EUR';
    submit(w, w.document.getElementById('currency-settings-form'));
    await tick(20);
    expect(body).toEqual(expect.objectContaining({ baseCurrency: 'EUR', autoConvert: expect.any(Boolean) }));
    expect(body).not.toHaveProperty('base_currency');
    expect(w.eval('appState.baseCurrency')).toBe('EUR');
    expect(w.UI.baseCurrency()).toBe('EUR');
  });
});

// ---------------------------------------------------------------------------
describe('transactions: opening rows, double submit, offline, FormData', () => {
  const opening = { id: 3, account_id: 1, date: '2026-10-01', description: 'Opening balance', category: '', amount: -500, type: 'opening' };
  const accounts = [{ id: 1, name: 'Chequing', currency: 'CAD', balance: 0 }];

  test('opening rows have no Edit button; the modal keeps their type and sign', async () => {
    let put = null;
    const { w } = await boot({ routes: { 'PUT /api/transactions/3': (u, o) => { put = JSON.parse(o.body); return { ok: true }; } } });
    w.eval('appState.accounts = ' + JSON.stringify(accounts));
    const tbody = w.document.createElement('tbody');
    w.document.createElement('table').appendChild(tbody);
    tbody.innerHTML = w.eval('renderTransactionsList')([opening]);
    expect(tbody.querySelector('[data-transaction-action="edit"]')).toBeNull();
    expect(tbody.querySelector('[data-transaction-action="delete"]')).not.toBeNull();

    w.eval('showAddTransactionModal')(opening);
    expect(w.document.getElementById('transaction-modal-type').disabled).toBe(true);
    submit(w, w.document.getElementById('transaction-modal-form'));
    await tick(20);
    expect(put).toEqual(expect.objectContaining({ type: 'opening', amount: -500 }));
  });

  test('a string argument presets the type of a NEW transaction (widgets quick add)', async () => {
    const { w } = await boot();
    w.eval('appState.accounts = ' + JSON.stringify(accounts));
    w.eval("showAddTransactionModal('income')");
    expect(w.document.getElementById('transaction-modal-type').value).toBe('income');
    expect(w.document.getElementById('transaction-modal-amount').value).toBe('');
    // the default date is the local today
    expect(w.document.getElementById('transaction-modal-date').value).toBe(w.UI.todayYMD());
  });

  test('double submit sends one POST while the first is in flight', async () => {
    let posts = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { w } = await boot();
    w.eval('appState.accounts = ' + JSON.stringify(accounts));
    const origFetch = w.fetch;
    w.fetch = async (url, o = {}) => {
      if (String(o.method).toUpperCase() === 'POST') { posts++; await gate; return new Response('{"id":9}', { status: 201 }); }
      return origFetch(url, o);
    };
    w.eval('showAddTransactionModal')();
    w.document.getElementById('transaction-modal-account').value = '1';
    w.document.getElementById('transaction-modal-amount').value = '5';
    const form = w.document.getElementById('transaction-modal-form');
    submit(w, form);
    submit(w, form);
    await tick(5);
    expect(form.querySelector('button[type="submit"]').disabled).toBe(true);
    release();
    await tick(20);
    expect(posts).toBe(1);
  });

  test('UI data-submit forms are guarded too', async () => {
    const { w } = await boot({ scripts: ['lib/ui.js'] });
    let calls = 0;
    let release;
    w.UI.actions({ 'test:save': () => { calls++; return new Promise((r) => { release = r; }); } });
    w.document.body.innerHTML = '<form data-submit="test:save"><button type="submit">Save</button></form>';
    const form = w.document.querySelector('form');
    submit(w, form);
    submit(w, form);
    expect(calls).toBe(1);
    expect(form.querySelector('button').disabled).toBe(true);
    release();
    await tick();
    expect(form.querySelector('button').disabled).toBe(false);
  });

  test('offline 503 from the service worker queues the transaction and says so', async () => {
    const queued = [];
    const { w } = await boot({
      routes: { 'POST /api/transactions': reply(503, { error: true, offline: true, queueable: true }) },
      before: (win) => { win.queueOfflineTransaction = async (p) => { queued.push(p); return { clientId: 'c1' }; }; },
    });
    const res = await w.eval('createTransaction')({ accountId: 1, type: 'expense', amount: -5, date: '2026-10-11' });
    expect(queued).toHaveLength(1);
    expect(res).toEqual(expect.objectContaining({ queued: true }));
    const toast = w.document.querySelector('.notification');
    expect(toast.textContent).toMatch(/saved on this device/);
  });

  test('without a queue the user is told the transaction was NOT saved', async () => {
    const { w } = await boot({ routes: { 'POST /api/transactions': reply(503, { offline: true }) } });
    const res = await w.eval('createTransaction')({ accountId: 1 });
    expect(res).toBeNull();
    expect(w.document.querySelector('.notification').textContent).toMatch(/could not be saved/);
  });

  test('fetchWithAuth leaves Content-Type to the browser for FormData', async () => {
    const { w, calls } = await boot({ routes: { 'POST /api/upload': { ok: true } } });
    const fd = new w.FormData();
    fd.append('a', '1');
    await w.eval('fetchWithAuth')('/api/upload', { method: 'POST', body: fd, headers: { 'Content-Type': 'application/json' } });
    const h = calls[0].opts.headers;
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(h.Authorization).toBe('Bearer tok');
    await w.eval('fetchWithAuth')('/api/upload', { method: 'POST', body: '{}' });
    expect(calls[1].opts.headers['Content-Type']).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
describe('dashboard statistics', () => {
  test('opening/transfer rows are not cash flow; currencies are never added together', async () => {
    const { w } = await boot();
    const accounts = [
      { id: 1, currency: 'CAD', balance: 100 },
      { id: 2, currency: 'EUR', balance: 50 },
    ];
    const txs = [
      { account_id: 1, type: 'income', amount: 1000, category: 'Salary', date: '2026-10-05' },
      { account_id: 1, type: 'expense', amount: -25, category: 'Food', date: '2026-10-06' },
      { account_id: 2, type: 'expense', amount: -10, category: 'Food', date: '2026-10-06' },
      { account_id: 1, type: 'opening', amount: -500, date: '2026-10-01' },
      { account_id: 1, type: 'transfer', amount: -40, date: '2026-10-02' },
      { account_id: 2, type: 'transfer', amount: 40, date: '2026-10-02' },
    ];
    const s = w.eval('computeTransactionStats')(txs, accounts, 'CAD');
    expect(s.incomeByCurrency).toEqual({ CAD: 1000 });
    expect(s.expenseByCurrency).toEqual({ CAD: 25, EUR: 10 });
    expect(s.monthlyIncome).toBe(1000);
    expect(s.monthlyExpense).toBe(25);
    expect(s.mixedCurrencies).toBe(true);
    expect(s.balanceByCurrency).toEqual({ CAD: 100, EUR: 50 });
    expect(Object.keys(s.transactionsByCategory).sort()).toEqual(['Food', 'Salary']);
    expect(s.transactionsByCategory.Food.expense).toBe(25);
  });

  test('fetchTransactionStats pages with limit 500 and uses the converted balance', async () => {
    const { w, calls } = await boot({
      routes: {
        '/api/transactions': (u) => (u.searchParams.get('page') === '1'
          ? Array.from({ length: 500 }, () => ({ account_id: 1, type: 'expense', amount: -1, date: '2026-10-02' }))
          : [{ account_id: 1, type: 'expense', amount: -1, date: '2026-10-03' }]),
        '/api/accounts': [{ id: 1, currency: 'CAD', balance: 10 }, { id: 2, currency: 'EUR', balance: 10 }],
        '/api/analytics/overview': { totalBalance: 24.7, baseCurrency: 'CAD' },
      },
    });
    const s = await w.eval('fetchTransactionStats()');
    const txCalls = calls.filter((c) => c.path === '/api/transactions');
    expect(txCalls.map((c) => new URLSearchParams(c.search).get('limit'))).toEqual(['500', '500']);
    expect(s.monthlyExpense).toBe(501);
    expect(s.totalBalance).toBe(24.7);
    expect(s.balanceCurrency).toBe('CAD');
  });
});

// ---------------------------------------------------------------------------
describe('offline queue', () => {
  const offline = require(path.join(JS, 'offline.js'));

  test('items stuck in "sending" are put back to pending on start-up', async () => {
    const store = offline.createMemoryStore();
    const item = offline.makeQueueItem({ amount: 1 }, 1);
    item.status = 'sending';
    await store.put(item);
    expect(await offline.pendingCount(store)).toBe(0);
    expect(await offline.recoverStuck(store)).toBe(1);
    expect(await offline.pendingCount(store)).toBe(1);
  });

  test('a 401 during replay is "retry after login", not a permanent failure', async () => {
    const prevFetch = globalThis.fetch;
    const prevLs = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => 'tok' };
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    try {
      const r = await offline.httpSender({ clientTxId: 'x' });
      expect(r).toEqual(expect.objectContaining({ ok: false, permanent: false }));
      const store = offline.createMemoryStore();
      await offline.enqueue(store, { amount: 1 });
      const res = await offline.replayQueue(store, offline.httpSender);
      expect(res.failed).toBe(0);
      expect(res.remaining).toBe(1);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevLs === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLs;
    }
  });
});

// ---------------------------------------------------------------------------
describe('service worker', () => {
  const sw = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');

  test('authenticated /api responses are never cached', () => {
    expect(sw).not.toMatch(/API_CACHE/);
    const api = sw.slice(sw.indexOf('async function apiNetworkOnly'), sw.indexOf('async function navigationNetworkFirst'));
    expect(api).not.toMatch(/cache\.put|caches\.match|caches\.open/);
    expect(api).not.toMatch(/was saved on this device/);
  });

  test('cache version bumped past v3 and lib/ui.js precached', () => {
    const version = sw.match(/const CACHE_VERSION = '([^']+)'/)[1];
    expect(['finman-v1', 'finman-v2', 'finman-v3']).not.toContain(version);
    const list = sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1];
    expect(list).toContain("'/js/lib/ui.js'");
  });
});

// ---------------------------------------------------------------------------
describe('reports, subscriptions, recurring, investments, widgets, CSV', () => {
  test('reports: generate reads result.data; view parses the stored JSON string', async () => {
    const { w } = await boot({
      scripts: [...SHELL, 'reports.js'],
      routes: {
        'POST /api/reports/generate': { id: 1, data: { summary: { income: 1234, expenses: 200, balance: 1034 } } },
        '/api/reports': [],
        '/api/reports/2': { id: 2, report_type: 'monthly', file_data: JSON.stringify({ summary: { income: 77 } }) },
      },
    });
    w.document.getElementById('main-content').innerHTML = w.eval('ReportsModule.getPage()');
    w.eval("ReportsModule.currencies = ['CAD']");
    w.document.getElementById('report-type').value = 'monthly';
    await w.eval('ReportsModule.generateReport()');
    expect(w.document.getElementById('report-result').textContent).toMatch(/1,234\.00/);
    await w.eval('ReportsModule.viewReport(2)');
    expect(w.document.getElementById('report-result').textContent).toMatch(/77\.00/);
    expect(w.eval('ReportsModule.parseReportData')('{broken')).toEqual({});
  });

  test('subscriptions: Mark paid -> /payment, Cancel -> /toggle, errors are shown', async () => {
    const { w, calls } = await boot({
      scripts: [...SHELL, 'subscriptions.js'],
      routes: {
        '/api/subscriptions': [{ id: 4, name: 'Music', amount: 9, currency: 'CAD', billing_cycle: 'monthly', is_active: 1 }],
        '/api/subscriptions/stats': {},
        'POST /api/subscriptions/4/payment': { message: 'Payment recorded' },
        'POST /api/subscriptions/4/toggle': reply(500, { message: 'Toggle exploded' }),
      },
    });
    w.document.getElementById('main-content').innerHTML = w.eval('SubscriptionsModule.getPage()');
    await w.eval('SubscriptionsModule.loadSubscriptions()');
    await w.eval('SubscriptionsModule.markPaid(4)');
    const pay = calls.find((c) => c.path === '/api/subscriptions/4/payment');
    expect(pay).toBeTruthy();
    expect(JSON.parse(pay.opts.body).payment_date).toBe(w.UI.todayYMD());
    await w.eval('SubscriptionsModule.cancel(4)');
    expect(calls.some((c) => c.path === '/api/subscriptions/4/toggle')).toBe(true);
    expect([...w.document.querySelectorAll('.notification')].map((n) => n.textContent).join(' ')).toMatch(/Toggle exploded/);
  });

  test('recurring: Sunday (0) survives the save and is pre-selected on edit', async () => {
    let body = null;
    const { w } = await boot({
      scripts: [...SHELL, 'recurring.js'],
      routes: { 'POST /api/recurring': (u, o) => { body = JSON.parse(o.body); return { id: 1 }; } },
    });
    w.eval("appState.accounts = [{ id: 1, name: 'A', currency: 'CAD' }]");
    w.eval("showAddRecurringModal({ id: 5, name: 'Gym', amount: 10, type: 'expense', frequency: 'weekly', day_of_week: 0, account_id: 1, start_date: '2026-10-04' })");
    expect(w.document.getElementById('rp-day-of-week').value).toBe('0');
    expect(w.eval('parseIntOrNull')('0')).toBe(0);
    expect(w.eval('parseIntOrNull')('')).toBeNull();
    w.document.getElementById('recurring-modal').remove();
    w.eval('showAddRecurringModal()');
    w.document.getElementById('rp-name').value = 'Gym';
    w.document.getElementById('rp-amount').value = '10';
    w.document.getElementById('rp-frequency').value = 'weekly';
    w.document.getElementById('rp-day-of-week').value = '0';
    w.document.getElementById('rp-account').value = '1';
    await w.eval('saveRecurring(null)');
    expect(body).toEqual(expect.objectContaining({ dayOfWeek: 0, dayOfMonth: null, frequency: 'weekly' }));
  });

  test('recurring: the payment type cannot break out of its class attribute', async () => {
    const { w } = await boot({ scripts: [...SHELL, 'recurring.js'] });
    const html = w.eval('renderPaymentCard')({ id: 1, name: 'x', type: '"><img src=x onerror=1>', amount: 5, next_payment_date: '2026-10-20', is_active: 1 });
    const div = w.document.createElement('div');
    div.innerHTML = html;
    expect(div.querySelectorAll('img').length).toBe(0);
  });

  test('investments: the add-asset form has a currency field (default base currency)', async () => {
    const { w } = await boot({
      scripts: [...SHELL, 'investments.js'],
      routes: { '/api/investments/types': { Stock: 'stock' } },
    });
    w.eval("appState.baseCurrency = 'EUR'");
    await w.eval('showAddInvestmentModal(3)');
    const sel = w.document.getElementById('inv-currency');
    expect(sel).not.toBeNull();
    expect(sel.getAttribute('name')).toBe('currency');
    expect(sel.value).toBe('EUR');
  });

  test('widgets: an expense reads "−$50.00", never "--$50.00"', async () => {
    const { w } = await boot({ scripts: [...SHELL, 'widgets.js'] });
    const html = w.DashboardWidgets.renderContent('recent', { transactions: [
      { description: 'Food', type: 'expense', amount: -50 },
      { description: 'Pay', type: 'income', amount: 70 },
    ] });
    expect(html).not.toMatch(/--/);
    expect(html).toMatch(/−(CA)?\$50\.00/);
    expect(html).toMatch(/\+(CA)?\$70\.00/);
  });

  test('CSV export neutralises formula cells', async () => {
    const { w } = await boot();
    const cell = w.eval('csvCell');
    expect(cell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(cell('+1')).toBe('"\'+1"');
    expect(cell('-1')).toBe('"\'-1"');
    expect(cell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(cell('\tx')).toBe('"\'\tx"');
    expect(cell('Coffee')).toBe('"Coffee"');
    expect(cell(null)).toBe('""');
  });

  test('shell document listeners are added once across logins', async () => {
    const { w } = await boot();
    let added = 0;
    const orig = w.document.addEventListener.bind(w.document);
    w.document.addEventListener = (type, ...rest) => { if (type === 'click' || type === 'keydown') added++; return orig(type, ...rest); };
    w.eval("appState.user = { username: 'u' }; appState.isAuthenticated = true;");
    w.eval('renderAuthenticatedUI(); renderAuthenticatedUI(); renderAuthenticatedUI();');
    expect(added).toBe(2);
  });
});
