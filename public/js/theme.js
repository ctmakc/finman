// ==================== THEME RUNTIME ====================
// Dark / light / system theme toggle for FINMAN (additive, opt-in).
//
// The chosen *mode* is one of: 'light' | 'dark' | 'system'. The resolved
// *theme* (what actually paints) is always 'light' | 'dark'; in 'system'
// mode it follows the OS `prefers-color-scheme` media query.
//
// Persistence: the mode is stored in localStorage under THEME_KEY. The
// resolved theme is applied to <html> via the `data-theme` attribute, which
// public/css/style.css keys its dark overrides off of:
//   html[data-theme="dark"] { --background-color: ...; ... }
// 'system' mode intentionally leaves `data-theme` unset so the CSS
// `@media (prefers-color-scheme: dark)` block keeps working untouched.
//
// Public API (also on window.theme):
//   getMode()                 -> 'light' | 'dark' | 'system'
//   setMode(mode)             -> persists + applies; returns the mode
//   toggle()                  -> advance mode (system -> light -> dark -> ...)
//   resolveTheme(mode, sys)   -> pure: resolved 'light'|'dark'
//   nextTheme(mode)           -> pure: the next mode in the cycle
//   applyTheme(root?)         -> (re)apply the resolved theme to the DOM
//   getResolved()             -> currently resolved 'light'|'dark'
//   onChange(cb)              -> subscribe to mode changes; returns unsub
//   MODES                     -> ['system','light','dark']
//
// Everything is feature-detected so this file is safe to require() under node
// for unit tests (no window / localStorage / matchMedia required).

(function (root) {
  'use strict';

  var THEME_KEY = 'finman_theme';
  var DEFAULT_MODE = 'system';
  // Cycle order for the toggle button: system -> light -> dark -> system ...
  var MODES = ['system', 'light', 'dark'];

  var currentMode = DEFAULT_MODE;
  var listeners = [];
  var mqlBound = false;

  // ---- pure helpers (the unit-tested core) ----------------------------------

  // Is `mode` a recognized mode string?
  function isMode(mode) {
    return MODES.indexOf(mode) !== -1;
  }

  // Resolve a mode to the concrete theme that should paint.
  //   resolveTheme('dark')                 -> 'dark'
  //   resolveTheme('light')                -> 'light'
  //   resolveTheme('system', true)         -> 'dark'   (system prefers dark)
  //   resolveTheme('system', false)        -> 'light'
  //   resolveTheme('garbage')              -> 'light'  (safe default)
  // `systemPrefersDark` defaults to false so the helper is fully pure/offline.
  function resolveTheme(mode, systemPrefersDark) {
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    // 'system' (or anything unknown) follows the OS preference.
    return systemPrefersDark ? 'dark' : 'light';
  }

  // The next mode in the toggle cycle. Unknown input restarts the cycle.
  //   nextTheme('system') -> 'light'
  //   nextTheme('light')  -> 'dark'
  //   nextTheme('dark')   -> 'system'
  function nextTheme(mode) {
    var idx = MODES.indexOf(mode);
    if (idx === -1) return MODES[0];
    return MODES[(idx + 1) % MODES.length];
  }

  // ---- environment probes (guarded) -----------------------------------------

  function systemPrefersDark() {
    try {
      if (typeof root !== 'undefined' && typeof root.matchMedia === 'function') {
        return !!root.matchMedia('(prefers-color-scheme: dark)').matches;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function readStored() {
    try {
      if (typeof root !== 'undefined' && root.localStorage) {
        return root.localStorage.getItem(THEME_KEY);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeStored(mode) {
    try {
      if (typeof root !== 'undefined' && root.localStorage) {
        root.localStorage.setItem(THEME_KEY, mode);
      }
    } catch (e) { /* ignore */ }
  }

  // ---- DOM application (no-op outside the browser) ---------------------------

  // Apply the resolved theme to <html data-theme>. In 'system' mode we REMOVE
  // the attribute so the stylesheet's prefers-color-scheme media query keeps
  // governing the colors (no double source of truth).
  function applyTheme(rootEl) {
    if (typeof root === 'undefined' || !root.document) return getResolved();
    var el = (rootEl && rootEl.documentElement)
      ? rootEl.documentElement
      : root.document.documentElement;
    if (!el || !el.setAttribute) return getResolved();
    try {
      if (currentMode === 'system') {
        el.removeAttribute('data-theme');
      } else {
        el.setAttribute('data-theme', currentMode);
      }
      // Expose the chosen mode too, so a toggle button can reflect state.
      el.setAttribute('data-theme-mode', currentMode);
    } catch (e) { /* ignore */ }
    // Сообщаем подписчикам (например, charts.js), что палитра --fm-* сменилась,
    // чтобы они перечитали токены и перерисовались.
    try {
      if (typeof root !== 'undefined' && root.document &&
          typeof root.CustomEvent === 'function') {
        root.document.dispatchEvent(
          new root.CustomEvent('fm:themechange', { detail: { theme: getResolved() } })
        );
      }
    } catch (e) { /* ignore */ }
    return getResolved();
  }

  function getResolved() {
    return resolveTheme(currentMode, systemPrefersDark());
  }

  function getMode() {
    return currentMode;
  }

  // Keep `data-theme` correct while in 'system' mode and the OS flips themes.
  function bindSystemListener() {
    if (mqlBound) return;
    try {
      if (typeof root !== 'undefined' && typeof root.matchMedia === 'function') {
        var mql = root.matchMedia('(prefers-color-scheme: dark)');
        var handler = function () {
          if (currentMode === 'system') {
            applyTheme();
            notify();
          }
        };
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', handler);
          mqlBound = true;
        } else if (typeof mql.addListener === 'function') {
          // Older browsers.
          mql.addListener(handler);
          mqlBound = true;
        }
      }
    } catch (e) { /* ignore */ }
  }

  function setMode(mode) {
    if (!isMode(mode)) return currentMode;
    currentMode = mode;
    writeStored(mode);
    applyTheme();
    notify();
    return currentMode;
  }

  // Advance to the next mode in the cycle and apply it.
  function toggle() {
    return setMode(nextTheme(currentMode));
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
    var resolved = getResolved();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](currentMode, resolved); } catch (e) { /* ignore */ }
    }
  }

  // ---- bootstrap ------------------------------------------------------------
  function detectInitialMode() {
    var stored = readStored();
    if (stored && isMode(stored)) return stored;
    return DEFAULT_MODE;
  }

  function init() {
    currentMode = detectInitialMode();
    if (typeof root !== 'undefined' && root.document) {
      var apply = function () {
        applyTheme();
        bindSystemListener();
      };
      if (root.document.readyState === 'loading' && root.document.addEventListener) {
        // Apply ASAP to <html> (avoids a flash) but also re-run after DOM ready.
        applyTheme();
        root.document.addEventListener('DOMContentLoaded', apply);
      } else {
        apply();
      }
    }
  }

  var api = {
    getMode: getMode,
    setMode: setMode,
    toggle: toggle,
    applyTheme: applyTheme,
    getResolved: getResolved,
    onChange: onChange,
    MODES: MODES.slice(),
    DEFAULT_MODE: DEFAULT_MODE,
    // pure helpers exposed for tests / introspection
    resolveTheme: resolveTheme,
    nextTheme: nextTheme,
    _isMode: isMode,
    _systemPrefersDark: systemPrefersDark
  };

  if (typeof root !== 'undefined') {
    root.theme = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  // Auto-init in the browser only; node-based tests drive the API explicitly.
  if (typeof root !== 'undefined' && root.document) {
    init();
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
