// ==================== EMPTY STATES ====================
// One markup for every "nothing here yet" screen: what the screen is for,
// why it is empty, one primary action (plus at most one secondary).
//
//   FMEmpty.html({
//     icon: 'fa-wallet', title, body, note, compact,
//     primary:   { label, id?, action?, do?, data?, icon? },
//     secondary: { label, id?, action?, do?, data?, icon?, ifNoTransactions? }
//   }) -> '<div class="empty-state fm-empty">…</div>'
//   FMEmpty.bind(root, { buttonId: handler }) -> wires click handlers by id
//   FMEmpty.hasTransactions() -> Promise<boolean|null> (null = unknown)
//
// A button can be wired three ways:
//   id      -> the caller wires it (or passes a handler map to bind());
//   action  -> data-action for the lib/ui.js delegated registry ('budgets:create');
//   do      -> a built-in handled here: 'import', 'add-account',
//              'add-transaction', 'nav:<page>', 'focus:<element id>'.
// A button with ifNoTransactions renders hidden and shows only when the user
// has no transactions yet (checked once, cached).
(function (root) {
  'use strict';

  var doc = root.document;

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Font Awesome class names only: 'fa-wallet', 'fa-file-import'.
  function iconClass(name) {
    var s = String(name || '');
    return /^fa-[a-z0-9-]+$/.test(s) ? s : 'fa-inbox';
  }

  function button(spec, cls) {
    if (!spec || !spec.label) return '';
    var attrs = ' type="button" class="' + cls + '"';
    if (spec.id) attrs += ' id="' + esc(spec.id) + '"';
    if (spec.action) attrs += ' data-action="' + esc(spec.action) + '"';
    if (spec.do) attrs += ' data-fm-do="' + esc(spec.do) + '"';
    if (spec.data && typeof spec.data === 'object') {
      Object.keys(spec.data).forEach(function (k) {
        if (/^[a-z][a-z0-9-]*$/.test(k)) attrs += ' data-' + k + '="' + esc(spec.data[k]) + '"';
      });
    }
    if (spec.ifNoTransactions) attrs += ' data-fm-if-no-tx hidden';
    var icon = spec.icon ? '<i class="fas ' + iconClass(spec.icon) + '" aria-hidden="true"></i> ' : '';
    return '<button' + attrs + '>' + icon + esc(spec.label) + '</button>';
  }

  function html(opts) {
    var o = opts || {};
    var actions = button(o.primary, 'btn btn-primary') + button(o.secondary, 'btn btn-outline');
    if (o.secondary && o.secondary.ifNoTransactions) scheduleReveal();
    return '<div class="empty-state fm-empty' + (o.compact ? ' fm-empty-compact' : '') + '">' +
      (o.icon !== false ? '<div class="fm-empty-icon" aria-hidden="true"><i class="fas ' + iconClass(o.icon) + '"></i></div>' : '') +
      '<h3 class="fm-empty-title">' + esc(o.title) + '</h3>' +
      (o.body ? '<p class="fm-empty-body">' + esc(o.body) + '</p>' : '') +
      (actions ? '<div class="fm-empty-actions">' + actions + '</div>' : '') +
      (o.note ? '<p class="fm-empty-note">' + esc(o.note) + '</p>' : '') +
      '</div>';
  }

  // ---- "does this user have any transactions?" (one cheap request, cached) ----
  var txCache = null; // { value, at }
  var txPending = null;
  var FALSE_TTL = 10000; // re-check soon after an import

  function hasTransactions() {
    if (txCache && (txCache.value || Date.now() - txCache.at < FALSE_TTL)) {
      return Promise.resolve(txCache.value);
    }
    if (txPending) return txPending;
    if (typeof root.fetchWithAuth !== 'function') return Promise.resolve(null);
    txPending = Promise.resolve()
      .then(function () { return root.fetchWithAuth('/api/transactions?limit=1&page=1'); })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (data == null) return null;
        var rows = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
        if (!rows) return null;
        txCache = { value: rows.length > 0, at: Date.now() };
        return txCache.value;
      })
      .catch(function () { return null; })
      .then(function (v) { txPending = null; return v; });
    return txPending;
  }

  function reveal(scope) {
    var base = scope || doc;
    if (!base || !base.querySelectorAll) return;
    var hidden = base.querySelectorAll('[data-fm-if-no-tx][hidden]');
    if (!hidden.length) return;
    hasTransactions().then(function (has) {
      if (has !== false) return;
      Array.prototype.forEach.call(hidden, function (el) { el.hidden = false; });
    });
  }

  // html() is usually assigned to innerHTML in the same tick: look right after.
  var revealQueued = false;
  function scheduleReveal() {
    if (revealQueued || !doc) return;
    revealQueued = true;
    setTimeout(function () { revealQueued = false; reveal(doc); }, 0);
  }

  // ---- built-in actions ----
  function call(name) {
    var fn = root[name];
    if (typeof fn !== 'function') return false;
    fn.apply(root, Array.prototype.slice.call(arguments, 1));
    return true;
  }

  function navigate(page) {
    if (!call('navigateTo', page) && root.location) root.location.assign('/' + page);
  }

  function runBuiltin(what) {
    var cmd = String(what || '');
    if (cmd === 'import') {
      if (!call('showImportWizard', {})) navigate('accounts');
    } else if (cmd === 'add-account') {
      if (!call('showAddAccountModal')) navigate('accounts');
    } else if (cmd === 'add-transaction') {
      if (!call('showAddTransactionModal')) navigate('transactions');
    } else if (cmd.indexOf('nav:') === 0) {
      navigate(cmd.slice(4));
    } else if (cmd.indexOf('focus:') === 0) {
      var el = doc.getElementById(cmd.slice(6));
      if (el) {
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.focus();
      }
    }
  }

  function onClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-fm-do]') : null;
    if (!el) return;
    e.preventDefault();
    try { runBuiltin(el.getAttribute('data-fm-do')); } catch (err) { console.error('[FMEmpty]', err); }
  }

  if (doc && doc.addEventListener) doc.addEventListener('click', onClick);

  // Wire id-based buttons inside root; also resolves ifNoTransactions buttons.
  function bind(rootEl, handlers) {
    var scope = rootEl || doc;
    if (!scope) return;
    Object.keys(handlers || {}).forEach(function (id) {
      var fn = handlers[id];
      if (typeof fn !== 'function') return;
      var el = scope.querySelector ? scope.querySelector('#' + (root.CSS && root.CSS.escape ? root.CSS.escape(id) : id)) : null;
      if (el) el.addEventListener('click', function (e) { e.preventDefault(); fn(e); });
    });
    reveal(scope);
  }

  var api = { html: html, bind: bind, hasTransactions: hasTransactions, _esc: esc };
  root.FMEmpty = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
