// ==================== SHARED UI HELPERS (window.UI) ====================
// Dependency-free helpers shared by the feature modules. Loaded as a classic
// script AFTER app.js (needs window.formatCurrency / fetchWithAuth when present)
// and BEFORE the feature modules. Also requirable from Jest (jsdom).
//
// Public API (window.UI):
//   esc(text)                              HTML-escape for innerHTML templates
//   money(amount, currency)                format with the entity's own currency
//   fmtNumber(n, digits)                   plain localized number (no currency)
//   baseCurrency() / loadBaseCurrency()    user's base currency (/api/currency/settings)
//   sumByCurrency(items, amountOf, currencyOf) -> { CUR: total }
//   moneyList(totals, opts)                HTML with one line per currency
//   aggregateMoney(amount, currencies)     format a server-side sum honestly
//   mixedCurrencyNote(currencies)          visible note when a sum mixes currencies
//   currencyOptions(selected)              <option> list for currency selects
//   monthlyFactor(cycle)                   billing cycle -> payments per month
//   accountCurrencies()                    distinct currencies of the user's accounts
//   actions(map)                           register data-action / data-submit / data-change handlers
//   openModal(target, opts) / closeModal(target) / modal(spec) / closeTopModal()
//   emptyState(spec)                       designed empty-state markup (accounts convention)
//
// Modal convention: a host `.modal-backdrop[hidden]` containing `.modal`.
// openModal removes `hidden`, adds `.is-open`, traps focus, closes on Esc and on
// backdrop click. Elements created by UI.modal() are removed from the DOM on close.

