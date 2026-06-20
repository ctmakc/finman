// ==================== i18n RUNTIME ====================
// Tiny runtime internationalization for FINMAN (additive, opt-in).
//
// Locale dictionaries are provided on window.FINMAN_LOCALES.{en,uk,ru}
// (see public/js/locales/*.js). Existing feature modules keep working
// untouched; new/updated markup can opt in via:
//   data-i18n="some.key"            -> sets element textContent
//   data-i18n-placeholder="key"     -> sets input/textarea placeholder
//   data-i18n-title="key"           -> sets title attribute
//   data-i18n-aria-label="key"      -> sets aria-label attribute
//
// Public API (also exposed on window.i18n):
//   t(key, vars)   -> translated string with {var} interpolation; falls
//                     back to the key itself when missing.
//   setLanguage(lang) / getLanguage()
//   translateDocument(root) / translateElement(el)
//   onChange(cb) -> subscribe to language changes; returns unsubscribe.
//   available()  -> list of available language codes.
//
// Default language: uk (with en, ru). Persisted to localStorage.

(function (root) {
  'use strict';

  var STORAGE_KEY = 'finman_lang';
  var DEFAULT_LANG = 'uk';
  var SUPPORTED = ['uk', 'en', 'ru'];

  // Dictionaries: in the browser they come from window.FINMAN_LOCALES
  // (populated by the locale script tags). In node/tests the caller may
  // inject them via i18n.registerLocales(...).
  var locales =
    (typeof root !== 'undefined' && root.FINMAN_LOCALES) ? root.FINMAN_LOCALES : {};

  var currentLang = DEFAULT_LANG;
  var listeners = [];

  // ---- storage helpers (guarded — localStorage may be absent in node) ----
  function readStored() {
    try {
      if (typeof root !== 'undefined' && root.localStorage) {
        return root.localStorage.getItem(STORAGE_KEY);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeStored(lang) {
    try {
      if (typeof root !== 'undefined' && root.localStorage) {
        root.localStorage.setItem(STORAGE_KEY, lang);
      }
    } catch (e) { /* ignore */ }
  }

  function isSupported(lang) {
    return SUPPORTED.indexOf(lang) !== -1;
  }

  // Resolve a nested key like "nav.dashboard" from a dictionary object.
  // Dictionaries may be flat ({ 'nav.dashboard': '...' }) or nested
  // ({ nav: { dashboard: '...' } }); both are supported.
  function lookup(dict, key) {
    if (!dict || typeof key !== 'string') return undefined;
    if (Object.prototype.hasOwnProperty.call(dict, key)) {
      return dict[key];
    }
    var parts = key.split('.');
    var cur = dict;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // {var} interpolation; {{var}} also accepted for convenience.
  function interpolate(str, vars) {
    if (typeof str !== 'string' || !vars) return str;
    return str.replace(/\{\{?\s*([\w.$-]+)\s*\}?\}/g, function (match, name) {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        var v = vars[name];
        return v == null ? '' : String(v);
      }
      return match;
    });
  }

  // Core translate. Resolution order:
  //   current language -> default language -> the key itself.
  function t(key, vars) {
    if (key == null) return '';
    var val = lookup(locales[currentLang], key);
    if (val === undefined && currentLang !== DEFAULT_LANG) {
      val = lookup(locales[DEFAULT_LANG], key);
    }
    if (val === undefined || typeof val === 'object') {
      // Missing or points to a sub-tree -> fall back to the key.
      return interpolate(key, vars);
    }
    return interpolate(val, vars);
  }

  function getLanguage() {
    return currentLang;
  }

  function available() {
    return SUPPORTED.slice();
  }

  function registerLocales(obj) {
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(function (k) {
        locales[k] = obj[k];
      });
    }
    return locales;
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function unsubscribe() {
      var idx = listeners.indexOf(cb);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](currentLang); } catch (e) { /* ignore listener errors */ }
    }
  }

  function setLanguage(lang, opts) {
    if (!isSupported(lang)) return currentLang;
    currentLang = lang;
    writeStored(lang);
    if (typeof root !== 'undefined' && root.document && root.document.documentElement) {
      try { root.document.documentElement.setAttribute('lang', lang); } catch (e) { /* ignore */ }
    }
    if (!opts || opts.translate !== false) {
      translateDocument();
    }
    notify();
    return currentLang;
  }

  // ---- DOM translation (no-op outside the browser) ----
  function translateElement(el) {
    if (!el || !el.getAttribute) return;
    var key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);

    var ph = el.getAttribute('data-i18n-placeholder');
    if (ph) el.setAttribute('placeholder', t(ph));

    var title = el.getAttribute('data-i18n-title');
    if (title) el.setAttribute('title', t(title));

    var aria = el.getAttribute('data-i18n-aria-label');
    if (aria) el.setAttribute('aria-label', t(aria));

    var html = el.getAttribute('data-i18n-html');
    if (html) el.innerHTML = t(html);
  }

  function translateDocument(rootEl) {
    if (typeof root === 'undefined' || !root.document) return;
    var scope = rootEl || root.document;
    if (!scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll(
      '[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label],[data-i18n-html]'
    );
    for (var i = 0; i < nodes.length; i++) {
      translateElement(nodes[i]);
    }
  }

  // ---- bootstrap: pick stored or browser language, then translate ----
  function detectInitialLang() {
    var stored = readStored();
    if (stored && isSupported(stored)) return stored;
    try {
      if (typeof root !== 'undefined' && root.navigator && root.navigator.language) {
        var nav = String(root.navigator.language).slice(0, 2).toLowerCase();
        if (isSupported(nav)) return nav;
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_LANG;
  }

  function init() {
    currentLang = detectInitialLang();
    if (typeof root !== 'undefined' && root.document) {
      var apply = function () {
        if (root.document.documentElement) {
          try { root.document.documentElement.setAttribute('lang', currentLang); } catch (e) { /* ignore */ }
        }
        translateDocument();
      };
      if (root.document.readyState === 'loading' && root.document.addEventListener) {
        root.document.addEventListener('DOMContentLoaded', apply);
      } else {
        apply();
      }
    }
  }

  var api = {
    t: t,
    setLanguage: setLanguage,
    getLanguage: getLanguage,
    available: available,
    onChange: onChange,
    translateDocument: translateDocument,
    translateElement: translateElement,
    registerLocales: registerLocales,
    DEFAULT_LANG: DEFAULT_LANG,
    SUPPORTED: SUPPORTED.slice(),
    // exposed for tests / introspection
    _interpolate: interpolate,
    _lookup: lookup
  };

  // Expose on the global object (browser: window.i18n + window.t shortcut).
  if (typeof root !== 'undefined') {
    root.i18n = api;
    if (typeof root.t !== 'function') root.t = t;
  }

  // CommonJS export for node-based unit tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  // Auto-init in the browser only; tests drive the API explicitly.
  if (typeof root !== 'undefined' && root.document) {
    init();
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
