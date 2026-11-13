// public/js/firstrun.js — the first minute of a new account.
//
// A brand-new user used to land on a $0 dashboard with a made-up AI line and a
// wizard whose steps went nowhere; most left within three minutes. Now the
// empty dashboard is a start screen with one job: show the person their own
// money as fast as possible.
//
//   1. Import a bank statement (CSV / OFX / QFX) — primary. Drop the file, we
//      read it, create the account, import every valid row and open the
//      "what we found" summary: period, income vs spending, top categories,
//      recurring charges, biggest expenses, questions for the AI CFO.
//   2. Explore with demo data — a tagged sample household, removable in one click.
//   3. Start from scratch — an empty account and the manual "Add transaction".
//
// Also: the email-confirmation banner (password sign-ups) and the result of
// opening the confirmation link (?email_verified=1|0).
//
// Analytics: every step emits `fm:onboarding` (CustomEvent on window, detail
// { event, ...props }) and, when PostHog is on the page, posthog.capture().
// Events: firstrun_shown, import_started, import_failed, import_done,
// demo_loaded, demo_removed, scratch_started, insight_shown, ai_question,
// verify_resent, email_verified.
//
// Backend: GET /api/onboarding/state, POST|DELETE /api/onboarding/demo,
// GET /api/onboarding/insight, POST /api/auth/verify-email/send,
// POST /api/bank-api/import/preview|commit (bank-api.js helpers).

