// public/js/invoices.js — Invoices page: list, editor, templates, shared-template import.
// API: /api/invoices (see routes/invoices.js). Classic script: everything lives in this
// IIFE; only renderInvoicesPage and InvoicesModule are global (app.js PAGE_RENDERERS).
// Every PDF carries the "Made with Finman Online" footer — the UI never offers to drop it.
(function (root) {
  'use strict';

  var API = '/api/invoices';
  var TPL_KEY = 'fm_tpl';
  var STATUSES = ['all', 'draft', 'sent', 'paid', 'void'];
  var IMG_MAX = 1.5 * 1024 * 1024;

  // ---- shared template link: remember ?tpl=<code> before sign-up / sign-in ----
  (function captureSharedCode() {
    try {
      var m = /[?&]tpl=([A-Za-z0-9_-]{4,64})/.exec(root.location ? root.location.search : '');
      if (m) root.localStorage.setItem(TPL_KEY, m[1]);
    } catch (e) { /* private mode */ }
  })();

  var S = {
    view: 'list', status: 'all', q: '', invoices: [], totals: {}, profiles: [], presets: null,
    ed: null, tpl: null, highlight: null, urls: []
  };

  // ---------- helpers ----------
  function tx(key, vars) {
    var full = 'invoice.' + key;
    if (root.i18n && typeof root.i18n.t === 'function') return root.i18n.t(full, vars);
    return full;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function main() { return document.getElementById('main-content'); }
  function toast(msg, kind) { if (typeof root.showNotification === 'function') root.showNotification(msg, kind || 'info'); }
  function money(cents, cur) {
    var v = (Number(cents) || 0) / 100;
    return typeof root.formatCurrency === 'function' ? root.formatCurrency(v, cur) : v.toFixed(2) + ' ' + cur;
  }
  function today() {
    if (root.UI && typeof root.UI.todayYMD === 'function') return root.UI.todayYMD();
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function addDays(ymd, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + (Number(n) || 0)));
    return d.toISOString().slice(0, 10);
  }
  function fmtDate(ymd) {
    if (!ymd) return '';
    return typeof root.formatDate === 'function' ? root.formatDate(ymd) : ymd;
  }
  function isMobile() {
    return !!(root.matchMedia && root.matchMedia('(max-width: 760px)').matches);
  }

  // Same parsing as services/invoice/core.js toCents: the last separator is the decimal one.
  function toCents(v) {
    if (v === null || v === undefined || v === '') return 0;
    var s = String(v).trim().replace(/[\s '’]/g, '');
    if (!s) return 0;
    var lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > ld) {
      var dec = s.length - lc - 1;
      s = dec === 3 && ld === -1 && !/^-?0,/.test(s) ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }
  function toQty(v) {
    if (v === null || v === undefined || v === '') return 1;
    var n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  function taxRateOf(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    var n = parseFloat(String(v).replace(',', '.').replace('%', ''));
    return Number.isFinite(n) ? n : null;
  }
  function centsToInput(c) {
    var n = (Number(c) || 0) / 100;
    return n.toFixed(2);
  }

  // Number pattern sample, same tokens as core.renderNumber.
  function sampleNumber(format, ymd, seq) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || today()) || [0, '2026', '01', '01'];
    var s = Number(seq) || 1;
    var pad = function (n, w) { var x = String(n); while (x.length < w) x = '0' + x; return x; };
    return String(format || '{SEQ}')
      .replace(/\{DD\}/g, m[3]).replace(/\{MM\}/g, m[2]).replace(/\{YYYY\}/g, m[1]).replace(/\{YY\}/g, m[1].slice(2))
      .replace(/\{N\}/g, '1').replace(/\{SEQ4\}/g, pad(s, 4)).replace(/\{SEQ3\}/g, pad(s, 3)).replace(/\{SEQ\}/g, String(s));
  }

  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    var res = await root.fetchWithAuth(API + path, init);
    if (!res.ok) throw await root.readApiError(res, tx('err.request'));
    if (opts.blob) return { blob: await res.blob(), res: res };
    return res.json();
  }

  function trackUrl(u) { S.urls.push(u); return u; }
  function releaseUrls() {
    S.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
    S.urls = [];
  }

  // Confirm dialog on UI.modal; resolves true/false.
  function confirmBox(title, text, okLabel, danger) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      var host = root.UI.modal({
        title: title,
        body: '<p class="inv-confirm-text">' + esc(text) + '</p>',
        footer: '<button type="button" class="btn" data-inv-confirm="0">' + esc(tx('btn.cancel')) + '</button>' +
          '<button type="button" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-inv-confirm="1">' + esc(okLabel) + '</button>',
        onClose: function () { finish(false); }
      });
      if (!host) { finish(root.confirm ? root.confirm(text) : false); return; }
      host.addEventListener('click', function (e) {
        var b = e.target.closest('[data-inv-confirm]');
        if (!b) return;
        finish(b.getAttribute('data-inv-confirm') === '1');
        root.UI.closeModal(host);
      });
    });
  }

  function statusLabel(inv) {
    if (inv.status === 'sent' && inv.due_date && inv.due_date < today()) return { key: 'overdue', text: tx('status.overdue') };
    return { key: inv.status, text: tx('status.' + inv.status) };
  }
  function chip(inv) {
    var s = statusLabel(inv);
    return '<span class="inv-chip inv-chip-' + s.key + '">' + esc(s.text) + '</span>';
  }

  function filenameFrom(res, fallback) {
    var cd = res.headers.get('Content-Disposition') || '';
    var m = /filename="?([^";]+)"?/i.exec(cd);
    return m ? m[1] : fallback;
  }
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // PDF in a modal on wide screens; on phones the browser's own viewer (new tab).
  function showPdf(blob, title, preOpened) {
    var url = URL.createObjectURL(blob);
    if (preOpened) {
      try { preOpened.location.href = url; } catch (e) { saveBlob(blob, title + '.pdf'); }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return;
    }
    root.UI.modal({
      title: title,
      size: 'lg',
      body: '<div class="inv-pdf"><iframe class="inv-pdf-frame" src="' + url + '" title="' + esc(title) + '"></iframe></div>' +
        '<p class="inv-footnote"><i class="fas fa-info-circle" aria-hidden="true"></i> ' + esc(tx('footerNote')) + '</p>',
      onClose: function () { URL.revokeObjectURL(url); }
    });
  }
  function preOpenTab() {
    if (!isMobile()) return null;
    try {
      var w = root.open('', '_blank');
      if (w && w.document) w.document.title = tx('preview.loading');
      return w;
    } catch (e) { return null; }
  }

  // ---------- data ----------
  async function loadProfiles() {
    var d = await api('/profiles');
    S.profiles = d.profiles || [];
    return S.profiles;
  }
  async function loadPresets() {
    if (S.presets) return S.presets;
    var d = await api('/presets');
    S.presets = d.presets || [];
    return S.presets;
  }
  async function loadInvoices() {
    var qs = [];
    if (S.status !== 'all') qs.push('status=' + encodeURIComponent(S.status));
    if (S.q) qs.push('q=' + encodeURIComponent(S.q));
    var d = await api('/' + (qs.length ? '?' + qs.join('&') : ''));
    S.invoices = d.invoices || [];
    S.totals = d.totals || {};
  }
  function profileById(id) {
    for (var i = 0; i < S.profiles.length; i++) if (String(S.profiles[i].id) === String(id)) return S.profiles[i];
    return null;
  }
  function presetFor(layout) {
    var list = S.presets || [];
    for (var i = 0; i < list.length; i++) if (list[i].layout === layout) return list[i];
    return list[0] || null;
  }
  // Template data merged over the layout's blank (the server does the same).
  function mergedData(p) {
    var base = (presetFor(p.layout) || {}).data || {};
    var d = p.data || {};
    var out = Object.assign({}, base, d);
    ['seller', 'tax', 'words'].forEach(function (k) {
      if (base[k] || d[k]) out[k] = Object.assign({}, base[k] || {}, d[k] || {});
    });
    return out;
  }

  // ---------- page header ----------
  function headHtml(title, sub, actions) {
    return '<div class="page-header inv-head">' +
      '<div class="inv-head-text"><h1 class="page-title">' + esc(title) + '</h1>' +
      (sub ? '<p class="inv-sub">' + esc(sub) + '</p>' : '') + '</div>' +
      '<div class="inv-head-actions">' + (actions || '') + '</div></div>';
  }
  function viewSwitch() {
    return '<div class="inv-seg" role="tablist" aria-label="' + esc(tx('title')) + '">' +
      ['list', 'templates'].map(function (v) {
        var on = S.view === v;
        return '<button type="button" role="tab" aria-selected="' + on + '" class="inv-seg-btn' + (on ? ' is-on' : '') +
          '" data-action="inv:view" data-view="' + v + '">' + esc(tx(v === 'list' ? 'tab.invoices' : 'tab.templates')) + '</button>';
      }).join('') + '</div>';
  }

  // ---------- list ----------
  function sumsHtml() {
    var codes = Object.keys(S.totals || {});
    if (!codes.length) return '';
    return '<div class="inv-sums">' + codes.map(function (c) {
      var t = S.totals[c] || {};
      return '<div class="inv-sum">' +
        '<span class="inv-sum-cur">' + esc(c) + '</span>' +
        '<dl><div><dt>' + esc(tx('sum.outstanding')) + '</dt><dd class="fm-money">' + money(t.outstanding_cents, c) + '</dd></div>' +
        '<div><dt>' + esc(tx('sum.paid')) + '</dt><dd class="fm-money inv-sum-paid">' + money(t.paid_cents, c) + '</dd></div></dl>' +
        '</div>';
    }).join('') + '</div>';
  }

  function rowHtml(inv) {
    var s = statusLabel(inv);
    var menu = [];
    menu.push(['inv:duplicate', 'fa-copy', tx('act.duplicate')]);
    if (inv.status === 'draft') menu.push(['inv:mark', 'fa-paper-plane', tx('act.markSent'), 'sent']);
    if (inv.status === 'draft' || inv.status === 'sent') menu.push(['inv:mark', 'fa-check', tx('act.markPaid'), 'paid']);
    if (inv.status === 'paid') menu.push(['inv:mark', 'fa-undo', tx('act.markUnpaid'), 'sent']);
    if (inv.status !== 'void') menu.push(['inv:void', 'fa-ban', tx('act.void')]);
    menu.push(['inv:delete', 'fa-trash-alt', tx('act.delete'), null, true]);
    return '<li class="inv-row' + (inv.status === 'void' ? ' is-void' : '') + '" data-id="' + inv.id + '">' +
      '<button type="button" class="inv-row-main" data-action="inv:open" data-id="' + inv.id + '">' +
        '<span class="inv-row-id"><span class="inv-row-num">' + esc(tx('row.no', { number: inv.number })) + '</span>' +
        '<span class="inv-row-client">' + esc(inv.client_name || tx('row.noClient')) + '</span></span>' +
        '<span class="inv-row-dates">' + esc(fmtDate(inv.issue_date)) +
          (inv.due_date ? '<span class="inv-row-due' + (s.key === 'overdue' ? ' is-late' : '') + '">' + esc(tx('row.due', { date: fmtDate(inv.due_date) })) + '</span>' : '') +
        '</span>' +
        '<span class="inv-row-total fm-money">' + money(inv.total_cents, inv.currency) + '</span>' +
        '<span class="inv-row-status">' + chip(inv) + '</span>' +
      '</button>' +
      '<div class="inv-row-actions">' +
        '<button type="button" class="btn btn-icon" data-action="inv:pdf" data-id="' + inv.id + '" aria-label="' + esc(tx('act.download')) + '" title="' + esc(tx('act.download')) + '"><i class="fas fa-file-download" aria-hidden="true"></i></button>' +
        '<details class="inv-menu"><summary class="btn btn-icon" aria-label="' + esc(tx('act.more')) + '" title="' + esc(tx('act.more')) + '"><i class="fas fa-ellipsis-h" aria-hidden="true"></i></summary>' +
          '<div class="inv-menu-pop" role="menu">' + menu.map(function (m) {
            return '<button type="button" role="menuitem" class="inv-menu-item' + (m[4] ? ' is-danger' : '') + '" data-action="' + m[0] + '" data-id="' + inv.id + '"' +
              (m[3] ? ' data-status="' + m[3] + '"' : '') + '><i class="fas ' + m[1] + '" aria-hidden="true"></i><span>' + esc(m[2]) + '</span></button>';
          }).join('') + '</div></details>' +
      '</div></li>';
  }

  function presetCards(action) {
    return '<div class="inv-presets">' + (S.presets || []).map(function (p) {
      var light = p.layout === 'light';
      return '<button type="button" class="inv-preset" data-action="' + action + '" data-preset="' + esc(p.key) + '">' +
        '<span class="inv-preset-sheet inv-preset-' + esc(p.layout) + '" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
        '<span class="inv-preset-name">' + esc(tx(light ? 'preset.light' : 'preset.classic')) + '</span>' +
        '<span class="inv-preset-text">' + esc(tx(light ? 'preset.lightText' : 'preset.classicText')) + '</span>' +
      '</button>';
    }).join('') + '</div>';
  }

  function emptyFirstHtml() {
    return '<section class="inv-plate inv-first">' +
      '<div class="inv-first-text"><h2>' + esc(tx('empty.firstTitle')) + '</h2>' +
      '<p>' + esc(tx('empty.firstText')) + '</p></div>' +
      presetCards('inv:tpl-from-preset') +
      '<p class="inv-footnote"><i class="fas fa-info-circle" aria-hidden="true"></i> ' + esc(tx('footerNote')) + '</p>' +
    '</section>';
  }

  function listBodyHtml() {
    if (!S.invoices.length) {
      var filtered = S.status !== 'all' || S.q;
      return '<div class="inv-plate inv-none"><p>' + esc(tx(filtered ? 'empty.filtered' : 'empty.noInvoices')) + '</p>' +
        (filtered ? '' : '<button type="button" class="btn btn-primary" data-action="inv:new"><i class="fas fa-plus" aria-hidden="true"></i> ' + esc(tx('btn.newInvoice')) + '</button>') +
        '</div>';
    }
    return '<ul class="inv-plate inv-list" aria-label="' + esc(tx('tab.invoices')) + '">' + S.invoices.map(rowHtml).join('') + '</ul>';
  }

  function renderList() {
    S.view = 'list';
    var hasTpl = S.profiles.length > 0;
    var actions = hasTpl ? viewSwitch() + '<button type="button" class="btn btn-primary" data-action="inv:new"><i class="fas fa-plus" aria-hidden="true"></i> ' + esc(tx('btn.newInvoice')) + '</button>' : '';
    var html = '<div class="inv-page">' + headHtml(tx('title'), tx('subtitle'), actions);
    if (!hasTpl) {
      html += emptyFirstHtml();
    } else {
      html += sumsHtml() +
        '<div class="inv-toolbar">' +
          '<div class="inv-seg inv-status" role="tablist" aria-label="' + esc(tx('filter.status')) + '">' + STATUSES.map(function (st) {
            var on = S.status === st;
            return '<button type="button" role="tab" aria-selected="' + on + '" class="inv-seg-btn' + (on ? ' is-on' : '') + '" data-action="inv:status-filter" data-status="' + st + '">' + esc(tx('status.' + st)) + '</button>';
          }).join('') + '</div>' +
          '<label class="inv-search"><i class="fas fa-search" aria-hidden="true"></i><span class="sr-only">' + esc(tx('filter.search')) + '</span>' +
          '<input type="search" id="inv-search" value="' + esc(S.q) + '" placeholder="' + esc(tx('filter.search')) + '" autocomplete="off"></label>' +
        '</div>' +
        '<div id="inv-list-body">' + listBodyHtml() + '</div>';
    }
    html += '</div>';
    main().innerHTML = html;
    var search = document.getElementById('inv-search');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(async function () {
          S.q = search.value.trim();
          try { await loadInvoices(); } catch (e) { toast(e.message, 'error'); return; }
          var body = document.getElementById('inv-list-body');
          if (body) body.innerHTML = listBodyHtml();
        }, 250);
      });
    }
  }

  async function refreshList() {
    await loadInvoices();
    if (S.view === 'list') renderList();
  }

  // ---------- invoice editor ----------
  function blankItem() { return { description: '', detail: '', qty: '1', price: '' }; }

  async function newInvoiceState(profileId) {
    var p = profileById(profileId) || S.profiles[0];
    var d = mergedData(p);
    var issue = today();
    var ed = {
      id: null, status: 'draft', profile_id: p.id, number: '', numberTouched: false, dueTouched: false,
      issue_date: issue, due_date: addDays(issue, p.due_days), currency: p.currency,
      client_name: '', client_details: '', items: [blankItem()],
      tax_rate: d.tax && d.tax.rate != null ? String(d.tax.rate) : '', tax_label: (d.tax && d.tax.label) || '',
      tax_sub: (d.tax && d.tax.sub) || '', tax_text: (d.tax && d.tax.text) || '',
      terms: d.terms || '', notes: ''
    };
    try { ed.number = (await api('/next-number?profile_id=' + p.id + '&date=' + issue)).number; } catch (e) { /* server fills it */ }
    return ed;
  }
  function stateFromInvoice(inv) {
    return {
      id: inv.id, status: inv.status, profile_id: inv.profile_id, number: inv.number, numberTouched: true, dueTouched: true,
      issue_date: inv.issue_date, due_date: inv.due_date || '', currency: inv.currency,
      client_name: inv.client_name || '', client_details: inv.client_details || '',
      items: (inv.items && inv.items.length ? inv.items : [{}]).map(function (it) {
        return { description: it.description || '', detail: it.detail || '', note: it.note || '', qty: it.qty != null ? String(it.qty) : '1', price: it.price_cents != null ? centsToInput(it.price_cents) : '' };
      }),
      tax_rate: inv.tax_rate != null ? String(inv.tax_rate) : '', tax_label: inv.tax_label || '', tax_sub: inv.tax_sub || '',
      tax_text: inv.tax_text || '', terms: inv.terms || '', notes: inv.notes || '', invoice: inv
    };
  }

  function field(label, input, cls, hint) {
    return '<label class="inv-field' + (cls ? ' ' + cls : '') + '"><span class="form-label">' + esc(label) + '</span>' + input +
      (hint ? '<span class="inv-hint">' + hint + '</span>' : '') + '</label>';
  }
  function inputHtml(name, value, attrs) {
    return '<input class="form-control" name="' + name + '" value="' + esc(value) + '"' + (attrs || '') + '>';
  }
  function textareaHtml(name, value, rows, attrs) {
    return '<textarea class="form-control" name="' + name + '" rows="' + (rows || 3) + '"' + (attrs || '') + '>' + esc(value) + '</textarea>';
  }

  function itemRowHtml(it, i, ro) {
    var dis = ro ? ' disabled' : '';
    return '<div class="inv-item" data-i="' + i + '">' +
      '<div class="inv-item-desc">' +
        '<input class="form-control" data-k="description" value="' + esc(it.description) + '" placeholder="' + esc(tx('ed.itemDesc')) + '" aria-label="' + esc(tx('ed.itemDesc')) + '"' + dis + '>' +
        '<input class="form-control inv-item-detail" data-k="detail" value="' + esc(it.detail) + '" placeholder="' + esc(tx('ed.itemDetail')) + '" aria-label="' + esc(tx('ed.itemDetail')) + '"' + dis + '>' +
      '</div>' +
      '<label class="inv-item-qty"><span class="inv-item-lbl">' + esc(tx('ed.qty')) + '</span><input class="form-control" data-k="qty" inputmode="decimal" value="' + esc(it.qty) + '"' + dis + '></label>' +
      '<label class="inv-item-price"><span class="inv-item-lbl">' + esc(tx('ed.price')) + '</span><input class="form-control" data-k="price" inputmode="decimal" value="' + esc(it.price) + '" placeholder="0.00"' + dis + '></label>' +
      '<span class="inv-item-amount fm-money" data-amount></span>' +
      (ro ? '' : '<button type="button" class="btn btn-icon inv-item-del" data-action="inv:item-del" data-i="' + i + '" aria-label="' + esc(tx('ed.removeLine')) + '" title="' + esc(tx('ed.removeLine')) + '"><i class="fas fa-times" aria-hidden="true"></i></button>') +
    '</div>';
  }

  function computeEd(ed) {
    var bad = false;
    var sub = 0;
    ed.items.forEach(function (it) {
      var c = toCents(it.price); var q = toQty(it.qty);
      if (c === null || q === null) { bad = true; it._amount = null; return; }
      it._amount = Math.round(q * c); sub += it._amount;
    });
    var rate = taxRateOf(ed.tax_rate);
    var tax = rate === null ? 0 : Math.round(sub * rate / 100);
    return { sub: sub, tax: tax, total: sub + tax, rate: rate, bad: bad };
  }

  function editorHtml(ed) {
    var ro = ed.status === 'void';
    var dis = ro ? ' disabled' : '';
    var saved = !!ed.id;
    var p = profileById(ed.profile_id);
    var title = saved ? tx('ed.titleSaved', { number: ed.number }) : tx('ed.titleNew');
    var tplOpts = S.profiles.map(function (x) {
      return '<option value="' + x.id + '"' + (String(x.id) === String(ed.profile_id) ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }).join('');
    if (ed.profile_id && !p) tplOpts = '<option value="' + esc(ed.profile_id) + '" selected>' + esc((ed.invoice && ed.invoice.profile_name) || tx('ed.oldTemplate')) + '</option>' + tplOpts;
    var curList = ['CAD', 'USD', 'EUR', 'GBP', 'UAH', 'PLN', 'CHF'];
    if (curList.indexOf(ed.currency) === -1) curList.unshift(ed.currency);

    var statusBtns = '';
    if (saved && ed.status === 'draft') statusBtns += '<button type="button" class="btn" data-action="inv:ed-mark" data-status="sent"><i class="fas fa-paper-plane" aria-hidden="true"></i> ' + esc(tx('act.markSent')) + '</button>';
    if (saved && (ed.status === 'draft' || ed.status === 'sent')) statusBtns += '<button type="button" class="btn" data-action="inv:ed-mark" data-status="paid"><i class="fas fa-check" aria-hidden="true"></i> ' + esc(tx('act.markPaid')) + '</button>';
    if (saved && ed.status === 'paid') statusBtns += '<button type="button" class="btn" data-action="inv:ed-mark" data-status="sent"><i class="fas fa-undo" aria-hidden="true"></i> ' + esc(tx('act.markUnpaid')) + '</button>';

    return '<div class="inv-page inv-editor">' +
      '<button type="button" class="inv-back" data-action="inv:back"><i class="fas fa-arrow-left" aria-hidden="true"></i> ' + esc(tx('ed.back')) + '</button>' +
      headHtml(title, saved ? '' : tx('ed.subNew'), saved ? chip({ status: ed.status, due_date: ed.due_date }) : '') +
      (ro ? '<div class="alert alert-warning">' + esc(tx('ed.voidNote')) + '</div>' : '') +
      (saved && ed.status !== 'draft' && !ro ? '<p class="inv-sub inv-snapnote">' + esc(tx('ed.snapshotNote')) + '</p>' : '') +
      '<form id="inv-form" class="inv-ed-grid" novalidate>' +
        '<div class="inv-ed-main">' +
          '<section class="inv-plate inv-sec"><h2 class="inv-sec-title">' + esc(tx('ed.details')) + '</h2><div class="inv-grid inv-grid-3">' +
            field(tx('ed.template'), '<select class="form-control" name="profile_id"' + dis + '>' + tplOpts + '</select>', 'inv-span-2') +
            field(tx('ed.currency'), '<select class="form-control" name="currency"' + dis + '>' + curList.map(function (c) { return '<option' + (c === ed.currency ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>') +
            field(tx('ed.number'), inputHtml('number', ed.number, ' autocomplete="off"' + dis), '', esc(tx('ed.numberHint'))) +
            field(tx('ed.issueDate'), inputHtml('issue_date', ed.issue_date, ' type="date"' + dis)) +
            field(tx('ed.dueDate'), inputHtml('due_date', ed.due_date, ' type="date"' + dis)) +
          '</div></section>' +
          '<section class="inv-plate inv-sec"><h2 class="inv-sec-title">' + esc(tx('ed.billTo')) + '</h2><div class="inv-grid">' +
            field(tx('ed.clientName'), inputHtml('client_name', ed.client_name, ' autocomplete="organization" placeholder="' + esc(tx('ed.clientNamePh')) + '"' + dis)) +
            field(tx('ed.clientDetails'), textareaHtml('client_details', ed.client_details, 4, ' placeholder="' + esc(tx('ed.clientDetailsPh')) + '"' + dis)) +
          '</div></section>' +
          '<section class="inv-plate inv-sec"><div class="inv-sec-head"><h2 class="inv-sec-title">' + esc(tx('ed.items')) + '</h2></div>' +
            '<div class="inv-items-head" aria-hidden="true"><span>' + esc(tx('ed.itemDesc')) + '</span><span>' + esc(tx('ed.qty')) + '</span><span>' + esc(tx('ed.price')) + '</span><span>' + esc(tx('ed.amount')) + '</span><span></span></div>' +
            '<div id="inv-items">' + ed.items.map(function (it, i) { return itemRowHtml(it, i, ro); }).join('') + '</div>' +
            (ro ? '' : '<button type="button" class="btn inv-add-line" data-action="inv:item-add"><i class="fas fa-plus" aria-hidden="true"></i> ' + esc(tx('ed.addLine')) + '</button>') +
          '</section>' +
          '<section class="inv-plate inv-sec"><h2 class="inv-sec-title">' + esc(tx('ed.taxTerms')) + '</h2><div class="inv-grid inv-grid-3">' +
            field(tx('ed.taxLabel'), inputHtml('tax_label', ed.tax_label, dis), 'inv-span-2') +
            field(tx('ed.taxRate'), inputHtml('tax_rate', ed.tax_rate, ' inputmode="decimal" placeholder="—"' + dis), '', esc(tx('ed.taxRateHint'))) +
            field(tx('ed.taxSub'), inputHtml('tax_sub', ed.tax_sub, dis), 'inv-span-2') +
            field(tx('ed.taxText'), inputHtml('tax_text', ed.tax_text, ' placeholder="' + esc(tx('ed.taxTextPh')) + '"' + dis)) +
          '</div><div class="inv-grid">' +
            field(tx('ed.terms'), textareaHtml('terms', ed.terms, 3, dis)) +
            field(tx('ed.notes'), textareaHtml('notes', ed.notes, 2, ' placeholder="' + esc(tx('ed.notesPh')) + '"' + dis)) +
          '</div></section>' +
        '</div>' +
        '<aside class="inv-ed-side"><div class="inv-plate inv-summary">' +
          '<dl class="inv-totals">' +
            '<div><dt>' + esc(tx('ed.subtotal')) + '</dt><dd class="fm-money" data-t="sub"></dd></div>' +
            '<div><dt data-t="taxlabel"></dt><dd class="fm-money" data-t="tax"></dd></div>' +
            '<div class="inv-total"><dt>' + esc(tx('ed.total')) + '</dt><dd class="fm-money" data-t="total"></dd></div>' +
          '</dl>' +
          '<p class="inv-err" data-t="err" hidden>' + esc(tx('ed.badNumber')) + '</p>' +
          '<div class="inv-side-actions">' +
            (ro ? '' : '<button type="submit" class="btn btn-primary"><i class="fas fa-save" aria-hidden="true"></i> ' + esc(tx(saved ? 'ed.save' : 'ed.saveDraft')) + '</button>') +
            '<button type="button" class="btn" data-action="inv:preview"><i class="fas fa-eye" aria-hidden="true"></i> ' + esc(tx('ed.preview')) + '</button>' +
            (saved ? '<button type="button" class="btn" data-action="inv:pdf" data-id="' + ed.id + '"><i class="fas fa-file-download" aria-hidden="true"></i> ' + esc(tx('act.download')) + '</button>' : '') +
            statusBtns +
          '</div>' +
          '<p class="inv-footnote"><i class="fas fa-info-circle" aria-hidden="true"></i> ' + esc(tx('footerNote')) + '</p>' +
        '</div></aside>' +
        (ro ? '' : '<div class="inv-mbar"><span class="inv-mbar-total"><small>' + esc(tx('ed.total')) + '</small><b class="fm-money" data-t="total"></b></span>' +
          '<button type="button" class="btn" data-action="inv:preview" aria-label="' + esc(tx('ed.preview')) + '"><i class="fas fa-eye" aria-hidden="true"></i></button>' +
          '<button type="submit" class="btn btn-primary">' + esc(tx(saved ? 'ed.save' : 'ed.saveDraft')) + '</button></div>') +
      '</form></div>';
  }

  function readForm(ed) {
    var f = document.getElementById('inv-form');
    if (!f) return ed;
    ['profile_id', 'currency', 'number', 'issue_date', 'due_date', 'client_name', 'client_details', 'tax_label', 'tax_rate', 'tax_sub', 'tax_text', 'terms', 'notes'].forEach(function (k) {
      if (f.elements[k]) ed[k] = f.elements[k].value;
    });
    var rows = f.querySelectorAll('.inv-item');
    ed.items = Array.prototype.map.call(rows, function (row, i) {
      var prev = ed.items[i] || {};
      var get = function (k) { var el = row.querySelector('[data-k="' + k + '"]'); return el ? el.value : ''; };
      return { description: get('description'), detail: get('detail'), note: prev.note || '', qty: get('qty'), price: get('price') };
    });
    return ed;
  }

  function paintTotals(ed) {
    var t = computeEd(ed);
    var f = document.getElementById('inv-form');
    if (!f) return;
    var rows = f.querySelectorAll('.inv-item');
    Array.prototype.forEach.call(rows, function (row, i) {
      var it = ed.items[i]; var cell = row.querySelector('[data-amount]');
      if (cell) cell.textContent = it && it._amount !== null && it._amount !== undefined ? stripHtml(money(it._amount, ed.currency)) : '—';
      row.classList.toggle('is-bad', !!(it && it._amount === null));
    });
    var set = function (k, v) { f.querySelectorAll('[data-t="' + k + '"]').forEach(function (el) { el.textContent = v; }); };
    set('sub', stripHtml(money(t.sub, ed.currency)));
    set('taxlabel', ed.tax_label || tx('ed.tax'));
    set('tax', t.rate === null ? (ed.tax_text || '—') : stripHtml(money(t.tax, ed.currency)));
    set('total', stripHtml(money(t.total, ed.currency)));
    var err = f.querySelector('[data-t="err"]');
    if (err) err.hidden = !t.bad;
  }
  function stripHtml(s) { var d = document.createElement('div'); d.innerHTML = s; return d.textContent; }

  function bodyOf(ed) {
    return {
      profile_id: ed.profile_id ? Number(ed.profile_id) : undefined,
      number: ed.number.trim(), issue_date: ed.issue_date, due_date: ed.due_date || null, currency: ed.currency,
      client_name: ed.client_name, client_details: ed.client_details,
      items: ed.items.filter(function (it) { return it.description.trim() || String(it.price).trim(); }).map(function (it) {
        var o = { description: it.description, qty: it.qty, price: it.price };
        if (it.detail) o.detail = it.detail;
        if (it.note) o.note = it.note;
        return o;
      }),
      tax_rate: String(ed.tax_rate).trim() === '' ? null : ed.tax_rate,
      tax_label: ed.tax_label, tax_sub: ed.tax_sub, tax_text: ed.tax_text, terms: ed.terms, notes: ed.notes
    };
  }

  function renderEditor() {
    S.view = 'editor';
    var ed = S.ed;
    main().innerHTML = editorHtml(ed);
    var f = document.getElementById('inv-form');
    paintTotals(ed);
    if (ed.status === 'void') return;
    f.addEventListener('input', function (e) {
      if (e.target.name === 'number') ed.numberTouched = true;
      if (e.target.name === 'due_date') ed.dueTouched = true;
      readForm(ed); paintTotals(ed);
    });
    f.addEventListener('change', async function (e) {
      var n = e.target.name;
      if (n === 'profile_id') { readForm(ed); await applyTemplate(ed); return; }
      if (n === 'issue_date') {
        readForm(ed);
        var p = profileById(ed.profile_id);
        if (!ed.dueTouched && p) { ed.due_date = addDays(ed.issue_date, p.due_days); f.elements.due_date.value = ed.due_date; }
        if (!ed.numberTouched && p) await refreshNumber(ed);
      }
    });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (root.UI && root.UI.busy) root.UI.busy(f, function () { return saveInvoice(); }).catch(function () {});
      else saveInvoice();
    });
  }

  async function refreshNumber(ed) {
    if (!ed.profile_id) return;
    try {
      var d = await api('/next-number?profile_id=' + ed.profile_id + '&date=' + encodeURIComponent(ed.issue_date || today()));
      ed.number = d.number;
      var f = document.getElementById('inv-form');
      if (f) f.elements.number.value = ed.number;
    } catch (e) { /* keep */ }
  }

  // Template switch: currency, due date, tax, terms and number follow the new template.
  async function applyTemplate(ed) {
    var p = profileById(ed.profile_id);
    if (!p) return;
    var d = mergedData(p);
    ed.currency = p.currency;
    if (!ed.dueTouched) ed.due_date = addDays(ed.issue_date, p.due_days);
    var tax = d.tax || {};
    ed.tax_rate = tax.rate != null ? String(tax.rate) : '';
    ed.tax_label = tax.label || ''; ed.tax_sub = tax.sub || ''; ed.tax_text = tax.text || '';
    ed.terms = d.terms || '';
    if (!ed.numberTouched) {
      try { ed.number = (await api('/next-number?profile_id=' + p.id + '&date=' + encodeURIComponent(ed.issue_date))).number; } catch (e) { /* keep */ }
    }
    renderEditor();
  }

  async function saveInvoice() {
    var ed = readForm(S.ed);
    var t = computeEd(ed);
    if (t.bad) { toast(tx('ed.badNumber'), 'error'); return; }
    if (!ed.client_name.trim()) {
      toast(tx('ed.needClient'), 'error');
      var f = document.getElementById('inv-form'); if (f) f.elements.client_name.focus();
      return;
    }
    try {
      var d = ed.id
        ? await api('/' + ed.id, { method: 'PUT', body: bodyOf(ed) })
        : await api('/', { method: 'POST', body: bodyOf(ed) });
      var fresh = !ed.id;
      S.ed = stateFromInvoice(d.invoice);
      history.replaceState({}, '', '/invoices');
      renderEditor();
      toast(tx(fresh ? 'toast.created' : 'toast.saved', { number: d.invoice.number }), 'success');
      loadProfiles().catch(function () {});
    } catch (e) { toast(e.message, 'error'); }
  }

  async function previewEditor() {
    var ed = readForm(S.ed);
    if (computeEd(ed).bad) { toast(tx('ed.badNumber'), 'error'); return; }
    var w = preOpenTab();
    try {
      var r;
      if (ed.status === 'void' && ed.id) r = await api('/' + ed.id + '/pdf', { blob: true });
      else r = await api('/preview', { method: 'POST', body: bodyOf(ed), blob: true });
      showPdf(r.blob, tx('preview.title', { number: ed.number || '' }), w);
    } catch (e) {
      if (w) try { w.close(); } catch (x) { /* ignore */ }
      toast(e.message, 'error');
    }
  }

  async function openInvoice(id) {
    try {
      var d = await api('/' + id);
      S.ed = stateFromInvoice(d.invoice);
      renderEditor();
      root.scrollTo && root.scrollTo(0, 0);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function downloadPdf(id) {
    var inv = S.invoices.find(function (x) { return String(x.id) === String(id); }) || (S.ed && S.ed.invoice) || {};
    try {
      var r = await api('/' + id + '/pdf?download=1', { blob: true });
      saveBlob(r.blob, filenameFrom(r.res, 'Invoice_' + (inv.number || id) + '.pdf'));
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- templates ----------
  function tplCardHtml(p) {
    var d = p.data || {};
    var seller = (d.seller && d.seller.name) || '';
    return '<li class="inv-plate inv-tpl' + (S.highlight === p.id ? ' is-new' : '') + '" data-id="' + p.id + '">' +
      '<div class="inv-tpl-top">' +
        '<span class="inv-preset-sheet inv-preset-' + esc(p.layout) + ' is-mini" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
        '<div class="inv-tpl-id"><h3 class="inv-tpl-name">' + esc(p.name) + '</h3>' +
        '<p class="inv-tpl-seller">' + esc(seller || tx('tpl.noSeller')) + '</p>' +
        (p.is_default ? '<span class="inv-chip inv-chip-default">' + esc(tx('tpl.default')) + '</span>' : '') + '</div>' +
        '<div class="inv-tpl-corner">' +
        '<details class="inv-menu"><summary class="btn btn-icon btn-sm" aria-label="' + esc(tx('act.more')) + '"><i class="fas fa-ellipsis-h" aria-hidden="true"></i></summary><div class="inv-menu-pop" role="menu">' +
          (p.is_default ? '' : '<button type="button" role="menuitem" class="inv-menu-item" data-action="inv:tpl-default" data-id="' + p.id + '"><i class="fas fa-star" aria-hidden="true"></i><span>' + esc(tx('tpl.makeDefault')) + '</span></button>') +
          '<button type="button" role="menuitem" class="inv-menu-item is-danger" data-action="inv:tpl-delete" data-id="' + p.id + '"><i class="fas fa-trash-alt" aria-hidden="true"></i><span>' + esc(tx('act.delete')) + '</span></button>' +
        '</div></details>' +
        '</div>' +
      '</div>' +
      '<dl class="inv-tpl-meta">' +
        '<div><dt>' + esc(tx('tpl.layout')) + '</dt><dd>' + esc(tx(p.layout === 'light' ? 'preset.light' : 'preset.classic')) + '</dd></div>' +
        '<div><dt>' + esc(tx('ed.currency')) + '</dt><dd>' + esc(p.currency) + '</dd></div>' +
        '<div><dt>' + esc(tx('tpl.next')) + '</dt><dd>' + esc(sampleNumber(p.number_format, today(), p.next_seq)) + '</dd></div>' +
      '</dl>' +
      '<div class="inv-tpl-actions">' +
        '<button type="button" class="btn btn-sm btn-primary" data-action="inv:new" data-profile="' + p.id + '"><i class="fas fa-plus" aria-hidden="true"></i> ' + esc(tx('tpl.useIt')) + '</button>' +
        '<button type="button" class="btn btn-sm" data-action="inv:tpl-edit" data-id="' + p.id + '">' + esc(tx('btn.edit')) + '</button>' +
        '<button type="button" class="btn btn-sm" data-action="inv:tpl-share" data-id="' + p.id + '"><i class="fas fa-share-alt" aria-hidden="true"></i> ' + esc(tx('tpl.share')) + '</button>' +
      '</div></li>';
  }

  function renderTemplates() {
    S.view = 'templates';
    var actions = (S.profiles.length ? viewSwitch() : '') + '<button type="button" class="btn btn-primary" data-action="inv:tpl-new"><i class="fas fa-plus" aria-hidden="true"></i> ' + esc(tx('tpl.new')) + '</button>';
    var html = '<div class="inv-page">' + headHtml(tx('title'), tx('tpl.subtitle'), actions);
    html += S.profiles.length
      ? '<ul class="inv-tpls">' + S.profiles.map(tplCardHtml).join('') + '</ul>'
      : emptyFirstHtml();
    html += '<p class="inv-footnote inv-footnote-page"><i class="fas fa-info-circle" aria-hidden="true"></i> ' + esc(tx('footerNote')) + '</p></div>';
    main().innerHTML = html;
    S.highlight = null;
  }

  function newTemplateModal() {
    var host = root.UI.modal({
      title: tx('tpl.newTitle'),
      body: '<p class="inv-confirm-text">' + esc(tx('tpl.newText')) + '</p>' + presetCards('inv:tpl-from-preset')
    });
    return host;
  }

  async function createFromPreset(key) {
    var p = (S.presets || []).find(function (x) { return x.key === key; });
    if (!p) return;
    root.UI.closeTopModal && document.querySelector('.modal-backdrop.is-open') && root.UI.closeTopModal();
    S.tpl = {
      id: null, name: '', layout: p.layout, currency: p.currency, number_format: p.number_format, next_seq: 1,
      due_days: p.due_days, is_default: S.profiles.length ? 0 : 1, data: JSON.parse(JSON.stringify(p.data || {})),
      logo: undefined, signature: undefined, has_logo: false, has_signature: false
    };
    renderTplEditor();
  }

  async function editTemplate(id) {
    try {
      var d = await api('/profiles/' + id);
      var p = d.profile;
      S.tpl = Object.assign({}, p, { data: mergedData(p), logo: undefined, signature: undefined });
      renderTplEditor();
    } catch (e) { toast(e.message, 'error'); }
  }

  function kvRowsHtml(list, name) {
    return (list || []).map(function (r, i) {
      return '<div class="inv-kv" data-i="' + i + '">' +
        '<input class="form-control" data-kv="k" value="' + esc(r.k) + '" placeholder="' + esc(tx('tpl.kvLabel')) + '" aria-label="' + esc(tx('tpl.kvLabel')) + '">' +
        '<input class="form-control" data-kv="v" value="' + esc(r.v) + '" placeholder="' + esc(tx('tpl.kvValue')) + '" aria-label="' + esc(tx('tpl.kvValue')) + '">' +
        '<button type="button" class="btn btn-icon" data-action="inv:kv-del" data-list="' + name + '" data-i="' + i + '" aria-label="' + esc(tx('ed.removeLine')) + '"><i class="fas fa-times" aria-hidden="true"></i></button>' +
      '</div>';
    }).join('');
  }

  function toggleSec(name, on, title, inner, hint) {
    return '<section class="inv-plate inv-sec inv-opt' + (on ? ' is-on' : '') + '" data-opt="' + name + '">' +
      '<label class="inv-opt-head"><input type="checkbox" name="opt_' + name + '"' + (on ? ' checked' : '') + '>' +
      '<span><b class="inv-sec-title">' + esc(title) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span></label>' +
      '<div class="inv-opt-body">' + inner + '</div></section>';
  }

  function imageBox(kind, has) {
    return '<div class="inv-img" data-kind="' + kind + '">' +
      '<div class="inv-img-well" data-img-well>' + (has ? '<span class="inv-img-wait">' + esc(tx('tpl.imgLoading')) + '</span>' : '<span class="inv-img-none">' + esc(tx('tpl.imgNone')) + '</span>') + '</div>' +
      '<div class="inv-img-actions">' +
        '<label class="btn btn-sm"><i class="fas fa-upload" aria-hidden="true"></i> ' + esc(tx('tpl.imgUpload')) +
          '<input type="file" accept="image/png,image/jpeg" class="sr-only" data-img-input="' + kind + '"></label>' +
        '<button type="button" class="btn btn-sm" data-action="inv:img-remove" data-kind="' + kind + '"' + (has ? '' : ' hidden') + '>' + esc(tx('tpl.imgRemove')) + '</button>' +
      '</div></div>';
  }

  function tplEditorHtml(p) {
    var d = p.data || {};
    var seller = d.seller || {};
    var tax = d.tax || {};
    var words = d.words || {};
    var bank = d.bank || null;
    var pay = d.pay_online || null;
    var signer = d.signer || null;
    var light = p.layout === 'light';
    var f = function (label, name, value, attrs, cls, hint) { return field(label, inputHtml(name, value == null ? '' : value, attrs || ''), cls, hint); };
    var ta = function (label, name, value, rows, cls, hint) { return field(label, textareaHtml(name, value == null ? '' : value, rows), cls, hint); };

    return '<div class="inv-page inv-tpl-editor">' +
      '<button type="button" class="inv-back" data-action="inv:view" data-view="templates"><i class="fas fa-arrow-left" aria-hidden="true"></i> ' + esc(tx('tpl.back')) + '</button>' +
      headHtml(p.id ? tx('tpl.editTitle', { name: p.name }) : tx('tpl.newTitle'), tx('tpl.editSub'), '') +
      '<form id="inv-tpl-form" class="inv-tpl-form" novalidate>' +
        '<section class="inv-plate inv-sec"><h2 class="inv-sec-title">' + esc(tx('tpl.basics')) + '</h2><div class="inv-grid inv-grid-3">' +
          f(tx('tpl.name'), 'name', p.name, ' required placeholder="' + esc(tx('tpl.namePh')) + '"', 'inv-span-2') +
          field(tx('tpl.layout'), '<select class="form-control" name="layout"><option value="classic"' + (light ? '' : ' selected') + '>' + esc(tx('preset.classic')) + '</option><option value="light"' + (light ? ' selected' : '') + '>' + esc(tx('preset.light')) + '</option></select>') +
          f(tx('tpl.numberFormat'), 'number_format', p.number_format, ' autocomplete="off" spellcheck="false"', 'inv-span-2',
            esc(tx('tpl.numberHint')) + ' <span class="inv-sample">' + esc(tx('tpl.sample')) + ' <b data-sample>' + esc(sampleNumber(p.number_format, today(), p.next_seq)) + '</b></span>') +
          f(tx('ed.currency'), 'currency', p.currency, ' maxlength="3" autocapitalize="characters" spellcheck="false"') +
          f(tx('tpl.nextSeq'), 'next_seq', p.next_seq, ' type="number" min="1" step="1"', '', esc(tx('tpl.nextSeqHint'))) +
          f(tx('tpl.dueDays'), 'due_days', p.due_days, ' type="number" min="0" max="365" step="1"') +
        '</div></section>' +
        '<section class="inv-plate inv-sec"><h2 class="inv-sec-title">' + esc(tx('tpl.seller')) + '</h2><div class="inv-grid inv-grid-3">' +
          f(tx('tpl.sellerName'), 'seller_name', seller.name, ' placeholder="' + esc(tx('tpl.sellerNamePh')) + '"', 'inv-span-2') +
          (light ? '' : f(tx('tpl.sellerLabel'), 'seller_label', seller.label)) +
          ta(tx('tpl.sellerLines'), 'seller_lines', (seller.lines || []).join('\n'), 4, 'inv-span-3', esc(tx('tpl.linesHint'))) +
          f(tx('tpl.clientLabel'), 'client_label', d.client_label, '', 'inv-span-2') +
        '</div></section>' +
        toggleSec('bank', !!bank, tx('tpl.bank'),
          '<div class="inv-grid">' + f(tx('tpl.bankTitle'), 'bank_title', bank && bank.title) + '</div>' +
          '<p class="form-label inv-kv-title">' + esc(tx('tpl.bankKey')) + '</p><div class="inv-kvs" data-kv-list="key">' + kvRowsHtml(bank ? bank.key : [{ k: '', v: '' }], 'key') + '</div>' +
          '<button type="button" class="btn btn-sm" data-action="inv:kv-add" data-list="key"><i class="fas fa-plus" aria-hidden="true"></i> ' + esc(tx('tpl.addRow')) + '</button>' +
          '<p class="form-label inv-kv-title">' + esc(tx('tpl.bankRest')) + ' <span class="inv-hint">' + esc(tx('tpl.boldHint')) + '</span></p><div class="inv-kvs" data-kv-list="rest">' + kvRowsHtml(bank ? bank.rest : [], 'rest') + '</div>' +
          '<button type="button" class="btn btn-sm" data-action="inv:kv-add" data-list="rest"><i class="fas fa-plus" aria-hidden="true"></i> ' + esc(tx('tpl.addRow')) + '</button>' +
          '<div class="inv-grid">' + ta(tx('tpl.bankNote'), 'bank_note', bank && bank.note, 2) + '</div>',
          tx('tpl.bankHint')) +
        '<section class="inv-plate inv-sec"><h2 class="inv-sec-title">' + esc(tx('ed.taxTerms')) + '</h2><div class="inv-grid inv-grid-3">' +
          f(tx('ed.taxLabel'), 'tax_label', tax.label, '', 'inv-span-2') +
          f(tx('ed.taxRate'), 'tax_rate', tax.rate == null ? '' : tax.rate, ' inputmode="decimal" placeholder="—"', '', esc(tx('ed.taxRateHint'))) +
          f(tx('ed.taxSub'), 'tax_sub', tax.sub, '', 'inv-span-2') +
          f(tx('ed.taxText'), 'tax_text', tax.text, ' placeholder="' + esc(tx('ed.taxTextPh')) + '"') +
          f(tx('tpl.payRef'), 'payment_reference', d.payment_reference, '', 'inv-span-3', esc(tx('tpl.placeholders'))) +
          ta(tx('ed.terms'), 'terms', d.terms, 3, 'inv-span-3') +
        '</div></section>' +
        toggleSec('pay', !!pay, tx('tpl.pay'),
          '<div class="inv-grid inv-grid-3">' +
            f(tx('tpl.payUrl'), 'pay_url', pay && pay.url, ' type="url" inputmode="url" spellcheck="false" placeholder="https://"', 'inv-span-3', esc(tx('tpl.payUrlHint'))) +
            f(tx('tpl.payLabel'), 'pay_label', pay && pay.label, '', 'inv-span-2') +
            f(tx('tpl.payCurrencies'), 'pay_currencies', pay && pay.currencies ? pay.currencies.join(', ') : p.currency, ' spellcheck="false"') +
          '</div>', tx('tpl.payHint')) +
        toggleSec('signer', !!signer, tx('tpl.signer'),
          '<div class="inv-grid">' + f(tx('tpl.signerTitle'), 'signer_title', signer && signer.title) +
          ta(tx('tpl.signerLines'), 'signer_lines', signer && signer.lines ? signer.lines.join('\n') : '', 2, '', esc(tx('tpl.linesHint'))) + '</div>') +
        '<section class="inv-plate inv-sec"><h2 class="inv-sec-title">' + esc(tx('tpl.images')) + '</h2>' +
          '<p class="inv-sub">' + esc(tx('tpl.imagesHint')) + '</p>' +
          '<div class="inv-imgs"><div><p class="form-label">' + esc(tx('tpl.logo')) + '</p>' + imageBox('logo', p.has_logo) + '</div>' +
          '<div><p class="form-label">' + esc(tx('tpl.signature')) + '</p>' + imageBox('signature', p.has_signature) + '</div></div>' +
        '</section>' +
        '<details class="inv-plate inv-sec inv-adv"><summary><span class="inv-sec-title">' + esc(tx('tpl.advanced')) + '</span><small>' + esc(tx('tpl.advancedHint')) + '</small></summary>' +
          '<div class="inv-grid inv-grid-3">' +
            f(tx('tpl.docTitle'), 'title', d.title) +
            f(tx('tpl.heading'), 'heading', d.heading, '', 'inv-span-2') +
            (light ? f(tx('tpl.dateLine'), 'date_line', d.date_line, '', 'inv-span-3') : f(tx('tpl.dueLine'), 'due_line', d.due_line, '', 'inv-span-3')) +
            f(tx('tpl.itemHeader'), 'item_header', d.item_header) +
            f(tx('tpl.qtyHeader'), 'qty_header', d.qty_header) +
            f(tx('tpl.priceHeader'), 'price_header', d.price_header) +
            f(tx('tpl.amountHeader'), 'amount_header', d.amount_header) +
            field(tx('tpl.moneyStyle'), '<select class="form-control" name="money_style"><option value="code"' + (d.money_style === 'symbol' ? '' : ' selected') + '>' + esc(tx('tpl.moneyCode')) + '</option><option value="symbol"' + (d.money_style === 'symbol' ? ' selected' : '') + '>' + esc(tx('tpl.moneySymbol')) + '</option></select>') +
            f(tx('tpl.symbol'), 'symbol', d.symbol, ' maxlength="4"') +
            (light ? '' : '<label class="inv-check inv-span-3"><input type="checkbox" name="words_enabled"' + (words.enabled ? ' checked' : '') + '> <span>' + esc(tx('tpl.words')) + '</span></label>' +
              f(tx('tpl.wordsPrefix'), 'words_prefix', words.prefix, '', 'inv-span-2') +
              f(tx('tpl.wordsNote'), 'words_note', words.note) +
              '<label class="inv-check inv-span-3"><input type="checkbox" name="bank_before_client"' + (d.bank_before_client ? ' checked' : '') + '> <span>' + esc(tx('tpl.bankFirst')) + '</span></label>') +
          '</div><p class="inv-hint">' + esc(tx('tpl.placeholders')) + '</p>' +
        '</details>' +
        '<div class="inv-savebar">' +
          '<p class="inv-footnote"><i class="fas fa-info-circle" aria-hidden="true"></i> ' + esc(tx('footerNote')) + '</p>' +
          '<div class="inv-savebar-btns">' +
            '<button type="button" class="btn" data-action="inv:view" data-view="templates">' + esc(tx('btn.cancel')) + '</button>' +
            '<button type="submit" class="btn btn-primary"><i class="fas fa-save" aria-hidden="true"></i> ' + esc(tx('tpl.save')) + '</button>' +
          '</div></div>' +
      '</form></div>';
  }

  function readKv(form, list) {
    var box = form.querySelector('[data-kv-list="' + list + '"]');
    if (!box) return [];
    return Array.prototype.map.call(box.querySelectorAll('.inv-kv'), function (row) {
      return { k: row.querySelector('[data-kv="k"]').value, v: row.querySelector('[data-kv="v"]').value };
    });
  }
  function lines(v) { return String(v || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }

  // Form -> profile body. Keys the form does not show (qty_width, signature_width…) are kept.
  function readTplForm() {
    var p = S.tpl;
    var form = document.getElementById('inv-tpl-form');
    var el = form.elements;
    var v = function (n) { return el[n] ? el[n].value : undefined; };
    var d = JSON.parse(JSON.stringify(p.data || {}));
    var layout = v('layout') || p.layout;
    d.seller = Object.assign({}, d.seller || {}, { name: v('seller_name').trim(), lines: lines(v('seller_lines')) });
    if (el.seller_label) d.seller.label = v('seller_label');
    d.client_label = v('client_label');
    if (el.opt_bank.checked) {
      d.bank = Object.assign({}, d.bank || {}, {
        title: v('bank_title'),
        key: readKv(form, 'key').filter(function (r) { return r.k.trim() || r.v.trim(); }),
        rest: readKv(form, 'rest').filter(function (r) { return r.k.trim() || r.v.trim(); }),
        note: v('bank_note')
      });
    } else d.bank = null;
    var rate = taxRateOf(v('tax_rate'));
    d.tax = Object.assign({}, d.tax || {}, { label: v('tax_label'), sub: v('tax_sub'), rate: rate, text: v('tax_text') });
    d.payment_reference = v('payment_reference');
    d.terms = v('terms');
    if (el.opt_pay.checked) {
      d.pay_online = {
        url: v('pay_url').trim(), label: v('pay_label'),
        currencies: String(v('pay_currencies') || '').toUpperCase().split(/[\s,;]+/).filter(function (c) { return /^[A-Z]{3}$/.test(c); })
      };
    } else d.pay_online = null;
    if (el.opt_signer.checked) d.signer = { title: v('signer_title'), lines: lines(v('signer_lines')) };
    else d.signer = null;
    ['title', 'heading', 'due_line', 'date_line', 'item_header', 'qty_header', 'price_header', 'amount_header', 'money_style', 'symbol'].forEach(function (k) {
      if (el[k]) d[k] = v(k);
    });
    if (el.words_enabled) d.words = Object.assign({}, d.words || {}, { enabled: el.words_enabled.checked, prefix: v('words_prefix'), note: v('words_note') });
    if (el.bank_before_client) d.bank_before_client = el.bank_before_client.checked;

    var body = {
      name: v('name').trim(), layout: layout, currency: String(v('currency') || '').trim().toUpperCase(),
      number_format: v('number_format').trim(), next_seq: parseInt(v('next_seq'), 10) || 1,
      due_days: parseInt(v('due_days'), 10), data: d
    };
    if (!p.id) body.is_default = p.is_default;
    if (p.logo !== undefined) body.logo = p.logo;
    if (p.signature !== undefined) body.signature = p.signature;
    return body;
  }

  function renderTplEditor() {
    S.view = 'tpl-editor';
    var p = S.tpl;
    main().innerHTML = tplEditorHtml(p);
    root.scrollTo && root.scrollTo(0, 0);
    var form = document.getElementById('inv-tpl-form');
    var sample = form.querySelector('[data-sample]');
    var paintSample = function () {
      if (sample) sample.textContent = sampleNumber(form.elements.number_format.value, today(), form.elements.next_seq.value);
    };
    form.addEventListener('input', function (e) {
      if (e.target.name === 'number_format' || e.target.name === 'next_seq') paintSample();
    });
    form.addEventListener('change', function (e) {
      var t = e.target;
      if (/^opt_/.test(t.name || '')) {
        var sec = t.closest('.inv-opt'); if (sec) sec.classList.toggle('is-on', t.checked);
      }
      if (t.name === 'layout') {
        // Layout switch re-renders the form with that layout's own fields.
        var body = readTplForm();
        var base = (presetFor(t.value) || {}).data || {};
        S.tpl = Object.assign({}, S.tpl, body, { data: Object.assign({}, base, pickKept(body.data)) });
        renderTplEditor();
      }
      if (t.matches && t.matches('[data-img-input]')) pickImage(t);
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (root.UI && root.UI.busy) root.UI.busy(form, saveTemplate).catch(function () {});
      else saveTemplate();
    });
    ['logo', 'signature'].forEach(function (kind) {
      if (p[kind] && typeof p[kind] === 'string') setWell(kind, p[kind]);
      else if (p.id && p['has_' + kind] && p[kind] !== null) loadImage(p.id, kind);
    });
  }
  // On a layout switch keep what the person typed, drop layout-only wording.
  function pickKept(d) {
    var out = {};
    ['seller', 'client_label', 'bank', 'tax', 'payment_reference', 'pay_online', 'terms', 'signer'].forEach(function (k) {
      if (d[k] !== undefined) out[k] = d[k];
    });
    return out;
  }

  function setWell(kind, src) {
    var box = document.querySelector('.inv-img[data-kind="' + kind + '"]');
    if (!box) return;
    var well = box.querySelector('[data-img-well]');
    var rm = box.querySelector('[data-action="inv:img-remove"]');
    if (src) {
      well.innerHTML = '<img src="' + esc(src) + '" alt="' + esc(tx(kind === 'logo' ? 'tpl.logo' : 'tpl.signature')) + '">';
      if (rm) rm.hidden = false;
    } else {
      well.innerHTML = '<span class="inv-img-none">' + esc(tx('tpl.imgNone')) + '</span>';
      if (rm) rm.hidden = true;
    }
  }
  async function loadImage(id, kind) {
    try {
      var r = await api('/profiles/' + id + '/image/' + kind, { blob: true });
      setWell(kind, trackUrl(URL.createObjectURL(r.blob)));
    } catch (e) { setWell(kind, null); }
  }
  function pickImage(input) {
    var file = input.files && input.files[0];
    var kind = input.getAttribute('data-img-input');
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast(tx('tpl.imgType'), 'error'); input.value = ''; return; }
    if (file.size > IMG_MAX) { toast(tx('tpl.imgSize'), 'error'); input.value = ''; return; }
    var reader = new FileReader();
    reader.onload = function () { S.tpl[kind] = String(reader.result); setWell(kind, S.tpl[kind]); };
    reader.onerror = function () { toast(tx('tpl.imgType'), 'error'); };
    reader.readAsDataURL(file);
  }

  async function saveTemplate() {
    var form = document.getElementById('inv-tpl-form');
    var body = readTplForm();
    if (!body.name) { toast(tx('tpl.needName'), 'error'); form.elements.name.focus(); return; }
    if (!/^[A-Z]{3}$/.test(body.currency)) { toast(tx('tpl.needCurrency'), 'error'); form.elements.currency.focus(); return; }
    if (body.data.pay_online && !/^https:\/\//i.test(body.data.pay_online.url)) { toast(tx('tpl.needHttps'), 'error'); form.elements.pay_url.focus(); return; }
    try {
      var d = S.tpl.id
        ? await api('/profiles/' + S.tpl.id, { method: 'PUT', body: body })
        : await api('/profiles', { method: 'POST', body: body });
      await loadProfiles();
      S.highlight = d.profile.id;
      toast(tx('toast.tplSaved', { name: d.profile.name }), 'success');
      releaseUrls();
      renderTemplates();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function shareTemplate(id) {
    try {
      var d = await api('/profiles/' + id + '/share', { method: 'POST' });
      var copied = false;
      try { if (navigator.clipboard) { await navigator.clipboard.writeText(d.url); copied = true; } } catch (e) { copied = false; }
      var host = root.UI.modal({
        title: tx('share.title'),
        body: '<p class="inv-confirm-text">' + esc(tx('share.text')) + '</p>' +
          '<div class="inv-share"><input class="form-control" readonly value="' + esc(d.url) + '" aria-label="' + esc(tx('share.title')) + '">' +
          '<button type="button" class="btn btn-primary" data-inv-copy>' + esc(tx(copied ? 'share.copied' : 'share.copy')) + '</button></div>' +
          '<p class="inv-hint">' + esc(tx('share.privacy')) + '</p>'
      });
      if (!host) return;
      var input = host.querySelector('.inv-share input');
      input.addEventListener('focus', function () { input.select(); });
      host.querySelector('[data-inv-copy]').addEventListener('click', async function (e) {
        input.select();
        try { await navigator.clipboard.writeText(d.url); } catch (x) { try { document.execCommand('copy'); } catch (y) { /* ignore */ } }
        e.currentTarget.textContent = tx('share.copied');
      });
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- shared template import (after sign-up / sign-in) ----------
  async function maybeImport() {
    var code = null;
    try { code = root.localStorage.getItem(TPL_KEY); } catch (e) { return false; }
    if (!code) return false;
    try { root.localStorage.removeItem(TPL_KEY); } catch (e) { /* ignore */ }
    var tpl;
    try {
      var r = await fetch(API + '/shared/' + encodeURIComponent(code));
      if (!r.ok) throw await root.readApiError(r, tx('import.missing'));
      tpl = (await r.json()).template;
    } catch (e) { toast(tx('import.missing'), 'warning'); return false; }
    var ok = await confirmBox(tx('import.title'),
      tx('import.text', { name: tpl.name, seller: tpl.seller_name || '—' }), tx('import.ok'), false);
    if (!ok) return false;
    try {
      var d = await api('/shared/' + encodeURIComponent(code) + '/import', { method: 'POST' });
      await loadProfiles();
      S.highlight = d.profile.id;
      toast(tx('import.done', { name: d.profile.name }), 'success');
      renderTemplates();
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  // ---------- actions ----------
  function closeMenus(except) {
    document.querySelectorAll('.inv-menu[open]').forEach(function (m) { if (m !== except) m.removeAttribute('open'); });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      var inside = e.target.closest && e.target.closest('.inv-menu');
      closeMenus(inside);
      if (e.target.closest && e.target.closest('.inv-menu-item')) closeMenus(null);
    });
  }

  async function setStatus(id, status) {
    try {
      var d = await api('/' + id + '/status', { method: 'POST', body: { status: status } });
      toast(tx('toast.status', { number: d.invoice.number, status: tx('status.' + status) }), 'success');
      return d.invoice;
    } catch (e) { toast(e.message, 'error'); return null; }
  }

  function registerActions() {
    if (!root.UI || typeof root.UI.actions !== 'function') return;
    root.UI.actions({
      'inv:view': function (el) {
        releaseUrls();
        var v = el.dataset.view;
        if (v === 'templates') renderTemplates();
        else refreshList().catch(function (e) { toast(e.message, 'error'); });
      },
      'inv:back': function () { refreshList().catch(function (e) { toast(e.message, 'error'); }); },
      'inv:status-filter': async function (el) {
        S.status = el.dataset.status;
        try { await refreshList(); } catch (e) { toast(e.message, 'error'); }
      },
      'inv:new': async function (el) {
        if (!S.profiles.length) { renderList(); return; }
        S.ed = await newInvoiceState(el.dataset.profile);
        renderEditor();
        root.scrollTo && root.scrollTo(0, 0);
      },
      'inv:open': function (el) { return openInvoice(el.dataset.id); },
      'inv:pdf': function (el) { return downloadPdf(el.dataset.id); },
      'inv:duplicate': async function (el) {
        try {
          var d = await api('/' + el.dataset.id + '/duplicate', { method: 'POST' });
          toast(tx('toast.duplicated', { number: d.invoice.number }), 'success');
          S.ed = stateFromInvoice(d.invoice);
          renderEditor();
        } catch (e) { toast(e.message, 'error'); }
      },
      'inv:mark': async function (el) {
        if (await setStatus(el.dataset.id, el.dataset.status)) await refreshList();
      },
      'inv:void': async function (el) {
        var inv = S.invoices.find(function (x) { return String(x.id) === String(el.dataset.id); }) || {};
        if (!(await confirmBox(tx('void.title'), tx('void.text', { number: inv.number || '' }), tx('act.void'), true))) return;
        if (await setStatus(el.dataset.id, 'void')) await refreshList();
      },
      'inv:delete': async function (el) {
        var inv = S.invoices.find(function (x) { return String(x.id) === String(el.dataset.id); }) || (S.ed && S.ed.invoice) || {};
        if (!(await confirmBox(tx('delete.title'), tx('delete.text', { number: inv.number || '' }), tx('act.delete'), true))) return;
        try {
          await api('/' + el.dataset.id, { method: 'DELETE' });
          toast(tx('toast.deleted', { number: inv.number || '' }), 'success');
          await refreshList();
        } catch (e) { toast(e.message, 'error'); }
      },
      'inv:ed-mark': async function (el) {
        var inv = await setStatus(S.ed.id, el.dataset.status);
        if (inv) { S.ed = stateFromInvoice(inv); renderEditor(); }
      },
      'inv:preview': function () { return previewEditor(); },
      'inv:item-add': function () {
        readForm(S.ed);
        S.ed.items.push(blankItem());
        var box = document.getElementById('inv-items');
        box.insertAdjacentHTML('beforeend', itemRowHtml(S.ed.items[S.ed.items.length - 1], S.ed.items.length - 1, false));
        paintTotals(S.ed);
        var last = box.lastElementChild.querySelector('[data-k="description"]');
        if (last) last.focus();
      },
      'inv:item-del': function (el) {
        readForm(S.ed);
        S.ed.items.splice(Number(el.dataset.i), 1);
        if (!S.ed.items.length) S.ed.items.push(blankItem());
        document.getElementById('inv-items').innerHTML = S.ed.items.map(function (it, i) { return itemRowHtml(it, i, false); }).join('');
        paintTotals(S.ed);
      },
      'inv:tpl-new': async function () {
        try { await loadPresets(); } catch (e) { toast(e.message, 'error'); return; }
        newTemplateModal();
      },
      'inv:tpl-from-preset': function (el) { return createFromPreset(el.dataset.preset); },
      'inv:tpl-edit': function (el) { return editTemplate(el.dataset.id); },
      'inv:tpl-share': function (el) { return shareTemplate(el.dataset.id); },
      'inv:tpl-default': async function (el) {
        try {
          await api('/profiles/' + el.dataset.id, { method: 'PUT', body: { is_default: 1 } });
          await loadProfiles();
          renderTemplates();
        } catch (e) { toast(e.message, 'error'); }
      },
      'inv:tpl-delete': async function (el) {
        var p = profileById(el.dataset.id) || {};
        if (!(await confirmBox(tx('tplDelete.title'), tx('tplDelete.text', { name: p.name || '' }), tx('act.delete'), true))) return;
        try {
          await api('/profiles/' + el.dataset.id, { method: 'DELETE' });
          await loadProfiles();
          toast(tx('toast.tplDeleted', { name: p.name || '' }), 'success');
          renderTemplates();
        } catch (e) { toast(e.message, 'error'); }
      },
      'inv:kv-add': function (el) {
        var form = document.getElementById('inv-tpl-form');
        var list = el.dataset.list;
        var rows = readKv(form, list); rows.push({ k: '', v: '' });
        form.querySelector('[data-kv-list="' + list + '"]').innerHTML = kvRowsHtml(rows, list);
        var inputs = form.querySelectorAll('[data-kv-list="' + list + '"] [data-kv="k"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      },
      'inv:kv-del': function (el) {
        var form = document.getElementById('inv-tpl-form');
        var list = el.dataset.list;
        var rows = readKv(form, list); rows.splice(Number(el.dataset.i), 1);
        form.querySelector('[data-kv-list="' + list + '"]').innerHTML = kvRowsHtml(rows, list);
      },
      'inv:img-remove': function (el) {
        var kind = el.dataset.kind;
        S.tpl[kind] = null;
        setWell(kind, null);
      }
    });
  }

  // ---------- entry ----------
  async function renderInvoicesPage() {
    registerActions();
    releaseUrls();
    S.view = 'list'; S.status = 'all'; S.q = '';
    await Promise.all([loadProfiles(), loadPresets(), loadInvoices()]);
    renderList();
    await maybeImport();
  }

  root.renderInvoicesPage = renderInvoicesPage;
  root.InvoicesModule = {
    render: renderInvoicesPage,
    _sampleNumber: sampleNumber,
    _toCents: toCents,
    _computeTotals: function (items, rate) { return computeEd({ items: items, tax_rate: rate }); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.InvoicesModule;
})(typeof window !== 'undefined' ? window : globalThis);
