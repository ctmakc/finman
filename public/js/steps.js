// public/js/steps.js — «First steps» on Home (STATEMENT DESK, 24.11.2026).
//
// Owner, 23.11: after signing in nothing was clear; he wants a dashboard with first steps
// that leads him by the hand. The rail sits in the right column of Home (first on a phone):
//
//   1. Look around the example   — done as soon as the example (demo household) or own data is in
//   2. Add your first money      — ONE step: a 3-field inline form (amount, what, in/out) that
//                                  creates an everyday account when needed, or a bank file
//   3. Protect your data         — only while window.FMVault.protectionPending() says so
//                                  (vault quiet start: the key was made silently on first sign-in)
//   4. See where it went         — Money map (ticks on the first visit)
//   5. Make it yours             — hide the example (never mixed silently with own data) / a budget
//
// The current step is open: one sentence and one button. Done steps collapse with a drawn check.
// Events (OpenPanel via FirstRun.track → FMTrack.beacon('onboarding_<event>')):
//   steps_shown {done,total,current}, step_clicked {step}, first_entry {kind}, example_hidden {from}.
(function () {
  'use strict';

  var CHECK = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.3l2.3 2.2 4.7-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return (typeof appState !== 'undefined' && appState.user && appState.user.id) || 'anon'; }
  function flag(k) { try { return localStorage.getItem('sd_' + k + '_' + uid()) === '1'; } catch (_) { return false; } }
  function setFlag(k) { try { localStorage.setItem('sd_' + k + '_' + uid(), '1'); } catch (_) { /* private mode */ } }
  function track(event, props) {
    try { if (window.FirstRun && typeof window.FirstRun.track === 'function') window.FirstRun.track(event, props || {}); } catch (_) { /* never blocks */ }
  }
  function base() { return (typeof appState !== 'undefined' && appState.baseCurrency) || 'CAD'; }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function api(url, options) {
    var res = await fetchWithAuth(url, options || {});
    var body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      var err = new Error((body && (body.message || (body.error && body.error.message))) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
  }

  // ---------------------------------------------------------------- the list
  async function build(st) {
    st = st || {};
    var own = Number(st.ownTransactions) > 0;
    var demo = Boolean(st.demo);
    var protect = null;
    if (own && window.FMVault && typeof window.FMVault.protectionPending === 'function') {
      try { protect = await window.FMVault.protectionPending(); } catch (_) { protect = null; }
    }
    var list = [
      { key: 'example', title: 'Look around the example', done: demo || own || flag('example'),
        body: 'A sample household shows what Finman does with a month of transactions. None of it is your money.' },
      { key: 'own', title: 'Add your first money', done: own,
        body: 'One entry is enough to start. Type it in, or bring a bank file for months at once.' },
    ];
    if (protect) {
      list.push({ key: 'protect', title: 'Protect your data', done: false,
        body: 'Add a passkey (Face ID, fingerprint or your Google account) or a vault password, so your records open on your other devices and survive a cleared browser.' });
    }
    list.push({ key: 'map', title: 'See where it went', done: flag('map'),
      body: 'Money map lays out what came in and where it went, by category.' });
    list.push({ key: 'yours', title: 'Make it yours', done: own && !demo && (flag('budget') || flag('yours')),
      body: demo ? 'Hide the example so only your own money is on screen.' : 'Give your biggest category a monthly budget.' });
    // Owner 23.11: until protection is set, say plainly that the records live only in this browser.
    return { list: list, own: own, demo: demo, deviceOnly: Boolean(protect && protect.password) };
  }

  function quickFormHtml() {
    return '<form class="sd-quick" id="sd-quick" novalidate>' +
      '<div class="sd-quick-kind" role="group" aria-label="Money in or out">' +
        '<button type="button" data-kind="expense" aria-pressed="true">Spent</button>' +
        '<button type="button" data-kind="income" aria-pressed="false">Received</button>' +
      '</div>' +
      '<label>Amount<input type="number" inputmode="decimal" step="0.01" min="0" id="sd-quick-amount" required placeholder="0.00"></label>' +
      '<label>Date<input type="date" id="sd-quick-date" value="' + today() + '"></label>' +
      '<label class="sd-quick-what">What was it<input type="text" id="sd-quick-what" maxlength="120" placeholder="Groceries at Loblaws"></label>' +
      '<p class="sd-quick-err" id="sd-quick-err" role="alert" hidden></p>' +
      '<button type="submit" class="btn btn-primary" id="sd-quick-save">Save my first entry</button>' +
    '</form>' +
    '<p class="sd-step-or">or <button type="button" class="sd-linkbtn" id="sd-import">import a bank file (CSV, OFX, PDF)</button></p>';
  }

  function actionsHtml(step, ctx) {
    switch (step.key) {
      case 'example':
        return '<div class="sd-step-actions"><button type="button" class="btn btn-primary btn-sm" data-sd="load-example">Show the example</button></div>';
      case 'own':
        return quickFormHtml();
      case 'protect':
        return '<div class="sd-step-actions"><button type="button" class="btn btn-primary btn-sm" data-sd="protect">Protect my data</button></div>';
      case 'map':
        return '<div class="sd-step-actions"><button type="button" class="btn btn-primary btn-sm" data-sd="map">Open Money map</button></div>';
      case 'yours':
        return ctx.demo
          ? '<div class="sd-step-actions"><button type="button" class="btn btn-primary btn-sm" data-sd="hide-example">Hide the example</button></div>'
          : '<div class="sd-step-actions"><button type="button" class="btn btn-primary btn-sm" data-sd="budget">Set a budget</button></div>';
      default:
        return '';
    }
  }

  function html(ctx, mixed) {
    var list = ctx.list;
    var done = list.filter(function (s) { return s.done; }).length;
    var current = list.filter(function (s) { return !s.done; })[0] || null;
    var pct = Math.round(done / list.length * 100);
    return '<section class="sd-card sd-steps" id="sd-steps" aria-labelledby="sd-steps-h">' +
      '<div class="sd-steps-head"><h2 id="sd-steps-h">First steps</h2><span class="sd-steps-count">' + done + ' of ' + list.length + ' done</span></div>' +
      '<div class="sd-steps-bar" aria-hidden="true"><span style="--p:' + pct + '%"></span></div>' +
      (ctx.deviceOnly ? '<div class="sd-deviceonly" role="note"><i class="fas fa-laptop" aria-hidden="true"></i><span>Your records are only in this browser for now. ' +
        'Protect them to open Finman on another device and keep them if this browser is cleared.</span>' +
        '<button type="button" class="btn btn-outline btn-sm" data-sd="protect">Protect now</button></div>' : '') +
      (mixed ? '<div class="sd-mix" role="status"><span>Your first entry is saved. The example household is still on screen next to it.</span>' +
        '<div><button type="button" class="btn btn-primary btn-sm" data-sd="hide-example">Hide the example</button>' +
        '<button type="button" class="btn btn-outline btn-sm" data-sd="keep-example">Keep it for now</button></div></div>' : '') +
      '<ol>' + list.map(function (s, i) {
        var cls = s.done ? ' is-done' : (s === current ? ' is-current' : '');
        return '<li class="sd-step' + cls + '" data-step="' + s.key + '">' +
          '<span class="sd-step-mark" aria-hidden="true">' + (s.done ? CHECK : (i + 1)) + '</span>' +
          '<span class="sd-step-title">' + esc(s.title) + (s.done ? '<span class="sr-only"> (done)</span>' : '') + '</span>' +
          (s === current ? '<p class="sd-step-body">' + esc(s.body) + '</p>' + actionsHtml(s, ctx) : '') +
        '</li>';
      }).join('') + '</ol>' +
      (current ? '' : '<p class="sd-step-body sd-steps-all">All set. Finman will keep your month on this screen.</p>') +
    '</section>';
  }

  // ---------------------------------------------------------------- actions
  async function ownAccountId() {
    var all = (typeof appState !== 'undefined' && Array.isArray(appState.accounts)) ? appState.accounts : [];
    var own = all.filter(function (a) { return !a.is_demo && a.is_active !== 0 && a.account_type !== 'investment'; });
    if (own.length) return own[0].id;
    var a = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'Everyday account', currency: base(), balance: 0, accountType: 'checking' }) });
    var acc = (a && (a.account || a.data)) || a;
    if (typeof fetchAccounts === 'function') await fetchAccounts();
    return acc && acc.id;
  }

  async function saveQuick(root, ctx) {
    var err = root.querySelector('#sd-quick-err');
    var btn = root.querySelector('#sd-quick-save');
    var amt = parseFloat(String(root.querySelector('#sd-quick-amount').value).replace(',', '.'));
    var what = String(root.querySelector('#sd-quick-what').value || '').trim();
    var date = root.querySelector('#sd-quick-date').value || today();
    var kindBtn = root.querySelector('.sd-quick-kind [aria-pressed="true"]');
    var kind = kindBtn ? kindBtn.dataset.kind : 'expense';
    err.hidden = true;
    if (!Number.isFinite(amt) || amt <= 0) { err.textContent = 'Enter the amount, for example 42.50.'; err.hidden = false; root.querySelector('#sd-quick-amount').focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      var accountId = await ownAccountId();
      if (!accountId) throw new Error('Could not create your account. Try again.');
      await api('/api/transactions', { method: 'POST', body: JSON.stringify({
        accountId: accountId, type: kind, amount: kind === 'expense' ? -Math.abs(amt) : Math.abs(amt), date: date,
        description: what || (kind === 'income' ? 'Money received' : 'Spending'),
        category: kind === 'income' ? 'Income' : 'Other',
      }) });
      if (typeof fetchAccounts === 'function') await fetchAccounts();
      track('first_entry', { kind: kind, demo: ctx.demo });
      if (typeof showNotification === 'function') showNotification('Saved. That is your first entry in Finman.', 'success');
      if (ctx.demo) try { sessionStorage.setItem('sd_mixed', '1'); } catch (_) { /* ignore */ }
      navigateTo('dashboard', { replace: true });
    } catch (e) {
      err.textContent = (e && e.message) || 'Could not save. Try again.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Save my first entry';
    }
  }

  async function hideExample(from) {
    try {
      await api('/api/onboarding/demo', { method: 'DELETE' });
      if (typeof fetchAccounts === 'function') await fetchAccounts();
      setFlag('yours');
      track('example_hidden', { from: from });
      if (typeof showNotification === 'function') showNotification('The example is gone. Only your own money is on screen now.', 'success');
    } catch (e) {
      if (typeof showNotification === 'function') showNotification((e && e.message) || 'Could not hide the example', 'error');
    }
    try { sessionStorage.removeItem('sd_mixed'); } catch (_) { /* ignore */ }
    navigateTo('dashboard', { replace: true });
  }

  function bind(root, ctx) {
    var form = root.querySelector('#sd-quick');
    if (form) {
      form.querySelectorAll('.sd-quick-kind button').forEach(function (b) {
        b.addEventListener('click', function () {
          form.querySelectorAll('.sd-quick-kind button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        });
      });
      form.addEventListener('submit', function (e) { e.preventDefault(); saveQuick(root, ctx); });
    }
    var imp = root.querySelector('#sd-import');
    if (imp) imp.addEventListener('click', function () {
      track('step_clicked', { step: 'import' });
      if (typeof showImportWizard === 'function') showImportWizard({});
      else navigateTo('transactions');
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sd]');
      if (!b) return;
      var what = b.getAttribute('data-sd');
      track('step_clicked', { step: what });
      if (what === 'map') { setFlag('map'); navigateTo('money-map'); }
      else if (what === 'budget') { setFlag('budget'); navigateTo('budgets'); }
      else if (what === 'hide-example') { b.disabled = true; hideExample(b.closest('.sd-mix') ? 'after_first_entry' : 'step'); }
      else if (what === 'keep-example') { try { sessionStorage.removeItem('sd_mixed'); } catch (_) { /* ignore */ } var m = root.querySelector('.sd-mix'); if (m) m.remove(); }
      else if (what === 'protect') {
        if (window.FMVault && typeof window.FMVault.protect === 'function') {
          Promise.resolve(window.FMVault.protect()).then(function () { navigateTo('dashboard', { replace: true }); });
        }
      } else if (what === 'load-example') {
        b.disabled = true;
        if (window.FirstRun && typeof window.FirstRun.quietDemo === 'function') {
          window.FirstRun.quietDemo().then(function () { navigateTo('dashboard', { replace: true }); });
        }
      }
    });
  }

  // Paints the rail into `holder` (Home's side column). state = GET /api/onboarding/state.
  async function render(holder, state) {
    if (!holder) return;
    var ctx = await build(state);
    var mixed = false;
    try { mixed = ctx.own && ctx.demo && sessionStorage.getItem('sd_mixed') === '1'; } catch (_) { mixed = false; }
    // Everything done and nothing to say: the rail steps aside.
    var allDone = ctx.list.every(function (s) { return s.done; });
    if (allDone && flag('steps_seen_done')) { holder.innerHTML = ''; return; }
    holder.innerHTML = html(ctx, mixed);
    if (allDone) setFlag('steps_seen_done');
    bind(holder, ctx);
    var cur = ctx.list.filter(function (s) { return !s.done; })[0];
    if (Date.now() - (window.__sdStepsShownAt || 0) > 10 * 60 * 1000) {
      window.__sdStepsShownAt = Date.now();
      track('steps_shown', { done: ctx.list.length - ctx.list.filter(function (s) { return !s.done; }).length, total: ctx.list.length, current: cur ? cur.key : 'none' });
    }
  }

  // Called by navigateTo: the Money map step ticks on the first visit, wherever it comes from.
  function visited(page) { if (page === 'money-map') setFlag('map'); if (page === 'budgets') setFlag('budget'); }

  window.FMSteps = { render: render, visited: visited, _build: build };
})();