(function () {
  'use strict';

  var SKIP_KEY = 'fm_firstrun_skip';
  var startedAt = 0;

  // ?email_verified=1|0 from the link in the letter — read before the router
  // rewrites the URL.
  var verifyResult = null;
  try {
    var qs = new URLSearchParams(window.location.search);
    if (qs.has('email_verified')) {
      verifyResult = qs.get('email_verified') === '1' ? 'ok' : 'bad';
      qs.delete('email_verified');
      var rest = qs.toString();
      window.history.replaceState({}, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
    }
  } catch (_) { /* old browser */ }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(v, cur) {
    if (typeof fmFormatCurrency === 'function') return fmFormatCurrency(v, cur);
    return (Number(v) || 0).toFixed(2) + ' ' + (cur || '');
  }

  // Whole units for headline figures (no cents noise on the summary).
  function money0(v, cur) {
    try {
      return new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur || 'CAD', maximumFractionDigits: 0 }).format(Number(v) || 0);
    } catch (_) {
      return money(v, cur);
    }
  }

  // "Aug 15 – Nov 12, 2026" (one year) or "Dec 3, 2025 – Feb 1, 2026".
  function fmtRange(from, to) {
    if (!from || !to) return fmtDate(from || to);
    var a = new Date(from + 'T12:00:00');
    var b = new Date(to + 'T12:00:00');
    if (a.getFullYear() === b.getFullYear()) {
      return a.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' \u2013 ' + fmtDate(to);
    }
    return fmtDate(from) + ' \u2013 ' + fmtDate(to);
  }

  function num(n) {
    return new Intl.NumberFormat('en-CA').format(Number(n) || 0);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function userKey() {
    var u = (typeof appState !== 'undefined' && appState.user) || {};
    return SKIP_KEY + ':' + (u.id || u.username || '');
  }

  function track(event, props) {
    var detail = Object.assign({ event: event }, props || {});
    try { window.dispatchEvent(new CustomEvent('fm:onboarding', { detail: detail })); } catch (_) {}
    try {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        window.posthog.capture('onboarding_' + event, props || {});
      }
    } catch (_) {}
  }

  async function api(url, options) {
    var res = await fetchWithAuth(url, options || {});
    var body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      var msg = (body && (body.message || (body.error && body.error.message))) || ('Request failed (HTTP ' + res.status + ')');
      var err = new Error(msg);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('Retry-After')) || null;
      throw err;
    }
    return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
  }

  function firstName() {
    var u = (typeof appState !== 'undefined' && appState.user) || {};
    var n = String(u.full_name || u.fullName || '').trim().split(/\s+/)[0];
    return n || '';
  }

  // ---------------------------------------------------------------- start screen

  var BANKS = 'RBC, TD, CIBC, Scotiabank, BMO, Tangerine, Wealthsimple, EQ Bank, Revolut, Wise, Monobank';

  function startHtml() {
    var name = firstName();
    return '' +
      '<section class="fr" aria-labelledby="fr-title">' +
        '<header class="fr-head">' +
          '<p class="fr-eyebrow">' + (name ? 'Welcome, ' + esc(name) : 'Welcome to Finman') + ' · step 1 of 1</p>' +
          '<h1 id="fr-title" class="fr-title">See where your money went, in under a minute.</h1>' +
          '<p class="fr-lede">Drop a statement you downloaded from online banking. Finman sorts every transaction into categories, finds your recurring charges and lets the AI CFO answer questions about your own numbers.</p>' +
        '</header>' +
        '<div class="fr-grid">' +
          '<div class="fr-import">' +
            '<label class="fr-drop" id="fr-drop" for="fr-file">' +
              '<input type="file" id="fr-file" class="fr-file" accept=".csv,.ofx,.qfx,.qbo,.txt,text/csv">' +
              '<span class="fr-drop-mark" aria-hidden="true"><i class="fas fa-file-arrow-up"></i></span>' +
              '<span class="fr-drop-title">Import a bank statement</span>' +
              '<span class="fr-drop-sub">Drop a CSV, OFX or QFX file here, or <u>choose a file</u></span>' +
              '<span class="fr-drop-rule" aria-hidden="true"></span>' +
              '<span class="fr-drop-banks">Recognised automatically: ' + esc(BANKS) + '. Other banks work too: you confirm which column is which.</span>' +
            '</label>' +
            '<div class="fr-progress" id="fr-progress" hidden role="status" aria-live="polite">' +
              '<span class="fr-progress-line" aria-hidden="true"></span>' +
              '<span class="fr-progress-text" id="fr-progress-text">Reading the file…</span>' +
            '</div>' +
            '<p class="fr-error" id="fr-error" role="alert" hidden></p>' +
            '<details class="fr-how">' +
              '<summary>Where do I get the file?</summary>' +
              '<ol>' +
                '<li>Sign in to your bank’s website on a computer (most banking apps cannot export).</li>' +
                '<li>Open the account, then find <b>Download transactions</b> or <b>Export</b> (often next to the date filter).</li>' +
                '<li>Pick the last 3 to 12 months and the <b>CSV</b>, <b>Quicken (QFX)</b> or <b>Money (OFX)</b> format.</li>' +
                '<li>Drop the downloaded file above. One file is one account; repeat for a credit card.</li>' +
              '</ol>' +
            '</details>' +
            '<p class="fr-privacy"><i class="fas fa-lock" aria-hidden="true"></i> Nothing connects to your bank. The file is read once, only the transactions are kept, and they stay in your account.</p>' +
          '</div>' +
          '<aside class="fr-alt" aria-label="Other ways to start">' +
            '<div class="fr-alt-row">' +
              '<h2 class="fr-alt-title">No file at hand?</h2>' +
              '<p class="fr-alt-text">Open a sample household with 90 days of everyday Canadian spending and see every screen working. One click removes it.</p>' +
              '<button type="button" class="btn btn-outline fr-btn" id="fr-demo">Explore with demo data</button>' +
            '</div>' +
            '<div class="fr-alt-row">' +
              '<h2 class="fr-alt-title">Rather type it in?</h2>' +
              '<p class="fr-alt-text">Start with an empty account and add transactions by hand or from a receipt photo.</p>' +
              '<button type="button" class="btn btn-outline fr-btn" id="fr-scratch">Start from scratch</button>' +
            '</div>' +
          '</aside>' +
        '</div>' +
      '</section>';
  }

  function renderStart(main) {
    main.innerHTML = verifyBannerHtml() + startHtml();
    bindVerifyBanner(main);
    startedAt = Date.now();
    track('firstrun_shown', { emailVerified: FR.state ? FR.state.emailVerified : null });

    var drop = document.getElementById('fr-drop');
    var input = document.getElementById('fr-file');
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) importFile(input.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });
    document.getElementById('fr-demo').addEventListener('click', loadDemo);
    document.getElementById('fr-scratch').addEventListener('click', startScratch);
  }

  function setBusy(text) {
    var p = document.getElementById('fr-progress');
    var d = document.getElementById('fr-drop');
    var e = document.getElementById('fr-error');
    if (!p) return;
    if (text) {
      p.hidden = false;
      document.getElementById('fr-progress-text').textContent = text;
      if (d) d.classList.add('is-busy');
      if (e) e.hidden = true;
    } else {
      p.hidden = true;
      if (d) d.classList.remove('is-busy');
    }
    document.querySelectorAll('.fr-btn').forEach(function (b) { b.disabled = Boolean(text); });
  }

  function showError(message, withWizard) {
    setBusy(null);
    var e = document.getElementById('fr-error');
    if (!e) { if (typeof showNotification === 'function') showNotification(message, 'error'); return; }
    e.hidden = false;
    e.innerHTML = esc(message) + (withWizard ? ' <button type="button" class="btn btn-sm btn-outline" id="fr-wizard">Map the columns by hand</button>' : '');
    var w = document.getElementById('fr-wizard');
    if (w) w.addEventListener('click', function () { if (typeof showImportWizard === 'function') showImportWizard({}); });
  }

  function bankLabel(preview) {
    if (preview.preset && preview.preset.name) return preview.preset.name.replace(/\s*\(.*\)\s*$/, '');
    if (preview.kind === 'ofx' && preview.accounts && preview.accounts[0]) {
      var a = preview.accounts[0];
      var tail = a.accountId ? ' ····' + String(a.accountId).slice(-4) : '';
      return (a.accountType === 'CREDITLINE' || a.accountType === 'CREDITCARD' ? 'Credit card' : 'Bank account') + tail;
    }
    return 'Imported account';
  }

  // Import target: a fresh account named after the bank. A brand-new user who
  // pressed the old "quick start" has one empty account; that one is reused.
  async function targetAccount(preview) {
    var all = (typeof appState !== 'undefined' && Array.isArray(appState.accounts)) ? appState.accounts : [];
    var own = all.filter(function (a) { return !a.is_demo; });
    if (own.length === 1 && FR.state && FR.state.ownTransactions === 0) return own[0];
    var cur = (preview.accounts && preview.accounts[0] && preview.accounts[0].currency) ||
      (typeof appState !== 'undefined' && appState.baseCurrency) || 'CAD';
    var type = preview.kind === 'ofx' && preview.accounts && preview.accounts[0] &&
      /CREDIT/.test(String(preview.accounts[0].accountType || '')) ? 'credit' : 'checking';
    var res = await fetchWithAuth('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: bankLabel(preview), bankName: bankLabel(preview), currency: String(cur).toUpperCase(), balance: 0, accountType: type })
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.message || 'Could not create the account');
    return body;
  }

  async function importFile(file) {
    var t0 = Date.now();
    track('import_started', { kind: /\.(ofx|qfx|qbo)$/i.test(file.name) ? 'ofx' : 'csv', sizeKb: Math.round(file.size / 1024) });
    if (file.size > 10 * 1024 * 1024) { showError('This file is larger than 10 MB. Export a shorter period (3 to 12 months).'); return; }
    setBusy('Reading ' + file.name + '…');
    var preview;
    try {
      preview = await previewStatementFile(file, {});
    } catch (err) {
      track('import_failed', { stage: 'preview', message: String(err && err.message || '').slice(0, 120) });
      showError((err && err.message) || 'Could not read this file.', true);
      return;
    }
    var rows = (preview.rows || []).filter(function (r) { return !r.error && !r.skipped && !r.duplicate; });
    if (!rows.length) {
      track('import_failed', { stage: 'rows', total: (preview.rows || []).length });
      showError('We could not find dated amounts in this file. Check that it is a transaction export, or map the columns by hand.', true);
      return;
    }
    setBusy('Found ' + num(rows.length) + ' transactions. Sorting them into categories…');
    try {
      var account = await targetAccount(preview);
      var payload = rows.map(function (r) {
        return { date: r.date, description: r.description, amount: r.amount, category: r.category, type: r.type };
      });
      var result = await commitStatementImport(account.id, payload, { updateBalance: true, skipDuplicates: true });
      if (typeof fetchAccounts === 'function') await fetchAccounts();
      var secs = Math.round((Date.now() - t0) / 1000);
      track('import_done', {
        rows: result.inserted, skipped: result.skipped || 0, seconds: secs,
        sinceStart: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
        detected: Boolean(preview.preset), kind: preview.kind || 'csv'
      });
      setBusy('Imported ' + num(result.inserted) + ' transactions. Building your summary…');
      await showInsight({ accountId: account.id, accountName: account.name, source: 'import', imported: result.inserted, truncated: preview.truncated || 0 });
    } catch (err) {
      track('import_failed', { stage: 'commit', message: String(err && err.message || '').slice(0, 120) });
      showError((err && err.message) || 'Import failed.', true);
    }
  }

  async function loadDemo() {
    setBusy('Loading the sample household…');
    try {
      var cur = (typeof appState !== 'undefined' && appState.baseCurrency) || 'CAD';
      var r = await api('/api/onboarding/demo', { method: 'POST', body: JSON.stringify({ currency: cur }) });
      if (typeof fetchAccounts === 'function') await fetchAccounts();
      track('demo_loaded', { rows: r.transactions, sinceStart: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null });
      await showInsight({ demo: true, source: 'demo', accountName: 'the sample household' });
    } catch (err) {
      showError((err && err.message) || 'Could not load the demo data.');
    }
  }

  async function startScratch() {
    setBusy('Creating your account…');
    try {
      await api('/api/onboarding/quickstart', { method: 'POST', body: JSON.stringify({ currency: (typeof appState !== 'undefined' && appState.baseCurrency) || undefined }) });
      if (typeof fetchAccounts === 'function') await fetchAccounts();
    } catch (_) { /* the account may already exist — carry on */ }
    try { localStorage.setItem(userKey(), '1'); } catch (_) {}
    track('scratch_started', {});
    navigateTo('dashboard', { replace: true });
    setTimeout(function () { if (typeof showAddTransactionModal === 'function') showAddTransactionModal(); }, 400);
  }

  // ---------------------------------------------------------------- insight

  var CYCLE = { weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly' };

  function chips(ins) {
    var q = [];
    var top = ins.topCategories && ins.topCategories[0];
    if (ins.recurring && ins.recurring.length) q.push('Which of my recurring charges could I cancel?');
    if (top) q.push('How can I spend less on ' + top.name + '?');
    q.push('Where can I cut $200 a month?');
    q.push('How much can I safely save each month?');
    return q.slice(0, 4);
  }

  function insightHtml(ins, opts) {
    var cur = ins.currency;
    var head;
    if (opts.source === 'demo') {
      head = 'Demo data · a sample household';
    } else {
      head = 'Imported ' + num(opts.imported != null ? opts.imported : ins.count) + ' transactions into ' + esc(opts.accountName || 'your account');
    }
    var top = ins.topCategories && ins.topCategories[0];
    var lede = 'On average ' + (opts.source === 'demo' ? 'this household' : 'you') + ' spent <b>' + esc(money0(ins.monthlyExpense, cur)) + '</b> a month';
    if (ins.monthlyIncome > 0) lede += ' and brought in <b>' + esc(money0(ins.monthlyIncome, cur)) + '</b>';
    lede += '.';
    if (top) lede += ' ' + esc(top.name) + ' is the biggest line at ' + esc(String(top.share)) + '% of spending.';
    if (ins.recurringMonthly > 0) lede += ' Recurring charges add up to <b>' + esc(money0(ins.recurringMonthly, cur)) + '</b> a month.';

    var max = ins.topCategories && ins.topCategories.length ? ins.topCategories[0].total : 0;
    var cats = (ins.topCategories || []).map(function (c, i) {
      var w = max > 0 ? Math.max(2, Math.round((c.total / max) * 100)) : 0;
      return '<li class="fri-cat" style="--i:' + i + '">' +
        '<span class="fri-cat-name">' + esc(c.name) + '</span>' +
        '<span class="fri-cat-bar" aria-hidden="true"><span style="--w:' + w + '%"></span></span>' +
        '<span class="fri-cat-fig">' + esc(money0(c.monthly, cur)) + '<small>/mo</small></span>' +
        '<span class="fri-cat-share">' + esc(String(c.share)) + '%</span>' +
      '</li>';
    }).join('');

    var rec = (ins.recurring || []).map(function (r, i) {
      return '<li class="fri-rec" style="--i:' + i + '">' +
        '<span class="fri-rec-name">' + esc(r.name) + '</span>' +
        '<span class="fri-rec-cycle">' + esc(CYCLE[r.cycle] || r.cycle) + '</span>' +
        '<span class="fri-rec-fig">' + esc(money(r.amount, cur)) + '</span>' +
      '</li>';
    }).join('') || '<li class="fri-empty">No charges repeat on a regular schedule in this period.</li>';

    var big = (ins.biggest || []).map(function (b) {
      return '<li class="fri-rec"><span class="fri-rec-name">' + esc(b.description) + '</span>' +
        '<span class="fri-rec-cycle">' + esc(fmtDate(b.date)) + '</span>' +
        '<span class="fri-rec-fig">' + esc(money(b.amount, cur)) + '</span></li>';
    }).join('');

    var otherNote = ins.uncategorizedShare >= 15
      ? '<p class="fri-note">' + esc(String(ins.uncategorizedShare)) + '% of spending has no clear category yet. <button type="button" class="fri-link" id="fri-sort">Let the AI CFO sort it</button></p>'
      : '';

    var multi = ins.otherCurrencies && ins.otherCurrencies.length
      ? '<p class="fri-note">Totals are in ' + esc(cur) + '; rows in ' + esc(ins.otherCurrencies.join(', ')) + ' are listed separately on the dashboard.</p>'
      : '';
    var trunc = opts.truncated ? '<p class="fri-note">The file holds ' + num(opts.truncated) + ' rows; the first 2,000 were imported. Export the rest as a second file.</p>' : '';

    return '' +
      '<section class="fri" aria-labelledby="fri-title">' +
        '<header class="fri-head">' +
          '<p class="fr-eyebrow">' + head + '</p>' +
          '<h1 id="fri-title" class="fr-title">Your money, <span class="fri-range">' + esc(fmtRange(ins.from, ins.to)) + '</span></h1>' +
          '<p class="fri-lede">' + lede + '</p>' +
        '</header>' +
        '<dl class="fri-soundings">' +
          '<div><dt>Money in</dt><dd class="pos">' + esc(money0(ins.income, cur)) + '</dd></div>' +
          '<div><dt>Spending</dt><dd class="neg">' + esc(money0(ins.expense, cur)) + '</dd></div>' +
          '<div><dt>Net</dt><dd>' + (ins.net < 0 ? '−' : '') + esc(money0(Math.abs(ins.net), cur)) + '</dd></div>' +
          '<div><dt>Transactions</dt><dd>' + num(ins.count) + '</dd></div>' +
        '</dl>' +
        '<div class="fri-cols">' +
          '<section class="fri-block" aria-labelledby="fri-cats-h">' +
            '<h2 id="fri-cats-h" class="fri-h">Where it goes <span>monthly average</span></h2>' +
            '<ol class="fri-cats">' + cats + '</ol>' +
            otherNote + multi + trunc +
            (big ? '<h2 class="fri-h fri-h-2">Biggest one-off expenses</h2><ul class="fri-recs">' + big + '</ul>' : '') +
          '</section>' +
          '<section class="fri-block" aria-labelledby="fri-rec-h">' +
            '<h2 id="fri-rec-h" class="fri-h">Recurring charges' + (ins.recurringMonthly > 0 ? ' <span>' + esc(money0(ins.recurringMonthly, cur)) + ' a month</span>' : '') + '</h2>' +
            '<ul class="fri-recs">' + rec + '</ul>' +
          '</section>' +
        '</div>' +
        '<section class="fri-ask" aria-labelledby="fri-ask-h">' +
          '<h2 id="fri-ask-h" class="fri-h">Ask the AI CFO about these numbers</h2>' +
          '<div class="fri-chips">' + chips(ins).map(function (q) {
            return '<button type="button" class="fri-chip" data-q="' + esc(q) + '">' + esc(q) + '</button>';
          }).join('') + '</div>' +
        '</section>' +
        '<div class="fri-actions">' +
          '<button type="button" class="btn btn-primary" id="fri-dash">Open my dashboard</button>' +
          (opts.source === 'demo'
            ? '<button type="button" class="btn btn-outline" id="fri-import">Import my own statement</button>' +
              '<button type="button" class="fri-link" id="fri-remove-demo">Remove demo data</button>'
            : '<button type="button" class="btn btn-outline" id="fri-import">Import another account</button>') +
        '</div>' +
      '</section>';
  }

  async function showInsight(opts) {
    var q = opts.demo ? '?demo=1' : (opts.accountId ? '?accountId=' + encodeURIComponent(opts.accountId) : '');
    var ins = await api('/api/onboarding/insight' + q);
    var main = document.getElementById('main-content');
    if (!main) return;
    if (!ins || !ins.count) {
      navigateTo('dashboard', { replace: true });
      return;
    }
    main.innerHTML = insightHtml(ins, opts);
    window.scrollTo(0, 0);
    track('insight_shown', {
      source: opts.source, rows: ins.count, categories: ins.categoryCount, recurring: (ins.recurring || []).length,
      sinceStart: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null
    });
    try { FR.state = null; } catch (_) {}

    main.querySelectorAll('.fri-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        track('ai_question', { source: opts.source, q: b.dataset.q });
        askAi(b.dataset.q);
      });
    });
    var sort = document.getElementById('fri-sort');
    if (sort) sort.addEventListener('click', function () { track('ai_question', { source: opts.source, q: 'categorize' }); navigateTo('ai'); });
    document.getElementById('fri-dash').addEventListener('click', function () { navigateTo('dashboard'); });
    document.getElementById('fri-import').addEventListener('click', function () {
      if (opts.source === 'demo') {
        removeDemo().then(function () { navigateTo('dashboard', { replace: true }); });
      } else if (typeof showImportWizard === 'function') {
        showImportWizard({});
      }
    });
    var rm = document.getElementById('fri-remove-demo');
    if (rm) rm.addEventListener('click', function () { removeDemo().then(function () { navigateTo('dashboard', { replace: true }); }); });
  }

  function askAi(question) {
    navigateTo('ai');
    var tries = 0;
    (function fill() {
      var input = document.getElementById('ai-input');
      if (input && window.AiCfoModule && typeof window.AiCfoModule.handleSend === 'function') {
        input.value = question;
        window.AiCfoModule.handleSend();
        return;
      }
      if (++tries < 40) setTimeout(fill, 100);
    })();
  }

  async function removeDemo() {
    try {
      var r = await api('/api/onboarding/demo', { method: 'DELETE' });
      if (typeof fetchAccounts === 'function') await fetchAccounts();
      track('demo_removed', { rows: r.transactions });
      if (typeof showNotification === 'function') showNotification('Demo data removed', 'success');
    } catch (err) {
      if (typeof showNotification === 'function') showNotification((err && err.message) || 'Could not remove the demo data', 'error');
    }
  }

  // ---------------------------------------------------------------- banners

  function verifyBannerHtml() {
    var st = FR.state;
    if (!st || st.emailVerified || st.google) return '';
    var email = (typeof appState !== 'undefined' && appState.user && appState.user.email) || 'your inbox';
    return '<div class="fr-banner" id="fr-verify" role="status">' +
      '<i class="fas fa-envelope" aria-hidden="true"></i>' +
      '<span class="fr-banner-text">Confirm your email: the link is in <b>' + esc(email) + '</b>.</span>' +
      '<button type="button" class="fri-link" id="fr-verify-resend">Send it again</button>' +
    '</div>';
  }

  function bindVerifyBanner(root) {
    var b = root.querySelector('#fr-verify-resend');
    if (!b) return;
    b.addEventListener('click', async function () {
      b.disabled = true;
      try {
        var r = await api('/api/auth/verify-email/send', { method: 'POST', body: '{}' });
        if (r && r.alreadyVerified) {
          var ban = document.getElementById('fr-verify');
          if (ban) ban.remove();
          return;
        }
        b.textContent = 'Sent. Check your inbox and spam folder.';
        track('verify_resent', {});
      } catch (err) {
        b.textContent = err && err.status === 429
          ? 'Just sent. Try again in ' + (err.retryAfter || 60) + ' s.'
          : 'Could not send. Try again later.';
        setTimeout(function () { b.disabled = false; b.textContent = 'Send it again'; }, 8000);
      }
    });
  }

  function demoBannerHtml() {
    return '<div class="fr-banner fr-banner-demo" id="fr-demo-banner" role="status">' +
      '<i class="fas fa-flask" aria-hidden="true"></i>' +
      '<span class="fr-banner-text">You are looking at <b>demo data</b>: a sample household, not your money.</span>' +
      '<button type="button" class="btn btn-sm btn-primary" id="fr-demo-import">Import my statement</button>' +
      '<button type="button" class="fri-link" id="fr-demo-remove">Remove demo data</button>' +
    '</div>';
  }

  function emptyBannerHtml() {
    return '<div class="fr-banner" id="fr-empty-banner" role="status">' +
      '<i class="fas fa-file-arrow-up" aria-hidden="true"></i>' +
      '<span class="fr-banner-text">Your dashboard fills itself from a bank statement: 3 months of history takes about a minute.</span>' +
      '<button type="button" class="btn btn-sm btn-primary" id="fr-empty-import">Import a statement</button>' +
    '</div>';
  }

  // ---------------------------------------------------------------- public API

  var FR = {
    state: null,
    track: track,

    async loadState() {
      try {
        this.state = await api('/api/onboarding/state');
      } catch (_) {
        this.state = null;
      }
      return this.state;
    },

    // Called first thing by renderDashboard(). true = the start screen took over.
    async beforeDashboard(main) {
      var st = await this.loadState();
      if (!st || !main) return false;
      var skipped = false;
      try { skipped = localStorage.getItem(userKey()) === '1'; } catch (_) {}
      if (st.firstRun && !skipped) {
        renderStart(main);
        return true;
      }
      return false;
    },

    // Called after the dashboard is painted: banners above the hero.
    afterDashboard(main) {
      var st = this.state;
      if (!st || !main) return;
      var html = verifyBannerHtml();
      if (st.demo) html += demoBannerHtml();
      else if (st.ownTransactions === 0) html += emptyBannerHtml();
      if (!html) return;
      var holder = document.createElement('div');
      holder.className = 'fr-banners';
      holder.innerHTML = html;
      main.insertBefore(holder, main.firstChild);
      bindVerifyBanner(holder);
      var imp = holder.querySelector('#fr-demo-import');
      if (imp) imp.addEventListener('click', function () {
        removeDemo().then(function () {
          try { localStorage.removeItem(userKey()); } catch (_) {}
          navigateTo('dashboard', { replace: true });
        });
      });
      var rm = holder.querySelector('#fr-demo-remove');
      if (rm) rm.addEventListener('click', function () { removeDemo().then(function () { navigateTo('dashboard', { replace: true }); }); });
      var ei = holder.querySelector('#fr-empty-import');
      if (ei) ei.addEventListener('click', function () {
        try { localStorage.removeItem(userKey()); } catch (_) {}
        navigateTo('dashboard', { replace: true });
      });
    },

    // An honest hero line when there is nothing to analyse yet.
    emptyInsight: function () {
      return 'No transactions this month yet. Import a bank statement and I will show where the money goes, which charges repeat and what you can save.';
    },

    showInsight: showInsight,
    askAi: askAi
  };

  window.FirstRun = FR;

  // Result of the confirmation link.
  if (verifyResult) {
    var announce = function () {
      if (typeof showNotification !== 'function') return;
      if (verifyResult === 'ok') {
        showNotification('Email confirmed. Thank you.', 'success');
        track('email_verified', {});
      } else {
        showNotification('This confirmation link has expired or was already used. Sign in and press “Send it again”.', 'warning');
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(announce, 600); });
    else setTimeout(announce, 600);
  }
})();
