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

  // Finman Vault: accounts on the fm1 scheme send a derived token instead of the password.
  async function sendPassword(u, p) {
    if (!window.FMCrypto) return p;
    try {
      var r = await fetch('/api/auth/prelogin', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(/@/.test(u) ? { email: u } : { username: u }) });
      var pre = r.ok ? await r.json() : null;
      if (pre && pre.kdf === 'fm1' && pre.salt) {
        var master = await window.FMCrypto.deriveMaster(p, pre.salt, pre.params);
        return await window.FMCrypto.authToken(master);
      }
    } catch (_) { /* legacy */ }
    return p;
  }

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
    loadVaultMeta(user);
  }

  // ---- Finman Vault (encrypted accounts): this app gets its own wrapped key ----
  var vault = { meta: null, user: null };
  function idbGet(key) {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('finman-vault', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onerror = function () { res(null); };
        rq.onsuccess = function () {
          try {
            var tx = rq.result.transaction('kv', 'readonly');
            var g = tx.objectStore('kv').get(key);
            g.onsuccess = function () { res(g.result || null); rq.result.close(); };
            g.onerror = function () { res(null); rq.result.close(); };
          } catch (_) { res(null); }
        };
      } catch (_) { res(null); }
    });
  }
  async function vaultKey() {
    var rec = await idbGet('dk:' + vault.user.id);
    if (rec && rec.dk) {
      try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, rec.dk, rec.ct)); } catch (_) { /* ask */ }
    }
    var pw = $('oa-vault-pw') ? $('oa-vault-pw').value : '';
    if (!pw) { $('oa-vault-box').hidden = false; $('oa-vault-pw').focus(); throw new Error('Enter your Finman password to give this app access to your encrypted data.'); }
    var C = window.FMCrypto;
    var master = await C.deriveMaster(pw, vault.meta.salt, vault.meta.params);
    try {
      return await C.unwrap(await C.kekFromMaster(master), vault.meta.wrapped_pw, C.wrapAad(vault.user.id, 'pw'));
    } catch (_) { throw new Error('That password does not open your encrypted data.'); }
  }
  async function vaultGrant() {
    if (!vault.meta || vault.meta.state !== 'active') return null;
    var C = window.FMCrypto;
    var vk = await vaultKey();
    var secret = C.randomBytes(32);
    var wrapped = await C.wrap(await C.kekFromGrant(secret), vk, C.wrapAad(vault.user.id, 'grant'));
    var s64 = C.b64(secret).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { wrapped_vk: wrapped, secret: s64 };
  }
  async function loadVaultMeta(user) {
    vault.user = user; vault.meta = null;
    try {
      var r = await fetch('/api/vault/meta', { headers: { Authorization: 'Bearer ' + token() } });
      if (r.ok) vault.meta = await r.json();
    } catch (_) { /* no vault */ }
    var on = !!(vault.meta && vault.meta.state === 'active');
    $('oa-vault-note').hidden = !on;
  }

  async function decide(approve) {
    var btns = [$('oa-allow'), $('oa-deny')];
    btns.forEach(function (b) { b.disabled = true; });
    $('oa-consent-error').textContent = '';
    try {
      var grant = null;
      if (approve === true) grant = await vaultGrant();
      var r = await fetch('/api/oauth/authorize/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify(Object.assign({ params: params, approve: approve === true }, grant ? { vault: grant } : {})),
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
      var r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: await sendPassword(u, p) }) });
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
