// public/js/money-map.js — "Business & personal" page (management accounting, 21.11.2026).
// API: GET /api/analytics/money-map (services/moneyMapService.js), PUT /api/accounts/:id
// { scope, businessName }. Works the same for vault users: both routes are served by the
// in-browser engine. Classic script: only renderMoneyMapPage + MoneyMapModule are global.
(function (root) {
  'use strict';

  var PERIODS = [
    { id: 'month', label: 'This month' },
    { id: 'last', label: 'Last month' },
    { id: 'q', label: '3 months' },
    { id: 'year', label: 'This year' }
  ];
  var S = { period: 'month', data: null, editing: false };

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function main() { return document.getElementById('main-content'); }
  function toast(msg, kind) { if (typeof root.showNotification === 'function') root.showNotification(msg, kind || 'info'); }
  function cur() { return (S.data && S.data.currency) || 'CAD'; }
  function fmt(v) {
    return typeof root.formatCurrency === 'function' ? root.formatCurrency(Number(v) || 0, cur()) : (Number(v) || 0).toFixed(2);
  }
  function pad(n) { return ('0' + n).slice(-2); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayYMD() {
    if (root.UI && typeof root.UI.todayYMD === 'function') return root.UI.todayYMD();
    return ymd(new Date());
  }
  function range(id) {
    var t = todayYMD();
    var y = +t.slice(0, 4), m = +t.slice(5, 7);
    if (id === 'last') {
      var ly = m === 1 ? y - 1 : y, lm = m === 1 ? 12 : m - 1;
      var last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
      return { start: ly + '-' + pad(lm) + '-01', end: ly + '-' + pad(lm) + '-' + pad(last) };
    }
    if (id === 'q') {
      var qm = m - 2, qy = y;
      if (qm < 1) { qm += 12; qy -= 1; }
      return { start: qy + '-' + pad(qm) + '-01', end: t };
    }
    if (id === 'year') return { start: y + '-01-01', end: t };
    return { start: t.slice(0, 8) + '01', end: t };
  }
  function monthLabel(ym) {
    var d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 15));
    var loc = 'en-CA';
    try {
      var lang = root.i18n && typeof root.i18n.getLanguage === 'function' ? root.i18n.getLanguage() : 'en';
      loc = lang === 'uk' ? 'uk-UA' : lang === 'ru' ? 'ru-RU' : 'en-CA';
    } catch (e) { /* default */ }
    try { return d.toLocaleDateString(loc, { month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return ym; }
  }
  function signCls(v) { return v > 0 ? 'is-pos' : v < 0 ? 'is-neg' : ''; }

  async function load() {
    var r = range(S.period);
    var url = '/api/analytics/money-map?months=6&startDate=' + r.start + '&endDate=' + r.end;
    var res = await root.fetchWithAuth(url);
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error((body && body.message) || 'Could not load the money map');
    S.data = body;
  }

  // ---------- pieces ----------
  function periodTabs() {
    return '<div class="mm-periods" role="tablist" aria-label="Period">' + PERIODS.map(function (p) {
      var on = p.id === S.period;
      return '<button type="button" role="tab" class="mm-period" data-mm-period="' + p.id + '" aria-selected="' + on + '">' + p.label + '</button>';
    }).join('') + '</div>';
  }

  function flowStop(label, value, note, cls) {
    return '<li class="mm-stop ' + (cls || '') + '">' +
      '<span class="mm-stop-label">' + esc(label) + '</span>' +
      '<span class="mm-stop-value">' + fmt(value) + '</span>' +
      (note ? '<span class="mm-stop-note">' + esc(note) + '</span>' : '') + '</li>';
  }

  function flowHtml(d) {
    var b = d.businessTotal, p = d.personal;
    var margin = b.margin == null ? '' : b.margin + '% margin';
    return '<section class="mm-plate mm-flow" aria-label="Where the money went">' +
      '<h2 class="mm-h2">Where the money went</h2>' +
      '<ol class="mm-stops">' +
      flowStop('Business earned', b.income, d.businesses.length > 1 ? d.businesses.length + ' businesses' : '') +
      flowStop('Business spent', b.expenses, 'running costs', 'is-out') +
      flowStop('Profit', b.profit, margin, 'is-key ' + signCls(b.profit)) +
      flowStop('You took home', b.ownerPay, b.ownerIn > 0 ? 'you put in ' + fmt(b.ownerIn) : '') +
      flowStop('You spent', p.expenses, 'personal', 'is-out') +
      flowStop('Left personally', p.left, p.income > 0 ? 'of ' + fmt(p.income) + ' in' : '', signCls(p.left)) +
      '</ol></section>';
  }

  function bars(list, emptyText) {
    if (!list || !list.length) return '<p class="mm-empty">' + esc(emptyText) + '</p>';
    return '<ul class="mm-bars">' + list.map(function (c, i) {
      var w = Math.max(2, Math.min(100, c.share || 0));
      return '<li class="mm-bar' + (i === 0 ? ' is-first' : '') + '">' +
        '<span class="mm-bar-name">' + esc(c.category) + '</span>' +
        '<span class="mm-bar-amt">' + fmt(c.amount) + ' <small>' + (c.share || 0) + '%</small></span>' +
        '<span class="mm-bar-track" aria-hidden="true"><span style="width:' + w + '%"></span></span></li>';
    }).join('') + '</ul>';
  }

  function figure(label, value, cls) {
    return '<div class="mm-fig ' + (cls || '') + '"><span class="mm-fig-label">' + esc(label) + '</span>' +
      '<span class="mm-fig-value">' + fmt(value) + '</span></div>';
  }

  function businessHtml(b) {
    var warn = b.uncategorisedExpense > 0
      ? '<p class="mm-warn"><i class="fas fa-tag" aria-hidden="true"></i> ' + fmt(b.uncategorisedExpense) + ' of spending has no category. <a href="/transactions" data-page="transactions">Sort it</a> to see where it goes.</p>'
      : '';
    return '<section class="mm-plate mm-biz">' +
      '<header class="mm-plate-head"><h2 class="mm-h2"><i class="fas fa-briefcase" aria-hidden="true"></i> ' + esc(b.name) + '</h2>' +
      (b.margin == null ? '' : '<span class="mm-chip ' + signCls(b.profit) + '">' + b.margin + '% margin</span>') + '</header>' +
      '<div class="mm-figs">' +
      figure('Earned', b.income) + figure('Spent', b.expenses) +
      figure('Profit', b.profit, 'is-key ' + signCls(b.profit)) +
      figure('You took home', b.ownerPay) + figure('Stayed in the business', b.kept, signCls(b.kept)) +
      '</div>' +
      '<div class="mm-cols"><div><h3 class="mm-h3">Where the business money goes</h3>' + bars(b.expenseCategories, 'No business spending in this period.') + '</div>' +
      '<div><h3 class="mm-h3">Where it comes from</h3>' + bars(b.incomeCategories, 'No business income in this period.') + '</div></div>' +
      warn + '</section>';
  }

  function personalHtml(p, hasBusiness) {
    var warn = p.uncategorisedExpense > 0
      ? '<p class="mm-warn"><i class="fas fa-tag" aria-hidden="true"></i> ' + fmt(p.uncategorisedExpense) + ' of spending has no category. <a href="/transactions" data-page="transactions">Sort it</a>.</p>'
      : '';
    return '<section class="mm-plate mm-personal">' +
      '<header class="mm-plate-head"><h2 class="mm-h2"><i class="fas fa-user" aria-hidden="true"></i> Personal</h2></header>' +
      '<div class="mm-figs">' +
      figure('Came in', p.income) +
      (hasBusiness || p.fromBusiness ? figure('From your business', p.fromBusiness) + figure('Other income', p.otherIncome) : '') +
      figure('Spent', p.expenses) + figure('Left', p.left, 'is-key ' + signCls(p.left)) +
      '</div>' +
      (p.putIntoBusiness > 0 ? '<p class="mm-note">You also put ' + fmt(p.putIntoBusiness) + ' into your business.</p>' : '') +
      '<div class="mm-cols"><div><h3 class="mm-h3">Where your money goes</h3>' + bars(p.expenseCategories, 'No personal spending in this period.') + '</div>' +
      '<div><h3 class="mm-h3">Where it comes from</h3>' + bars(p.incomeCategories, 'No personal income in this period.') + '</div></div>' +
      warn + '</section>';
  }

  function seriesHtml(series, hasBusiness) {
    // Months before the first money moved are noise: drop leading empty months.
    series = (series || []).slice();
    while (series.length > 1 && !series[0].businessIncome && !series[0].businessExpenses && !series[0].ownerPay &&
      !series[0].personalIncome && !series[0].personalExpenses) series.shift();
    if (!series.length) return '';
    var max = 1;
    series.forEach(function (m) {
      max = Math.max(max, Math.abs(m.businessProfit), Math.abs(m.personalLeft), m.ownerPay);
    });
    function cell(v, cls, opt) {
      var w = Math.round(Math.min(100, (Math.abs(v) / max) * 100));
      return '<td class="mm-num ' + signCls(v) + (opt ? ' mm-opt' : '') + '"><span class="mm-cellbar ' + (cls || '') + '" aria-hidden="true" style="width:' + w + '%"></span><span class="mm-cellval">' + fmt(v) + '</span></td>';
    }
    return '<section class="mm-plate mm-series"><h2 class="mm-h2">Month by month</h2>' +
      '<div class="mm-table-wrap"><table class="mm-table"><thead><tr><th scope="col">Month</th>' +
      (hasBusiness ? '<th scope="col">Business profit</th><th scope="col" class="mm-opt">You took home</th>' : '') +
      '<th scope="col" class="mm-opt">Personal in</th><th scope="col" class="mm-opt">Personal spent</th><th scope="col">Left personally</th></tr></thead><tbody>' +
      series.slice().reverse().map(function (m) {
        return '<tr><th scope="row">' + esc(monthLabel(m.month)) + '</th>' +
          (hasBusiness ? cell(m.businessProfit, 'is-accent') + cell(m.ownerPay, '', true) : '') +
          cell(m.personalIncome, '', true) + cell(-m.personalExpenses, '', true) + cell(m.personalLeft) + '</tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function setupHtml(d, intro) {
    var accounts = d.accounts || [];
    var rows = accounts.length ? accounts.map(function (a) {
      var biz = a.scope === 'business';
      return '<li class="mm-acct" data-mm-acct="' + a.id + '">' +
        '<div class="mm-acct-name"><strong>' + esc(a.name) + '</strong>' + (a.bankName ? '<span>' + esc(a.bankName) + ' · ' + esc(a.currency) + '</span>' : '<span>' + esc(a.currency) + '</span>') + '</div>' +
        '<div class="mm-seg" role="radiogroup" aria-label="Whose money is in ' + esc(a.name) + '">' +
        '<label><input type="radio" name="mm-scope-' + a.id + '" value="personal"' + (biz ? '' : ' checked') + '><span>Personal</span></label>' +
        '<label><input type="radio" name="mm-scope-' + a.id + '" value="business"' + (biz ? ' checked' : '') + '><span>Business</span></label></div>' +
        '<input class="form-input mm-bizname" type="text" maxlength="80" placeholder="Business name" aria-label="Business name for ' + esc(a.name) + '" value="' + esc(a.businessName) + '"' + (biz ? '' : ' hidden') + '>' +
        '</li>';
    }).join('') : '<li class="mm-empty">Add an account first: <a href="/accounts" data-page="accounts">Accounts</a>.</li>';
    return '<section class="mm-plate mm-setup" id="mm-setup">' +
      '<h2 class="mm-h2">' + (intro ? 'Which accounts belong to your business?' : 'Business accounts') + '</h2>' +
      (intro ? '<p class="mm-lead">Mark them once. Finman then shows what each business earns, what you take home and where the money goes, next to your personal money.</p>' : '') +
      '<ul class="mm-accts">' + rows + '</ul>' +
      '<p class="mm-hint">Paying yourself: move money from a business account to a personal one as a transfer, or file the payment under the category “Owner pay”. Finman counts it as your pay, not as a business cost.</p>' +
      (accounts.length ? '<div class="mm-actions"><button type="button" class="btn btn-primary" id="mm-save">Save</button></div>' : '') +
      '</section>';
  }

  // Nothing to show yet: a labelled sample month, then the two ways in.
  function emptyHtml() {
    var ex = { income: 5400, expenses: 4310 };
    var cats = [['Housing', 1850, 43], ['Groceries', 690, 16], ['Transport', 410, 10], ['Dining out', 330, 8], ['Subscriptions', 120, 3]];
    var money = function (v) { return '$' + Number(v).toLocaleString('en-CA'); };
    return '<section class="mm-plate mm-example" aria-labelledby="mm-ex-h">' +
      '<p class="mm-ex-tag">Example · a sample household, one month</p>' +
      '<h2 class="mm-h2" id="mm-ex-h">Your money map fills in from one bank statement</h2>' +
      '<div class="mm-figs">' +
      '<div class="mm-fig"><span class="mm-fig-label">Came in</span><span class="mm-fig-value is-pos">' + money(ex.income) + '</span></div>' +
      '<div class="mm-fig"><span class="mm-fig-label">Spent</span><span class="mm-fig-value">' + money(ex.expenses) + '</span></div>' +
      '<div class="mm-fig is-key is-pos"><span class="mm-fig-label">Left</span><span class="mm-fig-value">' + money(ex.income - ex.expenses) + '</span></div>' +
      '</div>' +
      '<h3 class="mm-h3">Where the money goes</h3>' +
      '<ul class="mm-bars">' + cats.map(function (c, i) {
        return '<li class="mm-bar' + (i === 0 ? ' is-first' : '') + '"><span class="mm-bar-name">' + c[0] + '</span>' +
          '<span class="mm-bar-amt">' + money(c[1]) + ' <small>' + c[2] + '%</small></span>' +
          '<span class="mm-bar-track" aria-hidden="true"><span style="width:' + c[2] + '%"></span></span></li>';
      }).join('') + '</ul>' +
      '<div class="mm-actions">' +
      '<a class="btn btn-primary" href="/dashboard" data-mm-go="import">Import a bank statement</a>' +
      '<button type="button" class="btn btn-outline" data-mm-go="demo">Open the full example</button>' +
      '</div></section>';
  }

  function isEmpty(d) {
    var p = d.personal || {};
    return !d.hasBusiness && !(p.income > 0) && !(p.expenses > 0) &&
      !(d.series || []).some(function (m) { return m.personalIncome || m.personalExpenses || m.businessIncome || m.businessExpenses; });
  }

  // Personal users: their own picture first, the business question folded below.
  function businessInviteHtml(d) {
    return '<details class="mm-plate mm-invite"' + ((d.accounts || []).length ? '' : ' hidden') + '>' +
      '<summary><i class="fas fa-briefcase" aria-hidden="true"></i> Run a business or freelance too? Mark its accounts to see profit and your pay</summary>' +
      setupHtml(d, true) + '</details>';
  }

  function render() {
    var d = S.data;
    var el = main();
    if (!el || !d) return;
    var title = d.hasBusiness ? 'Money map: business and personal' : 'Money map';
    var head = (typeof root.pageHeaderHtml === 'function' ? root.pageHeaderHtml(title, periodTabs()) : '<h1>' + title + '</h1>' + periodTabs());
    var html = head;
    if (S.note) html += '<p class="mm-note">' + esc(S.note) + '</p>';
    if (d.missingRates && d.missingRates.length) {
      html += '<p class="mm-note">No exchange rate yet for ' + esc(d.missingRates.join(', ')) + '; those amounts are counted 1:1.</p>';
    }
    if (isEmpty(d)) {
      html += emptyHtml() + businessInviteHtml(d);
    } else if (!d.hasBusiness) {
      html += personalHtml(d.personal, false) + seriesHtml(d.series, false) + businessInviteHtml(d);
    } else {
      html += flowHtml(d) + d.businesses.map(businessHtml).join('') + personalHtml(d.personal, true) +
        seriesHtml(d.series, true) + setupHtml(d, false);
    }
    el.innerHTML = '<div class="mm-page">' + html + '</div>';
    bind(el);
  }

  function bind(el) {
    el.querySelectorAll('[data-mm-period]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (S.period === b.dataset.mmPeriod) return;
        S.period = b.dataset.mmPeriod;
        S.note = '';
        refresh();
      });
    });
    el.querySelectorAll('.mm-acct').forEach(function (row) {
      row.querySelectorAll('input[type=radio]').forEach(function (r) {
        r.addEventListener('change', function () {
          var name = row.querySelector('.mm-bizname');
          if (name) name.hidden = r.value !== 'business' || !r.checked;
          if (name && !name.hidden) name.focus();
        });
      });
    });
    el.querySelectorAll('[data-mm-go]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        if (b.dataset.mmGo === 'demo' && root.FirstRun && typeof root.FirstRun.loadDemo === 'function') {
          if (typeof root.navigateTo === 'function') root.navigateTo('dashboard');
          setTimeout(function () { root.FirstRun.loadDemo(); }, 300);
          return;
        }
        try { Object.keys(localStorage).forEach(function (k) { if (/^fm_firstrun_skip/.test(k)) localStorage.removeItem(k); }); } catch (_) { /* ignore */ }
        if (typeof root.navigateTo === 'function') root.navigateTo('dashboard');
      });
    });
    var save = el.querySelector('#mm-save');
    if (save) save.addEventListener('click', saveScopes);
    el.querySelectorAll('a[data-page]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (typeof root.navigateTo === 'function') { e.preventDefault(); root.navigateTo(a.dataset.page); }
      });
    });
  }

  async function saveScopes() {
    var btn = document.getElementById('mm-save');
    var accounts = (S.data && S.data.accounts) || [];
    var byId = {};
    accounts.forEach(function (a) { byId[a.id] = a; });
    var changes = [];
    document.querySelectorAll('.mm-acct').forEach(function (row) {
      var id = row.dataset.mmAcct;
      var picked = row.querySelector('input[type=radio]:checked');
      var scope = picked ? picked.value : 'personal';
      var nameEl = row.querySelector('.mm-bizname');
      var businessName = scope === 'business' && nameEl ? nameEl.value.trim() : '';
      var a = byId[id];
      if (a && (a.scope !== scope || (a.businessName || '') !== businessName)) changes.push({ id: id, scope: scope, businessName: businessName });
    });
    if (!changes.length) { toast('Nothing changed', 'info'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      for (var i = 0; i < changes.length; i += 1) {
        var c = changes[i];
        var res = await root.fetchWithAuth('/api/accounts/' + encodeURIComponent(c.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: c.scope, businessName: c.businessName })
        });
        if (!res.ok) {
          var b = await res.json().catch(function () { return {}; });
          throw new Error((b && b.message) || 'Could not save');
        }
      }
      toast('Saved', 'success');
      await refresh();
    } catch (e) {
      toast(e.message || 'Could not save', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  async function refresh() {
    await load();
    render();
  }

  // Nothing in "This month" yet, while the statement covered earlier months (the usual case
  // right after the first import): open on the latest period that has money in it.
  function quietThisMonth(d) {
    var p = d.personal || {};
    var biz = (d.businesses || []).some(function (b) { return b.income > 0 || b.expenses > 0; });
    return !(p.income > 0) && !(p.expenses > 0) && !biz;
  }
  function latestPeriodWithData(d) {
    var t = todayYMD();
    var y = +t.slice(0, 4), m = +t.slice(5, 7);
    var withData = (d.series || []).filter(function (x) {
      return x.personalIncome || x.personalExpenses || x.businessIncome || x.businessExpenses;
    }).map(function (x) { return x.month; }).sort();
    if (!withData.length) return null;
    var lastYm = withData[withData.length - 1];
    var ago = (y * 12 + m) - (+lastYm.slice(0, 4) * 12 + +lastYm.slice(5, 7));
    if (ago === 1) return 'last';
    if (ago <= 2) return 'q';
    return lastYm.slice(0, 4) === String(y) ? 'year' : null;
  }

  async function renderMoneyMapPage() {
    S.note = '';
    await load();
    if (S.period === 'month' && S.data && quietThisMonth(S.data)) {
      var pick = latestPeriodWithData(S.data);
      if (pick) {
        S.period = pick;
        S.note = 'Nothing recorded this month yet, so this shows ' + (pick === 'last' ? 'last month' : pick === 'q' ? 'the last 3 months' : 'this year') + '.';
        await load();
      }
    }
    render();
  }

  root.renderMoneyMapPage = renderMoneyMapPage;
  root.MoneyMapModule = { init: renderMoneyMapPage, range: range };
})(typeof window !== 'undefined' ? window : this);