(function (root) {
  'use strict';

  var doc = root.document;
  var DEFAULT_BASE = 'UAH'; // server default (services/networthService DEFAULT_BASE)
  var COMMON_CURRENCIES = ['USD', 'EUR', 'CAD', 'UAH', 'GBP', 'PLN'];

  // ---------- text / numbers ----------
  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function locale() {
    var lang = doc && doc.documentElement && doc.documentElement.lang;
    if (lang === 'uk') return 'uk-UA';
    if (lang === 'en') return 'en-CA';
    return 'ru-RU';
  }

  function fmtNumber(n, digits) {
    var num = Number(n);
    if (!isFinite(num)) num = 0;
    var d = digits == null ? 2 : digits;
    try {
      return new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(num);
    } catch (e) {
      return num.toFixed(d);
    }
  }

  var baseCur = null;
  var basePromise = null;

  function baseCurrency() {
    return baseCur || DEFAULT_BASE;
  }

  function setBaseCurrency(code) {
    if (code) baseCur = String(code).toUpperCase();
  }

  function authFetch(url, options) {
    if (typeof root.fetchWithAuth === 'function') return root.fetchWithAuth(url, options);
    var token = null;
    try { token = root.localStorage && root.localStorage.getItem('token'); } catch (e) { /* ignore */ }
    var opts = options || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    return root.fetch(url, opts);
  }

  // Loads the user's base currency once; later calls reuse the result.
  function loadBaseCurrency() {
    if (baseCur) return Promise.resolve(baseCur);
    if (basePromise) return basePromise;
    basePromise = authFetch('/api/currency/settings')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        var code = s && (s.base_currency || s.baseCurrency);
        if (code) setBaseCurrency(code);
        return baseCurrency();
      })
      .catch(function () { return baseCurrency(); });
    return basePromise;
  }

  function money(amount, currency) {
    var cur = String(currency || baseCurrency()).toUpperCase();
    var num = Number(amount);
    if (!isFinite(num)) num = 0;
    if (typeof root.formatCurrency === 'function') {
      try { return root.formatCurrency(num, cur); } catch (e) { /* invalid code -> fallback */ }
    }
    try {
      return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, minimumFractionDigits: 2 }).format(num);
    } catch (e) {
      return fmtNumber(num) + ' ' + cur;
    }
  }

  // Groups amounts by currency; never adds two currencies together.
  function sumByCurrency(items, amountOf, currencyOf) {
    var totals = {};
    (items || []).forEach(function (it) {
      var amt = Number(typeof amountOf === 'function' ? amountOf(it) : it[amountOf || 'amount']);
      if (!isFinite(amt)) amt = 0;
      var cur = typeof currencyOf === 'function' ? currencyOf(it) : it[currencyOf || 'currency'];
      cur = String(cur || baseCurrency()).toUpperCase();
      totals[cur] = Math.round(((totals[cur] || 0) + amt) * 100) / 100;
    });
    return totals;
  }

  // One line per currency: <span class="fm-money-list"><span class="fm-money">…</span></span>
  function moneyList(totals, opts) {
    opts = opts || {};
    var codes = Object.keys(totals || {});
    if (!codes.length) return '<span class="fm-money-list"><span class="fm-money">' + esc(money(0, opts.fallbackCurrency)) + '</span></span>';
    return '<span class="fm-money-list">' + codes.map(function (code) {
      var v = totals[code];
      var sign = opts.signed && v > 0 ? '+' : '';
      var cls = 'fm-money' + (opts.signed ? (v > 0 ? ' positive' : v < 0 ? ' negative' : '') : '');
      return '<span class="' + cls + '">' + esc(sign + money(v, code)) + '</span>';
    }).join('') + '</span>';
  }

  // For a sum the SERVER already produced across entities: format with the
  // currency when all entities share one, otherwise show a plain number — the
  // mixed-currency note (mixedCurrencyNote) tells the user why.
  function aggregateMoney(amount, currencies) {
    var list = uniqueCurrencies(currencies);
    if (list.length === 1) return money(amount, list[0]);
    if (list.length === 0) return money(amount, baseCurrency());
    return fmtNumber(amount);
  }

  function uniqueCurrencies(currencies) {
    var seen = {};
    var out = [];
    (currencies || []).forEach(function (c) {
      if (!c) return;
      var code = String(c).toUpperCase();
      if (!seen[code]) { seen[code] = true; out.push(code); }
    });
    return out;
  }

  function mixedCurrencyNote(currencies, subject) {
    var list = uniqueCurrencies(currencies);
    if (list.length < 2) return '';
    return '<div class="fm-currency-note" role="note">' + esc(subject || 'Счета') + ' ведутся в разных валютах (' + esc(list.join(', ')) +
      '): итоговые суммы сложены без конвертации и показаны без знака валюты.</div>';
  }

  function currencyOptions(selected) {
    var sel = String(selected || baseCurrency()).toUpperCase();
    var codes = uniqueCurrencies([sel].concat(accountCurrencies(), COMMON_CURRENCIES));
    return codes.map(function (c) {
      return '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
  }

  function monthlyFactor(cycle) {
    switch (cycle) {
      case 'daily': return 365 / 12;
      case 'weekly': return 52 / 12;
      case 'biweekly': return 26 / 12;
      case 'monthly': return 1;
      case 'quarterly': return 1 / 3;
      case 'yearly': return 1 / 12;
      default: return 1;
    }
  }

  // appState.accounts is either an array or { own, shared, all } (routes/accounts.js).
  function accountsArray() {
    var a = root.appState && root.appState.accounts;
    if (Array.isArray(a)) return a;
    if (a && Array.isArray(a.all)) return a.all;
    if (a && Array.isArray(a.own)) return a.own.concat(a.shared || []);
    return [];
  }

  function accountCurrencies() {
    return uniqueCurrencies(accountsArray().map(function (acc) { return acc.currency; }));
  }

  // Same as accountCurrencies(), but fetches /api/accounts when appState has
  // nothing yet (e.g. deep link straight into analytics/forecast).
  var accountsPromise = null;
  function loadAccountCurrencies() {
    var known = accountCurrencies();
    if (known.length) return Promise.resolve(known);
    if (!accountsPromise) {
      accountsPromise = authFetch('/api/accounts')
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (d) {
          var arr = Array.isArray(d) ? d : (d && (d.all || d.data)) || [];
          return uniqueCurrencies(arr.map(function (a) { return a.currency; }));
        })
        .catch(function () { return []; });
    }
    return accountsPromise;
  }

  // ---------- delegated actions (no inline handlers -> CSP-safe) ----------
  var registry = {};
  var wired = false;

  function actions(map) {
    Object.keys(map || {}).forEach(function (k) { registry[k] = map[k]; });
    wire();
    return registry;
  }

  function run(name, el, e) {
    var fn = registry[name];
    if (typeof fn !== 'function') return false;
    try {
      var out = fn(el, e);
      if (out && typeof out.catch === 'function') out.catch(function (err) { console.error('[UI action ' + name + ']', err); });
    } catch (err) {
      console.error('[UI action ' + name + ']', err);
    }
    return true;
  }

  function onClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    if (el.tagName === 'A' || el.tagName === 'BUTTON' && el.closest('form')) e.preventDefault();
    if (el.hasAttribute('data-stop')) e.stopPropagation();
    run(el.dataset.action, el, e);
  }

  function onSubmit(e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches('form[data-submit]')) return;
    e.preventDefault();
    run(form.dataset.submit, form, e);
  }

  function onChange(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-change]') : null;
    if (!el) return;
    run(el.dataset.change, el, e);
  }

  function wire() {
    if (wired || !doc) return;
    wired = true;
    doc.addEventListener('click', onClick);
    doc.addEventListener('submit', onSubmit);
    doc.addEventListener('change', onChange);
    doc.addEventListener('keydown', onKeydown);
  }

  // ---------- modals ----------
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var openStack = []; // [{ el, prevFocus, onClose }]

  function resolve(target) {
    if (!target) return null;
    if (typeof target === 'string') return doc ? doc.getElementById(target) : null;
    return target;
  }

  function focusables(container) {
    var nodes = container.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.closest('[hidden]')) continue;
      out.push(n);
    }
    return out;
  }

  function entryFor(el) {
    for (var i = openStack.length - 1; i >= 0; i--) if (openStack[i].el === el) return openStack[i];
    return null;
  }

  function openModal(target, opts) {
    opts = opts || {};
    var el = resolve(target);
    if (!el) return null;
    if (entryFor(el)) return el;

    var dialog = el.classList.contains('modal') ? el : (el.querySelector('.modal') || el);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    var heading = dialog.querySelector('.modal-title, .modal-header h1, .modal-header h2, .modal-header h3');
    if (heading && !dialog.hasAttribute('aria-labelledby')) {
      if (!heading.id) heading.id = (el.id || 'modal') + '-title';
      dialog.setAttribute('aria-labelledby', heading.id);
    }

    el.removeAttribute('hidden');
    el.classList.add('is-open');
    el.removeAttribute('aria-hidden');
    if (doc && doc.body) doc.body.classList.add('fm-modal-open');

    var entry = { el: el, dialog: dialog, prevFocus: doc ? doc.activeElement : null, onClose: opts.onClose, staticBackdrop: !!opts.static };
    openStack.push(entry);

    if (opts.autoFocus !== false) {
      var f = focusables(dialog);
      var first = null;
      for (var i = 0; i < f.length; i++) { if (!f[i].classList.contains('modal-close')) { first = f[i]; break; } }
      (first || f[0] || dialog).focus();
    }
    return el;
  }

  function closeModal(target) {
    var el = resolve(target) || (openStack.length ? openStack[openStack.length - 1].el : null);
    if (!el) return;
    var entry = entryFor(el);
    if (entry) openStack.splice(openStack.indexOf(entry), 1);

    el.classList.remove('is-open');
    el.setAttribute('hidden', '');
    el.setAttribute('aria-hidden', 'true');
    if (doc && doc.body && !openStack.length) doc.body.classList.remove('fm-modal-open');

    if (entry && entry.prevFocus && typeof entry.prevFocus.focus === 'function') {
      try { entry.prevFocus.focus(); } catch (e) { /* ignore */ }
    }
    if (el.dataset && el.dataset.ephemeral === '1' && el.parentNode) el.parentNode.removeChild(el);
    if (entry && typeof entry.onClose === 'function') entry.onClose(el);
  }

  function closeTopModal() {
    if (openStack.length) closeModal(openStack[openStack.length - 1].el);
  }

  // Builds a modal from parts, appends it to <body>, opens it and removes it on close.
  function modal(spec) {
    spec = spec || {};
    if (!doc) return null;
    var host = doc.createElement('div');
    host.className = 'modal-backdrop';
    host.setAttribute('hidden', '');
    host.dataset.ephemeral = '1';
    if (spec.id) host.id = spec.id;
    host.innerHTML =
      '<div class="modal' + (spec.size === 'lg' ? ' modal-lg' : '') + '">' +
        '<div class="modal-header">' +
          '<h2 class="modal-title">' + (spec.rawTitle ? spec.title : esc(spec.title || '')) + '</h2>' +
          '<button type="button" class="modal-close" data-action="ui:close" aria-label="Закрыть">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' + (spec.body || '') + '</div>' +
        (spec.footer ? '<div class="modal-footer">' + spec.footer + '</div>' : '') +
      '</div>';
    doc.body.appendChild(host);
    openModal(host, { onClose: spec.onClose, static: spec.static });
    return host;
  }

  function onKeydown(e) {
    if (!openStack.length) return;
    var entry = openStack[openStack.length - 1];
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      closeModal(entry.el);
      return;
    }
    if (e.key !== 'Tab' && e.keyCode !== 9) return;
    var f = focusables(entry.dialog);
    if (!f.length) { e.preventDefault(); entry.dialog.focus(); return; }
    var first = f[0];
    var last = f[f.length - 1];
    var active = doc.activeElement;
    if (e.shiftKey) {
      if (active === first || !entry.dialog.contains(active)) { e.preventDefault(); last.focus(); }
    } else if (active === last || !entry.dialog.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  function onBackdropClick(e) {
    if (!openStack.length) return;
    var entry = openStack[openStack.length - 1];
    if (e.target === entry.el && !entry.staticBackdrop) closeModal(entry.el);
  }

  // ---------- empty state (same markup as the accounts page) ----------
  function emptyState(spec) {
    spec = spec || {};
    var action = '';
    if (spec.action) {
      action = '<button type="button" class="btn btn-primary" data-action="' + esc(spec.action.action) + '"' +
        (spec.action.id != null ? ' data-id="' + esc(spec.action.id) + '"' : '') + '>' +
        (spec.action.icon ? '<i class="fas ' + esc(spec.action.icon) + '"></i> ' : '') + esc(spec.action.label) + '</button>';
    }
    return '<div class="empty-state fm-empty">' +
      '<div class="empty-state-icon"><i class="fas ' + esc(spec.icon || 'fa-inbox') + '"></i></div>' +
      '<h2>' + esc(spec.title || '') + '</h2>' +
      (spec.text ? '<p>' + esc(spec.text) + '</p>' : '') +
      action +
      '</div>';
  }

  var api = {
    esc: esc,
    money: money,
    fmtNumber: fmtNumber,
    baseCurrency: baseCurrency,
    setBaseCurrency: setBaseCurrency,
    loadBaseCurrency: loadBaseCurrency,
    sumByCurrency: sumByCurrency,
    moneyList: moneyList,
    aggregateMoney: aggregateMoney,
    mixedCurrencyNote: mixedCurrencyNote,
    uniqueCurrencies: uniqueCurrencies,
    currencyOptions: currencyOptions,
    monthlyFactor: monthlyFactor,
    accountsArray: accountsArray,
    accountCurrencies: accountCurrencies,
    loadAccountCurrencies: loadAccountCurrencies,
    authFetch: authFetch,
    actions: actions,
    openModal: openModal,
    closeModal: closeModal,
    closeTopModal: closeTopModal,
    modal: modal,
    emptyState: emptyState,
    _openCount: function () { return openStack.length; }
  };

  // Built-in actions.
  registry['ui:close'] = function (el) { closeModal(el.closest('.modal-backdrop') || el.closest('.modal')); };
  registry['ui:navigate'] = function (el) { if (typeof root.navigateTo === 'function') root.navigateTo(el.dataset.page); };
  wire();
  if (doc) doc.addEventListener('click', onBackdropClick);

  root.UI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
