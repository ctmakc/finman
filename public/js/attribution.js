// public/js/attribution.js — where the visitor came from + analytics hooks.
//
// - First and last touch (utm_*, gclid/fbclid/msclkid, referrer, landing, and
//   fm_ref/fm_land passed by finman.money links) live in localStorage and go
//   to POST /api/auth/register (and through /api/auth/google?att=...), so the
//   account remembers its source.
// - Self-hosted OpenPanel (our server) through the same-origin /op relay:
//   screen views, outgoing links, data-track attributes, identify by user id.
// - window.FMTrack: attribution(), beacon(), identify(), reset(), formStart().
(function () {
  'use strict';

  var KEY = 'fm_att_v1';
  var ANON = 'fm_anon';
  var CAMPAIGN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'];
  var formStartedAt = null;

  function store() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  function load() {
    var s = store();
    if (!s) return {};
    try { return JSON.parse(s.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(v) {
    var s = store();
    if (s) try { s.setItem(KEY, JSON.stringify(v)); } catch (e) { /* quota */ }
  }
  function anonId() {
    var s = store();
    var id = s && s.getItem(ANON);
    if (!id) {
      id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      if (s) try { s.setItem(ANON, id); } catch (e) { /* ignore */ }
    }
    return id;
  }
  function cleanUrl(href) {
    // Never keep the OAuth token fragment or auth errors in analytics.
    try {
      var u = new URL(href);
      u.hash = '';
      u.searchParams.delete('auth_error');
      return u.toString().slice(0, 500);
    } catch (e) { return String(href || '').split('#')[0].slice(0, 500); }
  }
  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  function capture() {
    var params;
    try { params = new URL(window.location.href).searchParams; } catch (e) { return; }
    var touch = {};
    CAMPAIGN.forEach(function (k) {
      var v = params.get(k);
      if (v) touch[k] = v.slice(0, 200);
    });
    var ref = document.referrer || '';
    var refHost = hostOf(ref);
    var external = ref && refHost !== window.location.hostname && refHost !== 'accounts.google.com';
    if (external) touch.referrer = ref.slice(0, 500);
    if (params.get('fm_ref')) touch.site_referrer = params.get('fm_ref').slice(0, 500);
    if (params.get('fm_land')) touch.site_landing = params.get('fm_land').slice(0, 500);

    var att = load();
    var meaningful = Object.keys(touch).length > 0;
    if (!att.first) {
      touch.landing = cleanUrl(window.location.href);
      touch.first_seen_at = new Date().toISOString();
      att.first = touch;
      save(att);
    } else if (meaningful) {
      touch.landing = cleanUrl(window.location.href);
      touch.first_seen_at = new Date().toISOString();
      att.last = touch;
      save(att);
    }
  }

  function attribution() {
    var att = load();
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* old browser */ }
    return {
      first: att.first || {},
      last: att.last || {},
      anon_id: anonId(),
      tz: tz,
      lang: (navigator.language || '').slice(0, 20),
      form_ms: formStartedAt ? Date.now() - formStartedAt : null,
    };
  }

  function beacon(event, props) {
    try {
      var body = JSON.stringify({ event: event, anon_id: anonId(), path: window.location.pathname, props: props || {} });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/t', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
      }
    } catch (e) { /* analytics never breaks the app */ }
    op('track', event, props || {});
  }

  // ---- OpenPanel (self-hosted) ----
  window.op = window.op || (function () {
    var q = [];
    return new Proxy(function () { if (arguments.length) q.push([].slice.call(arguments)); }, {
      get: function (t, r) { return r === 'q' ? q : function () { q.push([r].concat([].slice.call(arguments))); }; },
      has: function (t, r) { return r === 'q'; },
    });
  })();
  // Calls made before init (config not loaded yet) wait here: the tracker
  // expects 'init' to be the first queued call.
  var opState = 'pending';
  var opPending = [];
  function op() {
    var args = [].slice.call(arguments);
    if (opState === 'pending') { if (opPending.length < 50) opPending.push(args); return; }
    if (opState !== 'on') return;
    try { Function.prototype.apply.call(window.op, null, args); } catch (e) { /* ignore */ }
  }
  function opRaw() {
    // window.op is a Proxy (queue stub, then the SDK): reading .apply on it
    // would go through its get trap, so call it via Function.prototype.
    try { Function.prototype.apply.call(window.op, null, arguments); } catch (e) { /* ignore */ }
  }

  // QA / smoke traffic stays out of OpenPanel: ?utm_source=test|qa|smoke (or
  // ?fm_qa=1) marks this browser; a .test / +smoke account does the same.
  var QA = 'fm_qa';
  function isQaEmail(e) { return /(\.test$|\+smoke@)/i.test(String(e || '')); }
  function markQa() {
    var s = store();
    if (s) try { s.setItem(QA, '1'); } catch (e) { /* ignore */ }
    opState = 'off'; opPending = [];
  }
  function isQa() {
    var s = store();
    if (s && s.getItem(QA) === '1') return true;
    try {
      var p = new URLSearchParams(window.location.search);
      if (/^(test|qa|smoke)$/i.test(p.get('utm_source') || '') || p.get('fm_qa') === '1') { markQa(); return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  function startOpenPanel() {
    if (isQa()) { opState = 'off'; opPending = []; return; }
    fetch('/api/t/config', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.openpanel) { opState = 'off'; opPending = []; return; }
        opRaw('init', {
          clientId: cfg.openpanel.clientId,
          apiUrl: window.location.origin + cfg.openpanel.apiUrl,
          trackScreenViews: true,
          trackOutgoingLinks: true,
          trackAttributes: true,
          // re-checked on every event: a QA account found after login stops autocapture too
          filter: function () { var st = store(); return !(st && st.getItem(QA) === '1'); },
        });
        var first = load().first || {};
        opRaw('setGlobalProperties', {
          platform: window.Capacitor ? 'app' : 'web',
          first_source: first.utm_source || hostOf(first.site_referrer || first.referrer || '') || 'direct',
        });
        var s = document.createElement('script');
        s.src = '/vendor/op1.js';
        s.async = true;
        document.head.appendChild(s);
        opState = 'on';
        opPending.forEach(function (a) { opRaw.apply(null, a); });
        opPending = [];
      })
      .catch(function () { opState = 'off'; opPending = []; });
  }

  function identify(user) {
    if (!user || !user.id) return;
    if (isQaEmail(user.email)) { markQa(); return; }
    var name = String(user.fullName || '').trim().split(/\s+/);
    op('identify', {
      profileId: String(user.id),
      email: user.email || undefined,
      firstName: name[0] || undefined,
      lastName: name.slice(1).join(' ') || undefined,
    });
  }

  function reset() {
    op('clear');
  }

  capture();
  startOpenPanel();

  window.FMTrack = {
    attribution: attribution,
    attributionParam: function () {
      try { return encodeURIComponent(JSON.stringify(attribution())); } catch (e) { return ''; }
    },
    beacon: beacon,
    identify: identify,
    reset: reset,
    formStart: function () { if (!formStartedAt) formStartedAt = Date.now(); },
  };
})();
