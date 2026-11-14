// public/js/oauth-authorize.js — consent screen of the Finman MCP connector.
// Reads the OAuth request from the URL, signs the person in (password or Google, the
// same Finman account and JWT as the app) and sends Allow / Cancel to the server,
// which answers with the address to return to (the app's redirect_uri).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var params = {};
  new URLSearchParams(location.search).forEach(function (v, k) { params[k] = v; });
  var RETURN_KEY = 'fm_oauth_return';

  function show(id, on) { $(id).hidden = !on; }
  function token() { try { return localStorage.getItem('token'); } catch (_) { return null; } }
  function setText(id, t) { $(id).textContent = t; }

  function fatal(msg) {
    setText('oa-title', 'This link does not work');
    setText('oa-sub', 'Go back to the app and connect Finman again.');
    $('oa-fatal').textContent = msg;
    show('oa-fatal', true); show('oa-login', false); show('oa-consent', false);
  }

  function go(url) { location.assign(url); }

  async function me() {
    var t = token();
    if (!t) return null;
    try {
      var r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + t } });
      if (!r.ok) return null;
      var j = await r.json();
      var u = j.user || j;
      return u && (u.email || u.username) ? u : null;
    } catch (_) { return null; }
  }

  function askLogin(app) {
    setText('oa-title', 'Sign in to Finman');
    setText('oa-sub', app + ' asks to connect to your Finman account.');
    show('oa-consent', false); show('oa-login', true);
    fetch('/api/auth/google/status').then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) {
      if (j && j.enabled) show('oa-google-box', true);
    }).catch(function () {});
    setTimeout(function () { try { $('oa-username').focus({ preventScroll: true }); } catch (_) {} }, 50);
  }

  function askConsent(app, host, user) {
    setText('oa-title', 'Allow ' + app + '?');
    setText('oa-sub', 'Connect ' + app + ' to your Finman account.');
    setText('oa-app', app);
    setText('oa-user', user.email || user.username);
    setText('oa-host', host || 'the app');
    show('oa-login', false); show('oa-consent', true);
  }

  async function decide(approve) {
    var btns = [$('oa-allow'), $('oa-deny')];
    btns.forEach(function (b) { b.disabled = true; });
    $('oa-consent-error').textContent = '';
    try {
      var r = await fetch('/api/oauth/authorize/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify({ params: params, approve: approve === true }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 401) { try { localStorage.removeItem('token'); } catch (_) {} return start(); }
      if (!r.ok || !j.redirect) throw new Error(j.error_description || 'Something went wrong. Try again.');
      setText('oa-sub', approve ? 'Connected. Returning to the app…' : 'Cancelled. Returning to the app…');
      go(j.redirect);
    } catch (e) {
      $('oa-consent-error').textContent = e.message;
      btns.forEach(function (b) { b.disabled = false; });
    }
  }

  var state = { app: 'An app', host: '' };

  async function start() {
    var r, j;
    try {
      r = await fetch('/api/oauth/authorize/check?' + new URLSearchParams(params).toString());
      j = await r.json();
    } catch (_) { return fatal('Finman could not be reached. Check the connection and reload the page.'); }
    if (j.fatal) return fatal(j.fatal);
    if (!j.ok && j.redirect) return go(j.redirect);
    state.app = j.app || 'An app';
    state.host = j.return_host || '';
    var user = await me();
    if (!user) return askLogin(state.app);
    askConsent(state.app, state.host, user);
  }

  $('oa-login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var err = $('oa-login-error');
    err.textContent = '';
    var u = $('oa-username').value.trim();
    var p = $('oa-password').value;
    if (!u || !p) { err.textContent = 'Enter your email (or username) and password.'; return; }
    var btn = $('oa-login-btn');
    btn.disabled = true;
    try {
      var r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.token) throw new Error(j.message || 'Wrong email or password.');
      localStorage.setItem('token', j.token);
      $('oa-password').value = '';
      await start();
    } catch (e) {
      err.textContent = e.message;
    } finally { btn.disabled = false; }
  });

  // Google: the app's own sign-in; app.js brings the browser back here afterwards.
  $('oa-google').addEventListener('click', function () {
    try { sessionStorage.setItem(RETURN_KEY, location.pathname + location.search); } catch (_) {}
  });

  $('oa-switch').addEventListener('click', function (ev) {
    ev.preventDefault();
    try { localStorage.removeItem('token'); } catch (_) {}
    askLogin(state.app);
  });
  $('oa-allow').addEventListener('click', function () { decide(true); });
  $('oa-deny').addEventListener('click', function () { decide(false); });

  start();
})();
