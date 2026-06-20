// ==================== A11Y HELPERS ====================
// Small, dependency-free accessibility utilities for FINMAN.
// Opt-in: existing modules keep working; new UI can use these helpers.
//
// Public API (window.a11y):
//   trapFocus(container, opts) -> releaseFn   focus trap for dialogs/modals
//   announce(message, politeness)             SR announcements via aria-live
//   getFocusable(container) -> Element[]      visible focusable descendants
//   restoreFocusTo(el)                        helper to refocus an element
//
// trapFocus:
//   - moves focus into `container` (first focusable, or the container itself)
//   - cycles Tab / Shift+Tab within the container
//   - calls opts.onEscape(e) when Esc is pressed (if provided)
//   - returns a release function that removes the listener and (by default)
//     restores focus to whatever was focused before the trap engaged.

(function (root) {
  'use strict';

  var FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'audio[controls]',
    'video[controls]',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function isVisible(el) {
    if (!el) return false;
    // offsetParent is null for display:none (and fixed-position edge cases,
    // but that is acceptable for a focus trap heuristic).
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function getFocusable(container) {
    if (!container || !container.querySelectorAll) return [];
    var nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isVisible(nodes[i])) out.push(nodes[i]);
    }
    return out;
  }

  function restoreFocusTo(el) {
    if (el && typeof el.focus === 'function') {
      try { el.focus(); } catch (e) { /* ignore */ }
    }
  }

  function trapFocus(container, opts) {
    opts = opts || {};
    if (!container || !root.document) return function () {};

    var previouslyFocused = (root.document.activeElement) || null;

    function focusFirst() {
      var f = getFocusable(container);
      if (f.length) {
        f[0].focus();
      } else if (container.focus) {
        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        if (typeof opts.onEscape === 'function') opts.onEscape(e);
        return;
      }
      if (e.key !== 'Tab' && e.keyCode !== 9) return;

      var focusable = getFocusable(container);
      if (!focusable.length) {
        e.preventDefault();
        return;
      }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var active = root.document.activeElement;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    container.addEventListener('keydown', onKeydown);
    if (opts.autoFocus !== false) focusFirst();

    return function release() {
      container.removeEventListener('keydown', onKeydown);
      if (opts.restoreFocus !== false) restoreFocusTo(previouslyFocused);
    };
  }

  // Live region for screen-reader announcements. Reused across calls.
  var liveRegion = null;
  function ensureLiveRegion() {
    if (!root.document || !root.document.body) return null;
    if (liveRegion && root.document.body.contains(liveRegion)) return liveRegion;
    liveRegion = root.document.createElement('div');
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('aria-atomic', 'true');
    liveRegion.setAttribute('role', 'status');
    // Visually-hidden but available to assistive tech.
    liveRegion.style.position = 'absolute';
    liveRegion.style.width = '1px';
    liveRegion.style.height = '1px';
    liveRegion.style.margin = '-1px';
    liveRegion.style.border = '0';
    liveRegion.style.padding = '0';
    liveRegion.style.overflow = 'hidden';
    liveRegion.style.clip = 'rect(0 0 0 0)';
    liveRegion.style.clipPath = 'inset(50%)';
    liveRegion.style.whiteSpace = 'nowrap';
    root.document.body.appendChild(liveRegion);
    return liveRegion;
  }

  function announce(message, politeness) {
    var region = ensureLiveRegion();
    if (!region) return;
    region.setAttribute('aria-live', politeness === 'assertive' ? 'assertive' : 'polite');
    // Clear then set so repeated identical messages are still announced.
    region.textContent = '';
    var msg = message == null ? '' : String(message);
    if (root.requestAnimationFrame) {
      root.requestAnimationFrame(function () { region.textContent = msg; });
    } else {
      region.textContent = msg;
    }
  }

  var api = {
    trapFocus: trapFocus,
    announce: announce,
    getFocusable: getFocusable,
    restoreFocusTo: restoreFocusTo,
    FOCUSABLE_SELECTOR: FOCUSABLE_SELECTOR
  };

  if (typeof root !== 'undefined') root.a11y = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
