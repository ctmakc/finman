// public/js/engage.js — the habit loop: from the first insight to a weekly ritual.
//
// Dashboard (Engage.afterDashboard, called from renderDashboard):
//   · the setup checklist "Your first month" — five steps on one rail
//     (first insight → second statement / bank → budget → goal → weekly review)
//     with the next step spelled out and one button that does it;
//   · the streak — weeks in a row with activity, Mon–Sun dots, the next badge;
//   · badges (streak 2/4/8/12/26/52 weeks, a friend joined, setup done);
//   · invite a friend — personal link with fm_ref=invite-<code>;
//   · web push — "Monday recap as a notification" (VAPID, public/sw.js);
//   · the AI CFO hero card shows the top tip computed from the user's numbers
//     (amounts, the screen that fixes it, a ready question for the AI chat).
// Page /week (renderWeekPage): "Your week in money" / "Your month in money".
// Opening it completes the weekly review step (server: GET /api/engagement/recap).
//
// Events go to POST /api/engagement/event (server whitelist, user id attached,
// test accounts kept out of OpenPanel). Entry links from the email and push
// carry fm_src=email|push — read here before the router rewrites the URL.
(function () {
  'use strict';

  // ---- entry parameters (email / push links) -------------------------------
  var entry = {};
  try {
    var qs = new URLSearchParams(window.location.search);
    ['fm_src', 'fm_push', 'fm_kind', 'fm_import', 'utm_campaign'].forEach(function (k) {
      if (qs.has(k)) entry[k] = String(qs.get(k)).slice(0, 60);
    });
  } catch (_) { /* old browser */ }
  var entrySent = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money0(v, cur) {
    try {
      return new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur || 'CAD', maximumFractionDigits: 0 }).format(Number(v) || 0);
    } catch (_) {
      return Math.round(Number(v) || 0) + ' ' + (cur || '');
    }
  }

  function fmtDay(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  }

  async function api(url, options) {
    var res = await fetchWithAuth(url, options || {});
    var body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      var err = new Error((body && (body.message || (body.error && body.error.message))) || ('HTTP ' + res.status));
      err.status = res.status;
      err.code = body && body.error && body.error.code;
      throw err;
    }
    return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
  }

  function ev(event, props) {
    try {
      fetchWithAuth('/api/engagement/event', {
        method: 'POST',
        body: JSON.stringify({ event: event, props: props || {}, path: window.location.pathname }),
      }).catch(function () {});
    } catch (_) { /* analytics never breaks the app */ }
  }

  // The email / push click, once per page load, after sign-in.
  function sendEntry() {
    if (entrySent || !entry.fm_src) return;
    entrySent = true;
    if (entry.fm_src === 'push') ev('push_clicked', { kind: entry.fm_push || entry.fm_kind || 'push' });
    else if (entry.fm_src === 'email') ev('email_click', { campaign: entry.utm_campaign || '', page: (window.location.pathname.split('/')[1] || 'dashboard') });
    if (entry.fm_import === '1' && typeof showImportWizard === 'function') {
      setTimeout(function () { try { showImportWizard({}); } catch (_) {} }, 400);
    }
  }

  function importStatement() {
    if (typeof showImportWizard === 'function') return showImportWizard({});
    return navigateTo('accounts');
  }

  function askAi(q) {
    if (window.FirstRun && typeof window.FirstRun.askAi === 'function') return window.FirstRun.askAi(q);
    return navigateTo('ai');
  }

  // ---- copy ----------------------------------------------------------------
  var STEPS = {
    first_insight: {
      short: 'First insight', title: 'See where your money goes',
      body: 'Import a bank statement (CSV, OFX or QFX). Finman reads it and shows your categories, repeating charges and biggest expenses.',
      cta: 'Import a statement', run: importStatement,
    },
    second_source: {
      short: 'Second statement', title: 'Add a second statement',
      body: 'Another account or an older period. With two months or two accounts the averages, pace and forecasts use real numbers.',
      cta: 'Import another statement', run: importStatement,
      alt: { label: 'Connect a bank', page: 'bank-connections' },
    },
    budget: {
      short: 'Budget', title: 'Set one budget',
      body: 'Pick the category that runs away most. Finman shows what is left for each remaining week of the month.',
      cta: 'Create a budget', page: 'budgets',
    },
    goal: {
      short: 'Goal', title: 'Give your savings a goal',
      body: 'A target and a date. Finman works out the monthly amount and tells you when you fall behind.',
      cta: 'Create a goal', page: 'goals',
    },
    weekly_review: {
      short: 'Weekly review', title: 'Open your weekly review',
      body: 'One minute on Monday: what you spent, what came in, what changed against the week before.',
      cta: 'Open this week', page: 'week',
    },
  };
  var ORDER = ['first_insight', 'second_source', 'budget', 'goal', 'weekly_review'];

  function badgeLabel(key) {
    var m = /^streak_(\d+)$/.exec(key);
    if (m) return { icon: 'fa-fire', text: m[1] + '-week streak' };
    if (key === 'friend') return { icon: 'fa-user-plus', text: 'Brought a friend' };
    if (key === 'journey_done') return { icon: 'fa-flag-checkered', text: 'Setup complete' };
    return { icon: 'fa-star', text: key.replace(/_/g, ' ') };
  }

  // ---- dashboard panel -----------------------------------------------------
  function railHtml(j) {
    return '<ol class="eg-rail" aria-label="Setup progress">' + j.steps.map(function (s, i) {
      var copy = STEPS[s.key] || { short: s.key };
      var cls = s.done ? 'is-done' : (s.key === j.next ? 'is-next' : '');
      return '<li class="eg-step ' + cls + '" style="--i:' + i + '">' +
        '<span class="eg-step-mark" aria-hidden="true">' + (s.done ? '<i class="fas fa-check"></i>' : (i + 1)) + '</span>' +
        '<span class="eg-step-name">' + esc(copy.short) + '</span>' +
        '<span class="sr-only">' + (s.done ? 'done' : 'to do') + '</span>' +
      '</li>';
    }).join('') + '</ol>';
  }

  function journeyHtml(j) {
    var n = STEPS[j.next];
    return '<section class="eg-journey" aria-labelledby="eg-journey-h">' +
      '<header class="eg-head">' +
        '<div><p class="eg-eyebrow">Your first month</p>' +
        '<h2 id="eg-journey-h" class="eg-title">Set up Finman <span class="eg-count">' + j.doneCount + ' of ' + j.total + '</span></h2></div>' +
        '<button type="button" class="eg-x" id="eg-dismiss" aria-label="Hide the setup list" title="Hide"><i class="fas fa-times"></i></button>' +
      '</header>' +
      railHtml(j) +
      (n ? '<div class="eg-next">' +
        '<h3 class="eg-next-title">' + esc(n.title) + '</h3>' +
        '<p class="eg-next-body">' + esc(n.body) + '</p>' +
        '<div class="eg-actions">' +
          '<button type="button" class="btn btn-primary" id="eg-next-go" data-step="' + esc(j.next) + '">' + esc(n.cta) + '</button>' +
          (n.alt ? '<button type="button" class="btn btn-outline" id="eg-next-alt" data-page="' + esc(n.alt.page) + '">' + esc(n.alt.label) + '</button>' : '') +
        '</div>' +
      '</div>' : '') +
    '</section>';
  }

  function weekCardHtml(j) {
    return '<section class="eg-journey eg-weekcard" aria-labelledby="eg-week-h">' +
      '<header class="eg-head"><div><p class="eg-eyebrow">Every Monday</p>' +
      '<h2 id="eg-week-h" class="eg-title">Your week in money</h2></div></header>' +
      '<p class="eg-next-body">Spent, came in, kept, and what changed against the week before. ' +
      (j.data && j.data.lastDate ? 'Statements up to ' + esc(fmtDay(j.data.lastDate)) + '.' : '') + '</p>' +
      '<div class="eg-actions"><button type="button" class="btn btn-primary" id="eg-open-week">Open this week</button>' +
      '<button type="button" class="btn btn-outline" id="eg-open-month">Last month</button></div>' +
    '</section>';
  }

  function streakHtml(j) {
    var s = j.streak || { current: 0, thisWeek: [] };
    var days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var dots = days.map(function (d, i) {
      var on = s.thisWeek && s.thisWeek[i];
      return '<li class="eg-dot' + (on ? ' is-on' : '') + '"><span aria-hidden="true">' + d + '</span></li>';
    }).join('');
    var weeks = s.current || 0;
    var line = weeks === 0
      ? 'Open Finman once this week to start a streak.'
      : (s.nextBadge ? (s.nextBadge - weeks) + ' more ' + ((s.nextBadge - weeks) === 1 ? 'week' : 'weeks') + ' to the ' + s.nextBadge + '-week badge.' : 'Every streak badge is yours.');
    if (weeks > 0 && !s.activeThisWeek) line = 'Open Finman this week to keep the streak. ' + line;
    var badges = (j.badges || []).slice(-4).reverse().map(function (b) {
      var l = badgeLabel(b.key);
      var fresh = (j.fresh || []).indexOf('badge_' + b.key) >= 0;
      return '<li class="eg-badge' + (fresh ? ' is-fresh' : '') + '"><i class="fas ' + l.icon + '" aria-hidden="true"></i> ' + esc(l.text) + '</li>';
    }).join('');
    return '<section class="eg-card eg-streak" aria-label="Weekly streak">' +
      '<div class="eg-streak-top">' +
        '<p class="eg-streak-fig"><span class="fm-num">' + weeks + '</span> ' + (weeks === 1 ? 'week' : 'weeks') + ' in a row</p>' +
        '<ol class="eg-dots" aria-label="Days active this week">' + dots + '</ol>' +
      '</div>' +
      '<p class="eg-small">' + esc(line) + '</p>' +
      (badges ? '<ul class="eg-badges" aria-label="Badges">' + badges + '</ul>' : '') +
    '</section>';
  }

  function inviteHtml(ref) {
    if (!ref || !ref.link) return '';
    var joined = ref.joined || 0;
    return '<section class="eg-card eg-invite" aria-labelledby="eg-invite-h">' +
      '<h3 id="eg-invite-h" class="eg-card-title"><i class="fas fa-user-plus" aria-hidden="true"></i> Invite a friend</h3>' +
      '<p class="eg-small">Finman is free to start. Send your link to someone who also wonders where the money goes.' +
      (joined ? ' <b>' + joined + ' joined</b> so far.' : '') + '</p>' +
      '<div class="eg-invite-row">' +
        '<input class="form-control eg-invite-link" id="eg-invite-link" readonly value="' + esc(ref.link) + '" aria-label="Your invite link">' +
        '<button type="button" class="btn btn-primary btn-sm" id="eg-invite-share">' + (navigator.share ? 'Share' : 'Copy') + '</button>' +
      '</div>' +
    '</section>';
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function pushHtml(p) {
    if (!p || !p.available || !pushSupported()) return '';
    if (p.devices > 0 && Notification.permission === 'granted') return '';
    var denied = Notification.permission === 'denied';
    return '<section class="eg-card eg-push" aria-labelledby="eg-push-h">' +
      '<h3 id="eg-push-h" class="eg-card-title"><i class="fas fa-bell" aria-hidden="true"></i> Monday recap on this device</h3>' +
      '<p class="eg-small">' + (denied
        ? 'Notifications are blocked for Finman in this browser. Allow them in the site settings, then come back.'
        : 'One notification a week with your numbers. On iPhone, add Finman to the Home Screen first.') + '</p>' +
      (denied ? '' : '<button type="button" class="btn btn-outline btn-sm" id="eg-push-on">Turn on</button>') +
    '</section>';
  }

  // The AI CFO hero card: the top tip with its screen and a ready question.
  function heroTips(main, tips) {
    var card = main.querySelector('.fm-insight-card');
    if (!card || !tips || !tips.length) return;
    var i = 0;
    var text = card.querySelector('.fm-insight-text');
    var foot = card.querySelector('.fm-insight-foot');
    if (!text || !foot) return;
    // The default "Ask the AI CFO" handler in app.js binds by this id; take it over.
    var old = foot.querySelector('#hero-ai-more');
    if (old) old.id = 'hero-ai-more-engaged';
    function paint() {
      var t = tips[i];
      text.innerHTML = '<b class="eg-tip-title">' + esc(t.title) + '</b> ' + esc(t.body);
      foot.innerHTML =
        (t.action ? '<button class="btn btn-sm eg-tip-go" type="button">' + esc(t.action.label) + '</button>' : '') +
        '<button class="btn btn-sm eg-tip-ask" type="button">Ask about this</button>' +
        (tips.length > 1 ? '<button class="eg-tip-more" type="button" aria-label="Next tip">' + (i + 1) + ' / ' + tips.length + ' <i class="fas fa-arrow-right" aria-hidden="true"></i></button>' : '');
      var go = foot.querySelector('.eg-tip-go');
      if (go) go.addEventListener('click', function () { ev('tip_clicked', { tip: t.kind, page: t.action.page }); navigateTo(t.action.page); });
      foot.querySelector('.eg-tip-ask').addEventListener('click', function () { ev('tip_asked', { tip: t.kind }); askAi(t.ask); });
      var more = foot.querySelector('.eg-tip-more');
      if (more) more.addEventListener('click', function () { i = (i + 1) % tips.length; paint(); });
    }
    paint();
  }

  async function enablePush(btn) {
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Turning on…'; }
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        ev('push_denied', { permission: perm });
        if (typeof showNotification === 'function') showNotification('Notifications stay off. You can turn them on later from the dashboard.', 'info');
        return false;
      }
      var keyRes = await api('/api/engagement/push/key');
      if (!keyRes || !keyRes.key) throw new Error('Notifications are not available right now');
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(keyRes.key) });
      await api('/api/engagement/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (typeof showNotification === 'function') showNotification('Done. Your Monday recap will arrive on this device.', 'success');
      return true;
    } catch (e) {
      if (typeof showNotification === 'function') showNotification('Could not turn notifications on: ' + (e.message || e), 'error');
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Turn on'; }
    }
  }

  function urlB64(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var k = 0; k < raw.length; k += 1) out[k] = raw.charCodeAt(k);
    return out;
  }

  function bindPanel(holder, j, main) {
    var go = holder.querySelector('#eg-next-go');
    if (go) go.addEventListener('click', function () {
      var step = go.dataset.step;
      var copy = STEPS[step];
      ev('checklist_step_click', { step: step });
      if (copy.run) copy.run(); else navigateTo(copy.page);
    });
    var alt = holder.querySelector('#eg-next-alt');
    if (alt) alt.addEventListener('click', function () { ev('checklist_step_click', { step: j.next, alt: true }); navigateTo(alt.dataset.page); });
    var x = holder.querySelector('#eg-dismiss');
    if (x) x.addEventListener('click', function () {
      api('/api/engagement/journey/dismiss', { method: 'POST' }).catch(function () {});
      j.dismissed = true;
      var box = holder.querySelector('.eg-journey');
      if (box) box.outerHTML = weekCardHtml(j);
      bindWeekCard(holder);
    });
    bindWeekCard(holder);
    var share = holder.querySelector('#eg-invite-share');
    if (share) share.addEventListener('click', async function () {
      var link = holder.querySelector('#eg-invite-link').value;
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Finman', text: 'I use Finman to see where my money goes. Try it:', url: link });
          ev('invite_shared', { via: 'share_sheet' });
          return;
        } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      try { await navigator.clipboard.writeText(link); } catch (_) {
        var inp = holder.querySelector('#eg-invite-link'); inp.select(); document.execCommand('copy');
      }
      ev('invite_link_copied', {});
      share.textContent = 'Copied';
      setTimeout(function () { share.textContent = navigator.share ? 'Share' : 'Copy'; }, 1800);
    });
    var pushBtn = holder.querySelector('#eg-push-on');
    if (pushBtn) pushBtn.addEventListener('click', async function () {
      if (await enablePush(pushBtn)) {
        var card = holder.querySelector('.eg-push');
        if (card) card.remove();
      }
    });
    // A new badge earned on this load gets a toast.
    (j.fresh || []).filter(function (k) { return k.indexOf('badge_') === 0; }).slice(0, 1).forEach(function (k) {
      if (typeof showNotification === 'function') showNotification('New badge: ' + badgeLabel(k.slice(6)).text, 'success');
    });
  }

  function bindWeekCard(holder) {
    var w = holder.querySelector('#eg-open-week');
    if (w) w.addEventListener('click', function () { navigateTo('week'); });
    var m = holder.querySelector('#eg-open-month');
    if (m) m.addEventListener('click', function () { weekKind = 'month'; navigateTo('week'); });
  }

  async function afterDashboard(main) {
    sendEntry();
    if (!main) return;
    var j;
    try { j = await api('/api/engagement/journey'); } catch (e) { console.warn('[engage] journey', e.message); return; }
    if (!j || !document.body.contains(main) || appState.currentPage !== 'dashboard') return;
    // Nothing of their own yet: the first-run banners carry the page.
    var hasData = j.data && j.data.transactions > 0;
    var showList = !j.complete && !j.dismissed;
    var holder = document.createElement('div');
    holder.className = 'eg-panel' + (showList ? '' : ' is-compact');
    holder.innerHTML =
      (showList ? journeyHtml(j) : weekCardHtml(j)) +
      '<div class="eg-side">' + streakHtml(j) + inviteHtml(j.referral) + (hasData ? pushHtml(j.push) : '') + '</div>';
    var hero = main.querySelector('.fm-hero');
    if (hero && hero.parentNode) hero.parentNode.insertBefore(holder, hero.nextSibling);
    else main.insertBefore(holder, main.firstChild);
    bindPanel(holder, j, main);
    if (hasData) heroTips(main, j.tips);
    if (showList) ev('checklist_shown', { done: j.doneCount, next: j.next || '' });
  }

  // ---- /week ---------------------------------------------------------------
  var weekKind = entry.fm_kind === 'month' ? 'month' : 'week';

  function deltaText(r) {
    if (r.expenseDelta == null || !r.prev || !r.prev.expense) return '';
    var up = r.expenseDelta > 0;
    var label = r.kind === 'month' ? 'the month before' : 'the week before';
    return '<span class="eg-delta ' + (up ? 'up' : 'down') + '"><i class="fas fa-arrow-' + (up ? 'up' : 'down') + '" aria-hidden="true"></i> ' +
      'Spending ' + (up ? 'up ' : 'down ') + Math.abs(r.expenseDelta) + '% on ' + label + '</span>';
  }

  function weekHtml(r) {
    var cur = r.currency;
    var noun = r.kind === 'month' ? 'month' : 'week';
    var toggle = '<div class="eg-seg" role="tablist" aria-label="Period">' +
      '<button type="button" role="tab" class="eg-seg-btn' + (r.kind === 'week' ? ' is-on' : '') + '" aria-selected="' + (r.kind === 'week') + '" data-kind="week">Last week</button>' +
      '<button type="button" role="tab" class="eg-seg-btn' + (r.kind === 'month' ? ' is-on' : '') + '" aria-selected="' + (r.kind === 'month') + '" data-kind="month">Last month</button>' +
    '</div>';
    var head = '<header class="eg-week-head">' +
      '<div><p class="eg-eyebrow">Your ' + noun + ' in money</p>' +
      '<h1 class="eg-week-title">' + esc(r.period.label) + '</h1>' +
      (r.transactions ? deltaText(r) : '') + '</div>' + toggle +
    '</header>';

    if (!r.transactions) {
      var body = r.lastDataDate
        ? 'Your statements end on ' + esc(fmtDay(r.lastDataDate)) + '. Import a newer one and this page fills in.'
        : 'Import a bank statement and this page shows what you spent, what came in and what changed.';
      return '<section class="eg-week">' + head +
        '<div class="empty-state fm-empty eg-week-empty">' +
          '<span class="fm-empty-icon" aria-hidden="true"><i class="fas fa-calendar-week"></i></span>' +
          '<h2 class="fm-empty-title">Nothing recorded for ' + esc(r.period.label) + '</h2>' +
          '<p class="fm-empty-body">' + body + '</p>' +
          '<div class="fm-empty-actions"><button type="button" class="btn btn-primary" id="eg-week-import">' +
            (r.lastDataDate ? 'Import a newer statement' : 'Import a statement') + '</button>' +
          (r.kind === 'week' ? '<button type="button" class="btn btn-outline" data-kind="month">See last month</button>' : '') + '</div>' +
        '</div>' +
        // A quiet preview of the page once there is data: four readings and the category rail.
        '<div class="eg-ghost" aria-hidden="true">' +
          '<p class="eg-ghost-cap">What this page shows every ' + (r.kind === 'month' ? 'month' : 'Monday') + '</p>' +
          '<dl class="fri-soundings">' + ['Spent', 'Came in', 'Kept', 'Savings rate'].map(function (k) {
            return '<div><dt>' + k + '</dt><dd><span class="eg-ghost-fig"></span></dd></div>';
          }).join('') + '</dl>' +
          '<ul class="eg-ghost-cats">' + [86, 58, 34, 18].map(function (w) {
            return '<li><span class="eg-ghost-line"></span><span class="eg-ghost-bar" style="--w:' + w + '%"></span></li>';
          }).join('') + '</ul>' +
        '</div>' + tipsHtml(r.tips) +
      '</section>';
    }

    var max = Math.max.apply(null, (r.topCategories || []).map(function (c) { return c.amount; }).concat([1]));
    var cats = (r.topCategories || []).map(function (c, i) {
      var w = Math.max(2, Math.round((c.amount / max) * 100));
      var d = c.prev ? (c.delta > 0 ? '+' : '') + c.delta + '%' : 'new';
      return '<li class="fri-cat" style="--i:' + i + '">' +
        '<span class="fri-cat-name">' + esc(c.category) + '</span>' +
        '<span class="fri-cat-bar" aria-hidden="true"><span style="--w:' + w + '%"></span></span>' +
        '<span class="fri-cat-fig">' + esc(money0(c.amount, cur)) + '</span>' +
        '<span class="fri-cat-share">' + esc(d) + '</span>' +
      '</li>';
    }).join('');
    var big = (r.biggest || []).map(function (b) {
      return '<li class="fri-rec"><span class="fri-rec-name">' + esc(b.description) + '</span>' +
        '<span class="fri-rec-cycle">' + esc(fmtDay(b.date)) + '</span>' +
        '<span class="fri-rec-fig">' + esc(money0(b.amount, cur)) + '</span></li>';
    }).join('');
    var budgets = (r.budgets || []).map(function (b) {
      var over = b.percent >= 100;
      return '<li class="eg-meter' + (over ? ' is-over' : '') + '"><div class="eg-meter-top"><span>' + esc(b.name) + '</span>' +
        '<span class="fm-num">' + esc(money0(b.spent, cur)) + ' <small>of ' + esc(money0(b.amount, cur)) + '</small></span></div>' +
        '<span class="eg-meter-bar" aria-hidden="true"><span style="--w:' + Math.min(100, b.percent) + '%"></span></span></li>';
    }).join('');
    var goals = (r.goals || []).map(function (g) {
      return '<li class="eg-meter"><div class="eg-meter-top"><span>' + esc(g.name) + '</span>' +
        '<span class="fm-num">' + g.percent + '% <small>' + (g.monthlyNeeded ? esc(money0(g.monthlyNeeded, cur)) + '/mo to go' : '') + '</small></span></div>' +
        '<span class="eg-meter-bar is-goal" aria-hidden="true"><span style="--w:' + Math.min(100, g.percent) + '%"></span></span></li>';
    }).join('');
    var kept = r.net;
    var stale = r.stale && r.lastDataDate
      ? '<p class="fri-note">Statements end on ' + esc(fmtDay(r.lastDataDate)) + '. <button type="button" class="fri-link" id="eg-week-import">Import a newer one</button> to complete this ' + noun + '.</p>'
      : '';

    return '<section class="eg-week">' + head +
      '<dl class="fri-soundings">' +
        '<div><dt>Spent</dt><dd class="neg">' + esc(money0(r.expense, cur)) + '</dd></div>' +
        '<div><dt>Came in</dt><dd class="pos">' + esc(money0(r.income, cur)) + '</dd></div>' +
        '<div><dt>' + (kept < 0 ? 'Overspent' : 'Kept') + '</dt><dd>' + esc(money0(Math.abs(kept), cur)) + '</dd></div>' +
        '<div><dt>Savings rate</dt><dd>' + (r.savingsRate == null ? '—' : r.savingsRate + '%') + '</dd></div>' +
      '</dl>' + stale +
      '<div class="fri-cols">' +
        '<section class="fri-block"><h2 class="fri-h">Where it went <span>vs the ' + noun + ' before</span></h2>' +
          '<ol class="fri-cats">' + (cats || '<li class="fri-empty">No spending in this ' + noun + '.</li>') + '</ol>' +
          (big ? '<h2 class="fri-h fri-h-2">Biggest payments</h2><ul class="fri-recs">' + big + '</ul>' : '') +
        '</section>' +
        '<section class="fri-block">' +
          '<h2 class="fri-h">Budgets <span>' + (r.kind === 'week' ? 'month to date' : 'this month') + '</span></h2>' +
          (budgets ? '<ul class="eg-meters">' + budgets + '</ul>'
            : '<div class="eg-mini-empty"><p>A budget caps one category and shows what is left each week.</p><button type="button" class="btn btn-outline btn-sm" data-go="budgets">Create a budget</button></div>') +
          '<h2 class="fri-h fri-h-2">Goals</h2>' +
          (goals ? '<ul class="eg-meters">' + goals + '</ul>'
            : '<div class="eg-mini-empty"><p>A goal with a date tells you how much to set aside each month.</p><button type="button" class="btn btn-outline btn-sm" data-go="goals">Create a goal</button></div>') +
        '</section>' +
      '</div>' + tipsHtml(r.tips) +
    '</section>';
  }

  function tipsHtml(tips) {
    if (!tips || !tips.length) return '';
    return '<section class="eg-tips" aria-labelledby="eg-tips-h"><h2 id="eg-tips-h" class="fri-h">AI CFO <span>from your numbers</span></h2>' +
      '<ul class="eg-tip-list">' + tips.map(function (t, i) {
        return '<li class="eg-tip" style="--i:' + i + '"><h3 class="eg-tip-h">' + esc(t.title) + '</h3><p>' + esc(t.body) + '</p>' +
          '<div class="eg-actions">' +
          (t.action ? '<button type="button" class="btn btn-outline btn-sm" data-tip-go="' + i + '">' + esc(t.action.label) + '</button>' : '') +
          '<button type="button" class="fri-link" data-tip-ask="' + i + '">Ask the AI CFO</button></div></li>';
      }).join('') + '</ul></section>';
  }

  async function renderWeekPage() {
    sendEntry();
    var main = document.getElementById('main-content');
    var source = entry.fm_src === 'email' || entry.fm_src === 'push' ? entry.fm_src : 'app';
    entry.fm_src = null; // count the source once
    var r = await api('/api/engagement/recap?kind=' + weekKind + '&source=' + source);
    if (appState.currentPage !== 'week' || !main) return;
    main.innerHTML = weekHtml(r);
    main.querySelectorAll('[data-kind]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.kind === weekKind) return;
        weekKind = b.dataset.kind;
        renderWeekPage().catch(function (e) { console.error(e); });
      });
    });
    var imp = main.querySelectorAll('#eg-week-import');
    imp.forEach(function (b) { b.addEventListener('click', function () { ev('empty_state_cta', { page: 'week', action: 'import' }); importStatement(); }); });
    main.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { ev('empty_state_cta', { page: 'week', action: b.dataset.go }); navigateTo(b.dataset.go); });
    });
    main.querySelectorAll('[data-tip-go]').forEach(function (b) {
      var t = r.tips[Number(b.dataset.tipGo)];
      b.addEventListener('click', function () { ev('tip_clicked', { tip: t.kind, page: t.action.page, from: 'week' }); navigateTo(t.action.page); });
    });
    main.querySelectorAll('[data-tip-ask]').forEach(function (b) {
      var t = r.tips[Number(b.dataset.tipAsk)];
      b.addEventListener('click', function () { ev('tip_asked', { tip: t.kind, from: 'week' }); askAi(t.ask); });
    });
  }

  // ---- service worker: a notification click in an open window ---------------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type !== 'push-open' || typeof d.url !== 'string' || d.url.charAt(0) !== '/') return;
      try {
        var u = new URL(d.url, window.location.origin);
        var p = u.searchParams;
        entry = { fm_src: 'push', fm_push: p.get('fm_push') || '', fm_kind: p.get('fm_kind') || '' };
        entrySent = false;
        if (entry.fm_kind === 'month') weekKind = 'month';
        if (typeof resolvePageFromPath === 'function') navigateTo(resolvePageFromPath(u.pathname));
        else navigateTo('week');
        if (u.pathname.indexOf('/week') !== 0) sendEntry();
      } catch (_) { /* bad url */ }
    });
  }

  // Email links can land on any screen: count the click once the user is signed in.
  if (entry.fm_src) {
    var waited = 0;
    var poll = setInterval(function () {
      waited += 1;
      if (typeof appState !== 'undefined' && appState.isAuthenticated && appState.currentPage) {
        clearInterval(poll);
        if (appState.currentPage !== 'week') sendEntry();
      } else if (waited > 60) clearInterval(poll);
    }, 500);
  }

  window.Engage = { afterDashboard: afterDashboard, enablePush: enablePush, renderWeekPage: renderWeekPage, _entry: function () { return entry; } };
  window.renderWeekPage = renderWeekPage;
})();
