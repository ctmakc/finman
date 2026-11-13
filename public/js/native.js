// public/js/native.js — Finman inside the iOS / Android app (Capacitor 8 shell
// that loads https://app.finman.money).
//
// On the website this file does nothing. The shell is recognised by the
// Capacitor bridge (the source of truth for every plugin call); index.html has
// already set html.is-native + platform-ios|android from the "FinmanApp" user
// agent so the first paint is right. `?native=ios|android` (or
// localStorage.fm_native_debug = '1') turns on a desktop preview: classes and
// UI only, no plugin calls. `?native=off` clears it.
//
// What it does in the app:
//   - Google sign-in in the system browser with a one-time nonce hand-off
//     (/api/auth/google?app_nonce=… → app-return.html → money.finman.app://auth-done
//     → POST /api/auth/app/claim);
//   - Sign in with Apple on iOS (native sheet → POST /api/auth/apple);
//   - Android back button, status bar style per theme, splash hide;
//   - downloads (blob:/data: links) go to the share sheet, external links and
//     window.open go to the in-app browser;
//   - plans and billing are hidden (sold on the website);
//   - optional Face ID / fingerprint lock after a minute in the background.
// Tokens and nonces are never logged.
(function () {
  'use strict';

  var Cap = window.Capacitor;
  var isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  var early = window.FM_NATIVE || null;
  if (!isNative && !early) return; // the website

  var platform = isNative ? Cap.getPlatform() : early.platform;
  if (platform !== 'ios' && platform !== 'android') return;
  var debug = !isNative;
  var root = document.documentElement;
  root.classList.add('is-native', 'platform-' + platform);
  if (debug) root.classList.add('native-debug');

  var APP_ID = 'money.finman.app';
  var ORIGIN = 'https://app.finman.money';
  var AUTH_DONE = APP_ID + '://auth-done';
  var PENDING_KEY = 'fm_app_auth_pending';
  var PENDING_TTL_MS = 10 * 60 * 1000;
  var LOCK_KEY = 'fm_app_lock';
  var LOCK_AFTER_MS = 60 * 1000;

  // ---- plugins (never on the website or in the preview) --------------------
  var P = (n) => window.Capacitor && window.Capacitor.registerPlugin ? window.Capacitor.registerPlugin(n) : null;
  var plugins = {};
  function plugin(name) {
    if (!isNative) return null;
    if (!(name in plugins)) {
      try { plugins[name] = P(name); } catch (_) { plugins[name] = null; }
    }
    return plugins[name];
  }
  function call(name, method, args) {
    var p = plugin(name);
    if (!p || typeof p[method] !== 'function') return Promise.resolve(null);
    try { return Promise.resolve(p[method](args)).catch(function () { return null; }); } catch (_) { return Promise.resolve(null); }
  }
  function listen(name, event, fn) {
    var p = plugin(name);
    if (!p || typeof p.addListener !== 'function') return;
    try { Promise.resolve(p.addListener(event, fn)).catch(function () {}); } catch (_) { /* plugin missing */ }
  }

  // ---- small helpers -------------------------------------------------------
  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    window.crypto.getRandomValues(a);
    var s = '';
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  function sha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle) return Promise.resolve(null);
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      var a = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
      return s;
    }).catch(function () { return null; });
  }
  function notify(msg, type) {
    if (typeof window.showNotification === 'function') window.showNotification(msg, type || 'info');
  }
  function store(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (_) { /* private mode */ }
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function attribution() {
    try { return window.FMTrack && window.FMTrack.attributionParam ? window.FMTrack.attributionParam() : ''; } catch (_) { return ''; }
  }
  function beacon(name) {
    try { if (window.FMTrack && window.FMTrack.beacon) window.FMTrack.beacon(name); } catch (_) { /* optional */ }
  }

  // Shows a sign-in error in the visible form, or as a toast.
  function authError(msg) {
    var el = document.querySelector('.auth-form:not(.hidden) .auth-error');
    if (el) el.textContent = msg;
    else notify(msg, 'error');
  }

  // Same as handleLogin in app.js after a successful POST /api/auth/login.
  function signedIn(token, user) {
    localStorage.setItem('token', token);
    store('fm_returning', '1');
    try {
      if (typeof appState !== 'undefined') {
        appState.isAuthenticated = true;
        if (user) appState.user = user;
      }
    } catch (_) { /* app.js not loaded */ }
    if (typeof window.initApp === 'function') window.initApp();
  }

  // ======================================================================
  // Google sign-in through the system browser
  // ======================================================================
  var GOOGLE_ERRORS = {
    email_exists: 'An account with this email already exists. Sign in with your password.',
    google_denied: 'Google sign-in was cancelled.',
    google_failed: 'Google sign-in failed. Try again or use your password.',
  };
  var claiming = false;

  function readPending() {
    var raw = read(PENDING_KEY);
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      if (!p || !/^[a-f0-9]{64}$/.test(p.n) || Date.now() - p.t > PENDING_TTL_MS) {
        store(PENDING_KEY, null);
        return null;
      }
      return p;
    } catch (_) {
      store(PENDING_KEY, null);
      return null;
    }
  }

  function startGoogle() {
    var nonce = randomHex(32); // 64 hex chars
    store(PENDING_KEY, JSON.stringify({ n: nonce, t: Date.now(), tries: 0 }));
    beacon('google_click');
    var url = ORIGIN + '/api/auth/google?app_nonce=' + nonce + '&att=' + encodeURIComponent(attribution());
    var browser = plugin('Browser');
    if (!browser) {
      store(PENDING_KEY, null);
      authError(GOOGLE_ERRORS.google_failed);
      return;
    }
    Promise.resolve(browser.open({ url: url, presentationStyle: 'popover' })).catch(function () {
      store(PENDING_KEY, null);
      authError(GOOGLE_ERRORS.google_failed);
    });
  }

  // fromLink: the browser came back through money.finman.app://auth-done, so the
  // server has already stored the result; a 404 there is worth one retry.
  function claimGoogle(fromLink, linkError) {
    var pending = readPending();
    if (!pending || claiming) return;
    claiming = true;
    fetch('/api/auth/app/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: pending.n }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body || {} }; });
    }).then(function (r) {
      claiming = false;
      if (r.status === 200 && r.body.token) {
        store(PENDING_KEY, null);
        signedIn(r.body.token, null);
        return;
      }
      if (r.status === 200 && r.body.error) {
        store(PENDING_KEY, null);
        authError(GOOGLE_ERRORS[r.body.error] || GOOGLE_ERRORS.google_failed);
        return;
      }
      if (r.status === 404) {
        // Nothing parked yet: the browser was closed early, or the redirect is
        // a moment ahead of us. A few tries, then the flow is dropped quietly.
        pending.tries = (pending.tries || 0) + 1;
        if (pending.tries >= 3) store(PENDING_KEY, null);
        else store(PENDING_KEY, JSON.stringify(pending));
        if (fromLink && pending.tries < 3) setTimeout(function () { claimGoogle(true, linkError); }, 900);
        else if (linkError) { store(PENDING_KEY, null); authError(GOOGLE_ERRORS[linkError] || GOOGLE_ERRORS.google_failed); }
        return;
      }
      if (r.status === 400) {
        store(PENDING_KEY, null);
        authError(GOOGLE_ERRORS.google_failed);
        return;
      }
      // 429 / 5xx: keep the flow, the next resume tries again.
      if (fromLink) authError(r.body.message || GOOGLE_ERRORS.google_failed);
    }).catch(function () {
      claiming = false;
      if (fromLink) authError('Could not sign in. Please check your connection and try again.');
    });
  }

  function onAppUrl(data) {
    var url = data && typeof data.url === 'string' ? data.url : '';
    if (url.indexOf(AUTH_DONE) !== 0) return;
    call('Browser', 'close');
    var m = url.match(/[?&]error=([a-z_]{1,40})/);
    claimGoogle(true, m ? m[1] : null);
  }

  // ======================================================================
  // Sign in with Apple (iOS)
  // ======================================================================
  var APPLE_LOGO = '<svg viewBox="0 0 17 20" aria-hidden="true"><path fill="currentColor" d="M14.06 10.63c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.54zM11.86 4.17c.61-.74 1.02-1.76.91-2.78-.88.04-1.94.59-2.57 1.32-.56.65-1.06 1.69-.93 2.69.98.08 1.98-.5 2.59-1.23z"/></svg>';

  function appleError(e) {
    var text = String((e && (e.code || e.message)) || '');
    // The user closed the sheet: no message.
    if (/1001|cancel/i.test(text)) return;
    authError('Sign in with Apple did not finish. Try again.');
  }

  function startApple(btn) {
    if (debug) {
      notify('Sign in with Apple opens in the Finman iOS app.', 'info');
      return;
    }
    var siwa = plugin('SignInWithApple');
    if (!siwa) { authError('Sign in with Apple is unavailable right now.'); return; }
    var raw = randomHex(32);
    btn.disabled = true;
    beacon('apple_click');
    sha256Hex(raw).then(function (hashed) {
      // Apple embeds the nonce we pass; the server accepts sha256(raw) or raw.
      return siwa.authorize({
        clientId: APP_ID,
        redirectURI: ORIGIN + '/api/auth/apple',
        scopes: 'email name',
        state: randomHex(16),
        nonce: hashed || raw,
      });
    }).then(function (result) {
      var r = result && result.response;
      if (!r || !r.identityToken) throw new Error('no identity token');
      return fetch('/api/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identityToken: r.identityToken,
          authorizationCode: r.authorizationCode || null,
          nonce: raw,
          givenName: r.givenName || null,
          familyName: r.familyName || null,
          attribution: attribution() || null,
        }),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          btn.disabled = false;
          if (res.ok && body && body.token) { signedIn(body.token, body.user); return; }
          authError((body && body.message) || 'Sign in with Apple failed. Try again.');
        });
      }, function () {
        btn.disabled = false;
        authError('Could not sign in. Please check your connection and try again.');
      });
    }).catch(function (e) {
      btn.disabled = false;
      appleError(e);
    });
  }

  // ---- login page decoration ----------------------------------------------
  function decorateLogin() {
    var social = document.getElementById('auth-social');
    if (!social || social.dataset.native === '1') return;
    social.dataset.native = '1';
    var google = social.querySelector('.btn-google');
    if (platform !== 'ios' || !google) return;

    var stack = document.createElement('div');
    stack.className = 'fm-social-stack';
    var apple = document.createElement('button');
    apple.type = 'button';
    apple.className = 'btn-apple';
    apple.innerHTML = APPLE_LOGO + '<span>Sign in with Apple</span>';
    apple.addEventListener('click', function () { startApple(apple); });
    google.parentNode.insertBefore(stack, google);
    stack.appendChild(apple);
    stack.appendChild(google);

    // Apple is always offered on iOS; Google only when the server has it.
    social.hidden = false;
    google.hidden = true;
    fetch('/api/auth/google/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (s && s.enabled) google.hidden = false;
    }).catch(function () { /* keep Google hidden */ });
  }

  // Google button: the app goes through the system browser. The preview keeps
  // the website flow so it can be tried on a desktop.
  document.addEventListener('click', function (e) {
    var g = e.target && e.target.closest ? e.target.closest('.btn-google') : null;
    if (!g || debug) return;
    e.preventDefault();
    e.stopPropagation();
    startGoogle();
  }, true);

  // ======================================================================
  // Downloads → share sheet; external links → in-app browser
  // ======================================================================
  // Blob URLs are usually revoked right after click(); keep the blob by URL.
  var blobs = new Map();
  if (isNative && window.URL && URL.createObjectURL) {
    var createURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
      var u = createURL(obj);
      if (obj instanceof Blob) {
        blobs.set(u, obj);
        if (blobs.size > 20) blobs.delete(blobs.keys().next().value);
      }
      return u;
    };
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function safeName(name) {
    var n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 120);
    return n || 'finman-export';
  }

  function shareDownload(href, filename) {
    var blobP;
    if (href.indexOf('data:') === 0) {
      var comma = href.indexOf(',');
      var meta = href.slice(5, comma);
      var payload = href.slice(comma + 1);
      blobP = Promise.resolve(/;base64/.test(meta) ? payload : btoa(unescape(decodeURIComponent(payload))));
    } else {
      var b = blobs.get(href);
      blobs.delete(href);
      blobP = (b ? Promise.resolve(b) : fetch(href).then(function (r) { return r.blob(); })).then(blobToBase64);
    }
    var name = safeName(filename);
    return blobP.then(function (data) {
      return plugin('Filesystem').writeFile({ path: name, data: data, directory: 'CACHE' });
    }).then(function (res) {
      return plugin('Share').share({ title: name, files: [res.uri], dialogTitle: 'Save or share' });
    }).catch(function (e) {
      if (/cancel/i.test(String(e && (e.message || e.code) || ''))) return;
      notify('Could not save the file. Try again.', 'error');
    });
  }

  function isDownloadLink(a) {
    if (!a || !a.getAttribute) return false;
    var href = a.getAttribute('href') || '';
    return a.hasAttribute('download') || /^(blob|data):/i.test(href);
  }

  function externalUrl(a) {
    var href = a && a.href;
    if (!href || !/^https?:/i.test(href)) return null;
    try {
      var u = new URL(href, window.location.href);
      if (u.origin === window.location.origin && a.target !== '_blank') return null;
      return u.href;
    } catch (_) { return null; }
  }

  if (isNative) {
    var nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (isDownloadLink(this) && /^(blob|data):/i.test(this.href || '')) {
        shareDownload(this.href, this.getAttribute('download') || '');
        return;
      }
      return nativeClick.apply(this, arguments);
    };

    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      if (isDownloadLink(a) && /^(blob|data):/i.test(a.href || '')) {
        e.preventDefault();
        shareDownload(a.href, a.getAttribute('download') || '');
        return;
      }
      var ext = externalUrl(a);
      if (ext) {
        e.preventDefault();
        call('Browser', 'open', { url: ext, presentationStyle: 'popover' });
      }
    }, true);

    var nativeOpen = window.open;
    window.open = function (url) {
      try {
        var u = new URL(String(url || ''), window.location.href);
        if (/^https?:$/.test(u.protocol)) {
          call('Browser', 'open', { url: u.href, presentationStyle: 'popover' });
          return null;
        }
      } catch (_) { /* fall through */ }
      return nativeOpen.apply(window, arguments);
    };
  }

  // ======================================================================
  // Billing is web-only
  // ======================================================================
  if (typeof window.navigateTo === 'function') {
    var navigate = window.navigateTo;
    window.navigateTo = function (page, options) {
      if (page === 'billing') page = 'dashboard';
      return navigate.call(this, page, options);
    };
  }

  // ======================================================================
  // Android back button, status bar, splash, keyboard, haptics
  // ======================================================================
  function anyModalOpen() {
    return document.body && document.body.classList.contains('fm-modal-open');
  }

  listen('App', 'backButton', function () {
    if (anyModalOpen() && window.UI && typeof window.UI.closeTopModal === 'function') {
      window.UI.closeTopModal();
      return;
    }
    var legacy = document.querySelector('.modal-backdrop:not([hidden]) .modal-close');
    if (legacy) { legacy.click(); return; }
    if (typeof window.isDrawerOpen === 'function' && window.isDrawerOpen()) {
      window.closeDrawer();
      return;
    }
    var page = null;
    var authed = false;
    try { page = appState.currentPage; authed = appState.isAuthenticated; } catch (_) { /* no app state */ }
    if (authed && page && page !== 'dashboard' && document.getElementById('main-content')) {
      window.navigateTo('dashboard');
      return;
    }
    call('App', 'minimizeApp');
  });

  function syncStatusBar() {
    var dark = window.theme && typeof window.theme.getResolved === 'function'
      ? window.theme.getResolved() === 'dark'
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    // DARK = light text for dark backgrounds.
    call('StatusBar', 'setStyle', { style: dark ? 'DARK' : 'LIGHT' });
  }
  if (isNative) {
    syncStatusBar();
    if (window.theme && typeof window.theme.onChange === 'function') window.theme.onChange(syncStatusBar);
  }

  // Splash: hide as soon as the first real screen replaces "Loading…".
  var splashDone = false;
  function hideSplash() {
    if (splashDone) return;
    splashDone = true;
    call('SplashScreen', 'hide', { fadeOutDuration: 200 });
  }
  if (isNative) setTimeout(hideSplash, 4000);

  listen('Keyboard', 'keyboardWillShow', function () { root.classList.add('fm-keyboard-open'); });
  listen('Keyboard', 'keyboardWillHide', function () { root.classList.remove('fm-keyboard-open'); });

  if (isNative) {
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('.btn-primary, .fm-nav-link, .fm-drawer-link, .auth-tab') : null;
      if (!t) return;
      if (t.classList.contains('btn-primary')) call('Haptics', 'impact', { style: 'LIGHT' });
      else call('Haptics', 'selectionChanged');
    }, true);
  }

  // ======================================================================
  // App lock (Face ID / Touch ID / fingerprint), off by default
  // ======================================================================
  var pausedAt = 0;
  var lockShown = false;

  function lockEnabled() { return read(LOCK_KEY) === '1'; }
  function hasSession() { return !!read('token'); }

  var biometryInfo = null;
  function biometry() {
    if (biometryInfo) return biometryInfo;
    var p = plugin('BiometricAuthNative');
    if (!p || typeof p.checkBiometry !== 'function') return (biometryInfo = Promise.resolve(null));
    biometryInfo = Promise.resolve(p.checkBiometry()).catch(function () { return null; });
    return biometryInfo;
  }

  function authenticate() {
    var p = plugin('BiometricAuthNative');
    if (!p || typeof p.internalAuthenticate !== 'function') return Promise.reject(new Error('unavailable'));
    return Promise.resolve(p.internalAuthenticate({
      reason: 'Unlock Finman',
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
      iosFallbackTitle: 'Use passcode',
      androidTitle: 'Unlock Finman',
      androidSubtitle: '',
      androidConfirmationRequired: false,
    }));
  }

  function lockScreen() {
    var el = document.getElementById('fm-lock');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'fm-lock';
    el.className = 'fm-lock';
    el.hidden = true;
    el.innerHTML =
      '<div class="fm-lock-inner" role="dialog" aria-modal="true" aria-labelledby="fm-lock-title">' +
        '<div class="fm-lock-mark" aria-hidden="true"><i class="fas fa-lock"></i></div>' +
        '<h1 id="fm-lock-title">Finman is locked</h1>' +
        '<p>Unlock to see your accounts.</p>' +
        '<button type="button" class="btn btn-primary" id="fm-lock-unlock">Unlock</button>' +
        '<button type="button" class="btn btn-outline" id="fm-lock-signout">Sign out</button>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('#fm-lock-unlock').addEventListener('click', tryUnlock);
    el.querySelector('#fm-lock-signout').addEventListener('click', function () {
      unlock();
      if (typeof window.logout === 'function') window.logout();
    });
    return el;
  }

  function unlock() {
    lockShown = false;
    var el = document.getElementById('fm-lock');
    if (el) el.hidden = true;
    document.body.classList.remove('fm-locked');
  }

  function tryUnlock() {
    authenticate().then(unlock, function () { /* stay locked; the button retries */ });
  }

  function lockNow() {
    if (lockShown || !lockEnabled() || !hasSession() || !document.body) return;
    lockShown = true;
    lockScreen().hidden = false;
    document.body.classList.add('fm-locked');
    tryUnlock();
  }

  if (isNative) {
    listen('App', 'pause', function () { pausedAt = Date.now(); });
    listen('App', 'resume', function () {
      if (pausedAt && Date.now() - pausedAt > LOCK_AFTER_MS) lockNow();
      pausedAt = 0;
      // Back from the system browser without the deep link (closed by hand,
      // or the link was blocked): pick up a finished Google sign-in.
      if (readPending()) setTimeout(function () { claimGoogle(false, null); }, 400);
    });
    listen('App', 'appUrlOpen', onAppUrl);
    listen('Browser', 'browserFinished', function () {
      if (readPending()) setTimeout(function () { claimGoogle(false, null); }, 400);
    });
  }

  // Settings → App lock card (only where the device has biometrics).
  function decorateSettings() {
    var container = document.querySelector('#main-content .settings-container');
    if (!container || container.querySelector('#fm-app-lock-card') || debug) return;
    biometry().then(function (info) {
      if (!info || !info.isAvailable || container.querySelector('#fm-app-lock-card')) return;
      var face = info.biometryType === 2 || info.biometryType === 4; // faceId / faceAuthentication
      var label = platform === 'ios' ? (face ? 'Face ID' : 'Touch ID') : (face ? 'face unlock' : 'fingerprint');
      var card = document.createElement('div');
      card.className = 'card';
      card.id = 'fm-app-lock-card';
      card.innerHTML =
        '<div class="fm-switch-row">' +
          '<div><h2 class="card-title">App lock</h2>' +
          '<p>Ask for ' + label + ' when you come back to Finman after a minute away.</p></div>' +
          '<label class="fm-switch"><input type="checkbox" id="fm-app-lock-toggle" aria-label="App lock with ' + label + '"><span></span></label>' +
        '</div>';
      var danger = container.querySelector('.fm-danger-zone');
      container.insertBefore(card, danger || null);
      var toggle = card.querySelector('#fm-app-lock-toggle');
      toggle.checked = lockEnabled();
      toggle.addEventListener('change', function () {
        if (!toggle.checked) { store(LOCK_KEY, null); return; }
        // Confirm once before turning it on, so a broken sensor cannot lock anyone out.
        authenticate().then(function () { store(LOCK_KEY, '1'); }, function () { toggle.checked = false; });
      });
    });
  }

  // ======================================================================
  // React to screens as app.js renders them
  // ======================================================================
  function onRender() {
    var app = document.getElementById('app');
    if (!app) return;
    if (!app.querySelector('.loading-screen')) hideSplash();
    if (document.getElementById('auth-social')) decorateLogin();
    decorateSettings();
  }

  function boot() {
    var app = document.getElementById('app');
    if (app && typeof MutationObserver === 'function') {
      new MutationObserver(onRender).observe(app, { childList: true, subtree: true });
    }
    onRender();
    if (isNative) {
      if (lockEnabled() && hasSession()) lockNow();
      if (readPending()) claimGoogle(false, null);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.FinmanNative = { platform: platform, debug: debug, isNative: isNative };
})();
