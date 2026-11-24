// public/js/feedback.js — what people tell the Finman team.
//
//   FMFeedback.open(tab, trigger)  dialog: Rate Finman | Report a bug | Idea  (menu, settings)
//   FMFeedback.afterImport()       one-question card after the first successful import
//   FMFeedback.maybeDay7(user)     on an app open: day3 card (score 1–5 + "what gets in the way")
//                                  3+ days after sign-up, then the day7 card 7+ days after sign-up.
//                                  QA: ?fm_qa_survey=day3 (or day7) shows the card at once.
//   FMFeedback.exitHtml() / sendExit()   "Why are you leaving?" inside the delete-account modal
//   FMFeedback.renderAdmin()       /admin page (ADMIN_EMAILS only; the server checks too)
//
// Answers go to POST /api/feedback (stored in Finman, forwarded to the MMIX review inbox).
// A survey card shows at most once per trigger per person: localStorage + server dedupe.
(function () {
  'use strict';

  var LS = 'fm_fb_';
  var APP_VERSION = 'web-1123';

  function t(key, fallback, vars) {
    try {
      if (window.i18n && typeof window.i18n.t === 'function') {
        var v = window.i18n.t(key, vars);
        if (v && v !== key) return v;
      }
    } catch (e) { /* fall back */ }
    var s = fallback || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lang() {
    try { return (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || 'en'; } catch (e) { return 'en'; }
  }
  function user() { return (typeof appState !== 'undefined' && appState && appState.user) || null; }
  function key(trigger) { var u = user(); return LS + (u ? u.id : 'anon') + '_' + trigger; }
  function seen(trigger) { try { return localStorage.getItem(key(trigger)) === '1'; } catch (e) { return false; } }
  function markSeen(trigger) { try { localStorage.setItem(key(trigger), '1'); } catch (e) { /* ignore */ } }
  function toast(msg, kind) {
    if (typeof showNotification === 'function') showNotification(msg, kind || 'success');
  }

  function authHeaders() {
    var h = { 'Content-Type': 'application/json' };
    try {
      var tok = localStorage.getItem('token') || localStorage.getItem('authToken');
      if (tok) h.Authorization = 'Bearer ' + tok;
    } catch (e) { /* ignore */ }
    return h;
  }

  // Sends one answer. Uses fetchWithAuth when signed in; plain fetch otherwise.
  function send(payload, opts) {
    opts = opts || {};
    var body = Object.assign({
      page: location.pathname,
      lang: lang(),
      appVersion: APP_VERSION,
      viewport: window.innerWidth + 'x' + window.innerHeight,
    }, payload);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && opts.timeout ? setTimeout(function () { ctrl.abort(); }, opts.timeout) : null;
    var init = { method: 'POST', body: JSON.stringify(body) };
    if (ctrl) init.signal = ctrl.signal;
    var p = (typeof fetchWithAuth === 'function' && user())
      ? fetchWithAuth('/api/feedback', init)
      : fetch('/api/feedback', Object.assign(init, { headers: authHeaders() }));
    return p.then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error((b && b.message) || t('fb.failed', 'Could not send. Try again.'));
        return b;
      });
    });
  }

  // ---------------------------------------------------------------- stars
  function starsHtml(name, value) {
    var faces = ['fb.r1', 'fb.r2', 'fb.r3', 'fb.r4', 'fb.r5'];
    var fall = ['Bad', 'Meh', 'Okay', 'Good', 'Love it'];
    var h = '<div class="fb-stars" role="radiogroup" aria-label="' + esc(t('fb.rateAria', 'Rating from 1 to 5')) + '">';
    for (var i = 1; i <= 5; i++) {
      h += '<label class="fb-star' + (value >= i ? ' on' : '') + '" title="' + esc(t(faces[i - 1], fall[i - 1])) + '">' +
        '<input type="radio" name="' + name + '" value="' + i + '"' + (value === i ? ' checked' : '') + '>' +
        '<span class="fb-star-n">' + i + '</span><span class="fb-star-l">' + esc(t(faces[i - 1], fall[i - 1])) + '</span></label>';
    }
    return h + '</div>';
  }
  function wireStars(root) {
    root.querySelectorAll('.fb-stars').forEach(function (g) {
      g.addEventListener('change', function () {
        var v = Number((g.querySelector('input:checked') || {}).value || 0);
        g.querySelectorAll('.fb-star').forEach(function (l, idx) { l.classList.toggle('on', idx < v); });
      });
    });
  }

  // ---------------------------------------------------------------- dialog
  var TABS = [
    { id: 'rate', kind: 'rating', icon: 'fa-star', label: ['fb.tab.rate', 'Rate Finman'] },
    { id: 'bug', kind: 'bug', icon: 'fa-bug', label: ['fb.tab.bug', 'Report a bug'] },
    { id: 'idea', kind: 'idea', icon: 'fa-lightbulb', label: ['fb.tab.idea', 'Idea'] },
  ];

  function tabBody(id) {
    if (id === 'rate') {
      return '<p class="fb-q">' + esc(t('fb.rate.q', 'How is Finman working for you so far?')) + '</p>' +
        starsHtml('fb-rating', 0) +
        '<label class="form-label" for="fb-comment">' + esc(t('fb.rate.more', 'What would make it better? (optional)')) + '</label>' +
        '<textarea id="fb-comment" class="form-control" rows="3" maxlength="2000"></textarea>';
    }
    if (id === 'bug') {
      return '<p class="fb-q">' + esc(t('fb.bug.q', 'What went wrong? Tell us what you tapped and what you expected.')) + '</p>' +
        '<textarea id="fb-comment" class="form-control" rows="4" maxlength="2000" placeholder="' + esc(t('fb.bug.ph', 'I pressed Import, picked my RBC file and…')) + '"></textarea>' +
        '<div class="fb-kit">' +
          '<p class="fb-kit-h">' + esc(t('fb.kit.h', 'Easier to show it?')) + '</p>' +
          '<mmix-review-entry title-text="' + esc(t('fb.kit.title', 'Point at the problem on screen')) + '" sub-text="' + esc(t('fb.kit.sub', 'Tap the broken spot and leave a note, a photo or a voice message.')) + '" go-text="' + esc(t('fb.kit.go', 'Start →')) + '"></mmix-review-entry>' +
          '<p class="fb-note">' + esc(t('fb.kit.privacy', 'The note and the text of the spot you point at go to the Finman team. Point at a button or a heading if the screen shows your amounts.')) + '</p>' +
        '</div>';
    }
    return '<p class="fb-q">' + esc(t('fb.idea.q', 'What should Finman do for you that it does not do yet?')) + '</p>' +
      '<textarea id="fb-comment" class="form-control" rows="4" maxlength="2000"></textarea>';
  }

  function open(tab, trigger) {
    if (typeof UI === 'undefined' || !UI.modal) return;
    tab = TABS.some(function (x) { return x.id === tab; }) ? tab : 'rate';
    trigger = trigger || 'menu';
    var host = UI.modal({
      id: 'fb-modal',
      title: t('fb.title', 'Tell us what you think'),
      body:
        '<div class="fb-dialog">' +
          '<p class="fb-lead">' + esc(t('fb.lead', 'Every message is read by the people who build Finman.')) + '</p>' +
          '<div class="fb-tabs" role="tablist">' + TABS.map(function (x) {
            return '<button type="button" role="tab" class="fb-tab" data-tab="' + x.id + '" aria-selected="' + (x.id === tab) + '">' +
              '<i class="fas ' + x.icon + '" aria-hidden="true"></i><span>' + esc(t(x.label[0], x.label[1])) + '</span></button>';
          }).join('') + '</div>' +
          '<form id="fb-form" novalidate><div class="fb-pane"></div>' +
            '<p class="auth-error" id="fb-error" role="alert" hidden></p>' +
            '<div class="form-actions"><button type="button" class="btn btn-outline" data-action="ui:close">' + esc(t('btn.cancel', 'Cancel')) + '</button>' +
            '<button type="submit" class="btn btn-primary" id="fb-submit">' + esc(t('fb.send', 'Send')) + '</button></div>' +
          '</form>' +
        '</div>'
    });
    if (!host) return;
    var pane = host.querySelector('.fb-pane');
    var current = tab;
    function show(id) {
      current = id;
      host.querySelectorAll('.fb-tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === id)); });
      pane.innerHTML = tabBody(id);
      wireStars(pane);
      var ta = pane.querySelector('textarea');
      if (id !== 'rate' && ta) setTimeout(function () { ta.focus(); }, 30);
    }
    host.querySelectorAll('.fb-tab').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.tab); }); });
    // The review kit's entry card starts comment mode: close our dialog first.
    host.addEventListener('mmixreview:entry', function () { try { UI.closeTopModal(); } catch (e) { /* ignore */ } });
    show(current);
    host.querySelector('#fb-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = host.querySelector('#fb-error');
      err.hidden = true;
      var spec = TABS.filter(function (x) { return x.id === current; })[0];
      var rating = Number((pane.querySelector('input[name="fb-rating"]:checked') || {}).value || 0) || null;
      var comment = ((pane.querySelector('#fb-comment') || {}).value || '').trim();
      if (current === 'rate' && !rating && !comment) { err.textContent = t('fb.err.rate', 'Pick a score or write a few words.'); err.hidden = false; return; }
      if (current !== 'rate' && comment.length < 3) { err.textContent = t('fb.err.text', 'Write a few words so we can act on it.'); err.hidden = false; return; }
      var btn = host.querySelector('#fb-submit');
      btn.disabled = true;
      send({ kind: spec.kind, trigger: trigger, rating: rating, comment: comment })
        .then(function () {
          try { UI.closeTopModal(); } catch (e2) { /* ignore */ }
          toast(t('fb.thanks', 'Thank you! We read every message.'));
        })
        .catch(function (e3) { err.textContent = e3.message; err.hidden = false; btn.disabled = false; });
    });
  }

  // ------------------------------------------------- one-question survey card
  var SURVEYS = {
    day3: {
      q: ['fb.s.day3.q', 'How is Finman working for you so far?'],
      type: 'stars',
      ends: [['fb.s.day3.low', 'Not useful'], ['fb.s.day3.high', 'Very useful']],
      // The text field shows right away: this survey is the place to say what is missing.
      more: ['fb.s.day3.more', 'What gets in the way, or what is missing?'],
      open: true,
    },
    import_done: {
      q: ['fb.s.import.q', 'How easy was it to get your data in?'],
      type: 'stars',
    },
    day7: {
      q: ['fb.s.day7.q', 'What would make you open Finman every week?'],
      type: 'options',
      options: [
        ['bank_sync', 'fb.s.day7.bank', 'Automatic bank sync'],
        ['weekly_email', 'fb.s.day7.email', 'A short weekly email'],
        ['mobile_app', 'fb.s.day7.app', 'A phone app'],
        ['ai_advice', 'fb.s.day7.ai', 'Advice from the AI'],
        ['other', 'fb.s.day7.other', 'Something else'],
      ],
    },
  };

  function card(trigger) {
    var s = SURVEYS[trigger];
    if (!s || seen(trigger) || document.getElementById('fb-card')) return;
    var el = document.createElement('section');
    el.id = 'fb-card';
    el.className = 'fb-card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('fb.card.aria', 'Quick question'));
    var inner = '<button type="button" class="fb-card-x" aria-label="' + esc(t('btn.close', 'Close')) + '">&times;</button>' +
      '<p class="fb-card-kicker">' + esc(t('fb.card.kicker', 'One quick question')) + '</p>' +
      '<p class="fb-card-q">' + esc(t(s.q[0], s.q[1])) + '</p>';
    if (s.type === 'stars') {
      inner += '<div class="fb-card-scale">' + [1, 2, 3, 4, 5].map(function (n) {
        return '<button type="button" class="fb-pick" data-rating="' + n + '">' + n + '</button>';
      }).join('') + '</div><div class="fb-card-ends"><span>' + esc(s.ends ? t(s.ends[0][0], s.ends[0][1]) : t('fb.s.hard', 'Hard')) +
        '</span><span>' + esc(s.ends ? t(s.ends[1][0], s.ends[1][1]) : t('fb.s.easy', 'Easy')) + '</span></div>';
    } else {
      inner += '<div class="fb-card-opts">' + s.options.map(function (o) {
        return '<button type="button" class="fb-opt" data-answer="' + o[0] + '">' + esc(t(o[1], o[2])) + '</button>';
      }).join('') + '</div>';
    }
    var moreText = s.more ? t(s.more[0], s.more[1]) : t('fb.card.more', 'Anything to add? (optional)');
    inner += '<div class="fb-card-more"' + (s.open ? '' : ' hidden') + '>' +
      (s.open ? '<label class="fb-card-label" for="fb-card-text">' + esc(moreText) + '</label>' : '') +
      '<textarea id="fb-card-text" class="form-control" rows="2" maxlength="2000"' + (s.open ? '' : ' placeholder="' + esc(moreText) + '"') + '></textarea>' +
      '<button type="button" class="btn btn-primary btn-sm fb-card-send">' + esc(t('fb.send', 'Send')) + '</button></div>';
    el.innerHTML = inner;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });

    var picked = {};
    function close() {
      markSeen(trigger);
      el.classList.remove('in');
      setTimeout(function () { el.remove(); }, 220);
    }
    function submit() {
      var comment = (el.querySelector('textarea').value || '').trim();
      var btn = el.querySelector('.fb-card-send');
      if (!picked.rating && !picked.answer && !comment) {
        var first = el.querySelector('.fb-pick, .fb-opt');
        if (first) first.focus();
        return;
      }
      btn.disabled = true;
      send({ kind: 'survey', trigger: trigger, rating: picked.rating || null, answer: picked.answer || null, comment: comment })
        .then(function () { close(); toast(t('fb.thanks', 'Thank you! We read every message.')); })
        .catch(function () { btn.disabled = false; });
    }
    el.querySelector('.fb-card-x').addEventListener('click', close);
    el.querySelectorAll('.fb-pick, .fb-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        el.querySelectorAll('.fb-pick, .fb-opt').forEach(function (x) { x.classList.toggle('on', x === b); });
        if (b.dataset.rating) picked = { rating: Number(b.dataset.rating) };
        else picked = { answer: b.dataset.answer };
        var more = el.querySelector('.fb-card-more');
        more.hidden = false;
        if (picked.answer === 'other') el.querySelector('textarea').focus();
      });
    });
    el.querySelector('.fb-card-send').addEventListener('click', submit);
  }

  // Ask the server too (another device may have answered already), then show.
  function maybeCard(trigger, delay) {
    if (!user() || seen(trigger)) return;
    setTimeout(function () {
      if (seen(trigger)) return;
      var p = typeof fetchWithAuth === 'function' ? fetchWithAuth('/api/feedback/mine?trigger=' + trigger) : null;
      if (!p) return card(trigger);
      p.then(function (r) { return r.ok ? r.json() : { answered: false }; })
        .then(function (b) { if (b && b.answered) markSeen(trigger); else card(trigger); })
        .catch(function () { /* offline: ask another time */ });
    }, delay || 0);
  }

  function afterImport() { maybeCard('import_done', 4500); }

  // Navigation: take the card away without marking it answered.
  function hideCard() {
    var el = document.getElementById('fb-card');
    if (!el) return;
    el.classList.remove('in');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
  }

  // QA: ?fm_qa_survey=day3 shows that card now, whatever the account age or earlier answers.
  function qaSurvey() {
    try {
      var m = /[?&]fm_qa_survey=([a-z0-9_]+)/.exec(location.search);
      return m && SURVEYS[m[1]] ? m[1] : null;
    } catch (e) { return null; }
  }

  // One card per app open: day3 first (3+ days after sign-up), day7 on a later open.
  function maybeDay7(u) {
    u = u || user();
    var qa = qaSurvey();
    if (qa) {
      try { localStorage.removeItem(key(qa)); } catch (e) { /* ignore */ }
      setTimeout(function () { card(qa); }, 1500);
      return;
    }
    if (!u || !u.createdAt) return;
    var created = Date.parse(String(u.createdAt).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(u.createdAt) ? '' : 'Z'));
    if (!created) return;
    var age = Date.now() - created;
    if (age < 3 * 864e5) return;
    if (!seen('day3')) return maybeCard('day3', 8000);
    if (age >= 7 * 864e5) maybeCard('day7', 8000);
  }

  // ---------------------------------------------------------- exit survey
  var EXIT = [
    ['testing', 'fb.exit.testing', 'I was only trying it out'],
    ['privacy', 'fb.exit.privacy', 'I am worried about my data'],
    ['bank', 'fb.exit.bank', 'My bank is not supported'],
    ['complex', 'fb.exit.complex', 'Too complicated'],
    ['missing', 'fb.exit.missing', 'A feature I need is missing'],
    ['other', 'fb.exit.other', 'Something else'],
  ];
  function exitHtml() {
    return '<fieldset class="fb-exit">' +
      '<legend>' + esc(t('fb.exit.q', 'Before you go: why are you leaving? (optional)')) + '</legend>' +
      '<div class="fb-exit-opts">' + EXIT.map(function (o) {
        return '<label class="fb-exit-opt"><input type="radio" name="fb-exit" value="' + o[0] + '"><span>' + esc(t(o[1], o[2])) + '</span></label>';
      }).join('') + '</div>' +
      '<textarea id="fb-exit-comment" class="form-control" rows="2" maxlength="2000" hidden placeholder="' + esc(t('fb.exit.more', 'A word on what we could do better (optional)')) + '"></textarea>' +
      '</fieldset>';
  }
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.name !== 'fb-exit') return;
    var ta = document.getElementById('fb-exit-comment');
    if (ta) ta.hidden = false;
  });
  // Resolves in ≤3 s whatever happens: the deletion never waits on this.
  function sendExit() {
    var box = document.querySelector('.fb-exit');
    if (box && box.dataset.sent === '1') return Promise.resolve(true); // a retry after a wrong password
    var answer = (document.querySelector('input[name="fb-exit"]:checked') || {}).value || null;
    var comment = ((document.getElementById('fb-exit-comment') || {}).value || '').trim();
    if (!answer && !comment) return Promise.resolve(false);
    return Promise.race([
      send({ kind: 'exit', trigger: 'account_delete', answer: answer, comment: comment }, { timeout: 3000 })
        .then(function () { if (box) box.dataset.sent = '1'; return true; }),
      new Promise(function (res) { setTimeout(function () { res(false); }, 3000); }),
    ]).catch(function () { return false; });
  }

  // ---------------------------------------------------------------- admin
  var KIND_LABEL = { rating: 'Rating', survey: 'Survey', bug: 'Bug', idea: 'Idea', exit: 'Exit' };
  function fmtDate(s) {
    var d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? esc(s) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function renderAdmin() {
    var main = document.getElementById('main-content');
    if (!main) return;
    var filters = { kind: '', trigger: '', status: '', tests: '' };
    main.innerHTML =
      '<div class="fb-admin">' +
        '<div class="page-header"><h1 class="page-title">Team</h1></div>' +
        '<section id="fba-metrics" class="fba-metrics" aria-labelledby="fba-m-h"><h2 id="fba-m-h" class="fba-h">New users: path and returns</h2><div class="loading"><div class="spinner"></div></div></section>' +
        '<h2 class="fba-h">Feedback</h2>' +
        '<div class="fb-admin-bar">' +
          '<select id="fba-kind" class="form-control"><option value="">All kinds</option>' + Object.keys(KIND_LABEL).map(function (k) { return '<option value="' + k + '">' + KIND_LABEL[k] + '</option>'; }).join('') + '</select>' +
          '<select id="fba-trigger" class="form-control"><option value="">All moments</option>' + ['menu', 'settings', 'import_done', 'day3', 'day7', 'account_delete'].map(function (k) { return '<option value="' + k + '">' + k + '</option>'; }).join('') + '</select>' +
          '<select id="fba-status" class="form-control"><option value="">Any status</option><option value="new">New</option><option value="seen">Seen</option><option value="done">Done</option></select>' +
          '<label class="fb-admin-tests"><input type="checkbox" id="fba-tests"> Show tests</label>' +
        '</div>' +
        '<div id="fba-stats" class="fb-admin-stats"></div>' +
        '<div id="fba-list" class="fb-admin-list"><div class="loading"><div class="spinner"></div></div></div>' +
      '</div>';
    function load() {
      var q = Object.keys(filters).filter(function (k) { return filters[k]; }).map(function (k) { return k + '=' + encodeURIComponent(filters[k]); }).join('&');
      fetchWithAuth('/api/feedback/admin' + (q ? '?' + q : ''))
        .then(function (r) { if (!r.ok) throw new Error(r.status === 404 ? 'This page is for the Finman team.' : 'Could not load feedback'); return r.json(); })
        .then(draw)
        .catch(function (e) { document.getElementById('fba-list').innerHTML = '<p class="fb-admin-empty">' + esc(e.message) + '</p>'; });
    }
    function draw(data) {
      var s = data.stats || {};
      var ans = (data.answers || []).slice(0, 8).map(function (a) { return '<span class="fb-admin-chip">' + esc(a.trigger) + ' · ' + esc(a.answer) + ' <b>' + a.n + '</b></span>'; }).join('');
      document.getElementById('fba-stats').innerHTML =
        '<div><b>' + (s.total || 0) + '</b><span>messages</span></div>' +
        '<div><b>' + (s.unread || 0) + '</b><span>new</span></div>' +
        '<div><b>' + (s.avg_rating != null ? s.avg_rating : '—') + '</b><span>average score (' + (s.rated || 0) + ')</span></div>' +
        (ans ? '<p class="fb-admin-answers">' + ans + '</p>' : '');
      var items = data.items || [];
      if (!items.length) { document.getElementById('fba-list').innerHTML = '<p class="fb-admin-empty">Nothing here yet.</p>'; return; }
      document.getElementById('fba-list').innerHTML = '<table class="fb-admin-table"><thead><tr><th>When</th><th>What</th><th>Message</th><th>Who</th><th>Status</th><th></th></tr></thead><tbody>' +
        items.map(function (it) {
          return '<tr data-id="' + it.id + '" class="st-' + esc(it.status) + (it.is_test ? ' is-test' : '') + '">' +
            '<td class="fba-when">' + fmtDate(it.created_at) + '</td>' +
            '<td class="fba-what"><span class="fb-kind k-' + esc(it.kind) + '">' + esc(KIND_LABEL[it.kind] || it.kind) + '</span><small>' + esc(it.trigger) + '</small></td>' +
            '<td class="fba-msg">' + (it.rating ? '<span class="fba-score">' + it.rating + '/5</span> ' : '') + (it.answer ? '<span class="fb-admin-chip">' + esc(it.answer) + '</span> ' : '') + esc(it.comment || '') + (it.is_test ? ' <span class="fb-admin-chip">test</span>' : '') + '</td>' +
            '<td class="fba-who">' + (it.user_id ? '#' + it.user_id : 'deleted') + '<small>' + esc([it.device, it.lang, it.page].filter(Boolean).join(' · ')) + '</small></td>' +
            '<td><select class="form-control fba-status" aria-label="Status">' + ['new', 'seen', 'done'].map(function (st) { return '<option value="' + st + '"' + (st === it.status ? ' selected' : '') + '>' + st + '</option>'; }).join('') + '</select></td>' +
            '<td><button type="button" class="btn btn-sm btn-outline fba-del" aria-label="Delete"><i class="fas fa-trash-alt" aria-hidden="true"></i></button></td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
    }
    ['kind', 'trigger', 'status'].forEach(function (k) {
      document.getElementById('fba-' + k).addEventListener('change', function (e) { filters[k] = e.target.value; load(); });
    });
    document.getElementById('fba-tests').addEventListener('change', function (e) { filters.tests = e.target.checked ? '1' : ''; load(); });
    document.getElementById('fba-list').addEventListener('change', function (e) {
      if (!e.target.classList.contains('fba-status')) return;
      var id = e.target.closest('tr').dataset.id;
      fetchWithAuth('/api/feedback/admin/' + id, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }).then(load);
    });
    document.getElementById('fba-list').addEventListener('click', function (e) {
      var b = e.target.closest('.fba-del');
      if (!b) return;
      if (!window.confirm('Delete this message?')) return;
      fetchWithAuth('/api/feedback/admin/' + b.closest('tr').dataset.id, { method: 'DELETE' }).then(load);
    });
    load();
    loadMetrics();
  }

  // Aggregates only (GET /api/feedback/admin/metrics, services/growthMetrics.js).
  var STEP_LABEL = { signed_up: 'Signed up', vault_ready: 'Saved the recovery key', first_screen: 'Saw the first screen', picked_a_path: 'Picked a way in',
    first_account: 'First account', own_data_in: 'Own data in', first_report: 'Saw a report' };
  function loadMetrics() {
    var box = document.getElementById('fba-metrics');
    fetchWithAuth('/api/feedback/admin/metrics')
      .then(function (r) { if (!r.ok) throw new Error('Could not count'); return r.json(); })
      .then(function (d) {
        var m = d.metrics, f = m.funnel, top = f.signed_up || 1;
        var pct = function (a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; };
        var steps = Object.keys(STEP_LABEL).map(function (k) {
          return '<li><span class="fba-step">' + STEP_LABEL[k] + '</span><span class="fba-bar"><i style="width:' + Math.max(2, Math.round((f[k] || 0) / top * 100)) + '%"></i></span><b>' + (f[k] || 0) + '</b></li>';
        }).join('');
        var weeks = Object.keys(m.by_week).sort().slice(-6).reverse().map(function (w) {
          var x = m.by_week[w];
          return '<tr><td>' + esc(w) + '</td><td>' + x.signups + '</td><td>' + x.activated + '</td><td>' + (x.week1_eligible ? x.week1_returned + ' of ' + x.week1_eligible : 'too early') + '</td><td>' + (x.week4_eligible ? x.week4_returned + ' of ' + x.week4_eligible : 'too early') + '</td></tr>';
        }).join('');
        box.innerHTML = '<h2 id="fba-m-h" class="fba-h">New users: path and returns <small>since ' + esc(m.since) + ', test and team accounts left out</small></h2>' +
          '<div class="fb-admin-stats">' +
            '<div><b>' + m.users_alive + '</b><span>live accounts</span></div>' +
            '<div><b>' + pct(m.activated, m.users_alive) + '</b><span>put their own data in (' + m.activated + ')</span></div>' +
            '<div><b>' + pct(m.week1.returned, m.week1.eligible) + '</b><span>came back in week 1 (' + m.week1.returned + ' of ' + m.week1.eligible + ')</span></div>' +
            '<div><b>' + pct(m.week4.returned, m.week4.eligible) + '</b><span>came back in week 4 (' + m.week4.returned + ' of ' + m.week4.eligible + ')</span></div>' +
          '</div>' +
          '<ol class="fba-funnel">' + steps + '</ol>' +
          '<table class="fb-admin-table fba-weeks"><thead><tr><th>Sign-up week</th><th>Sign-ups</th><th>Own data</th><th>Back in week 1</th><th>Back in week 4</th></tr></thead><tbody>' + weeks + '</tbody></table>';
      })
      .catch(function (e) { box.innerHTML = '<p class="fb-admin-empty">' + esc(e.message) + '</p>'; });
  }

  window.FMFeedback = {
    open: open,
    afterImport: afterImport,
    maybeDay7: maybeDay7,
    hideCard: hideCard,
    exitHtml: exitHtml,
    sendExit: sendExit,
    renderAdmin: renderAdmin,
    _card: card,
  };
})();
