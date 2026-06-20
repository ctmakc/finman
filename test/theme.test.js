// test/theme.test.js — unit tests for the wave-2 theme runtime pure helpers
// (public/js/theme.js) and for the expanded locale dictionaries
// (public/js/locales/{en,uk,ru}.js).
//
// theme.js is a browser script that also `module.exports` its API when run
// under node, and feature-detects window/document/localStorage/matchMedia so
// it imports cleanly here with no DOM. We exercise the settlement-free
// resolveTheme()/nextTheme() helpers directly. No network/LLM/timers touched.

const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public', 'js');

const theme = require(path.join(PUBLIC, 'theme.js'));

const enDict = require(path.join(PUBLIC, 'locales', 'en.js'));
const ukDict = require(path.join(PUBLIC, 'locales', 'uk.js'));
const ruDict = require(path.join(PUBLIC, 'locales', 'ru.js'));

describe('theme.resolveTheme()', () => {
  test('explicit modes resolve to themselves regardless of system pref', () => {
    expect(theme.resolveTheme('dark', false)).toBe('dark');
    expect(theme.resolveTheme('dark', true)).toBe('dark');
    expect(theme.resolveTheme('light', false)).toBe('light');
    expect(theme.resolveTheme('light', true)).toBe('light');
  });

  test('system mode follows the OS preference flag', () => {
    expect(theme.resolveTheme('system', true)).toBe('dark');
    expect(theme.resolveTheme('system', false)).toBe('light');
  });

  test('system mode defaults to light when pref omitted (pure/offline)', () => {
    expect(theme.resolveTheme('system')).toBe('light');
  });

  test('unknown / garbage modes fall back to the OS preference (default light)', () => {
    expect(theme.resolveTheme('nonsense')).toBe('light');
    expect(theme.resolveTheme('nonsense', true)).toBe('dark');
    expect(theme.resolveTheme(undefined)).toBe('light');
    expect(theme.resolveTheme(null, true)).toBe('dark');
  });

  test('always returns one of the two concrete themes', () => {
    ['light', 'dark', 'system', 'garbage', '', null, undefined].forEach((m) => {
      [true, false].forEach((sys) => {
        expect(['light', 'dark']).toContain(theme.resolveTheme(m, sys));
      });
    });
  });
});

describe('theme.nextTheme()', () => {
  test('cycles system -> light -> dark -> system', () => {
    expect(theme.nextTheme('system')).toBe('light');
    expect(theme.nextTheme('light')).toBe('dark');
    expect(theme.nextTheme('dark')).toBe('system');
  });

  test('unknown input restarts the cycle at the first mode', () => {
    expect(theme.nextTheme('garbage')).toBe('system');
    expect(theme.nextTheme(undefined)).toBe('system');
    expect(theme.nextTheme(null)).toBe('system');
  });

  test('three advances return to the starting mode (full loop)', () => {
    let m = 'system';
    m = theme.nextTheme(m);
    m = theme.nextTheme(m);
    m = theme.nextTheme(m);
    expect(m).toBe('system');
  });

  test('every produced mode is a recognized mode', () => {
    let m = 'system';
    for (let i = 0; i < 6; i++) {
      m = theme.nextTheme(m);
      expect(theme.MODES).toContain(m);
    }
  });
});

describe('theme API surface', () => {
  test('exposes the expected functions and constants', () => {
    ['getMode', 'setMode', 'toggle', 'applyTheme', 'getResolved', 'onChange',
      'resolveTheme', 'nextTheme'].forEach((fn) => {
      expect(typeof theme[fn]).toBe('function');
    });
    expect(Array.isArray(theme.MODES)).toBe(true);
    expect(theme.MODES).toEqual(['system', 'light', 'dark']);
    expect(theme.DEFAULT_MODE).toBe('system');
  });

  test('MODES is a defensive copy (mutating it does not affect the cycle)', () => {
    const modes = theme.MODES;
    modes.push('hacked');
    expect(theme.nextTheme('dark')).toBe('system'); // unaffected
  });

  test('setMode rejects unknown modes and keeps the current mode', () => {
    const before = theme.setMode('light');
    expect(before).toBe('light');
    const after = theme.setMode('not-a-mode');
    expect(after).toBe('light');
    expect(theme.getMode()).toBe('light');
  });

  test('setMode applies each valid mode and getMode reflects it', () => {
    expect(theme.setMode('dark')).toBe('dark');
    expect(theme.getMode()).toBe('dark');
    expect(theme.setMode('system')).toBe('system');
    expect(theme.getMode()).toBe('system');
  });

  test('toggle advances the mode through the full cycle', () => {
    theme.setMode('system');
    expect(theme.toggle()).toBe('light');
    expect(theme.toggle()).toBe('dark');
    expect(theme.toggle()).toBe('system');
  });

  test('getResolved returns a concrete theme for the current mode', () => {
    theme.setMode('dark');
    expect(theme.getResolved()).toBe('dark');
    theme.setMode('light');
    expect(theme.getResolved()).toBe('light');
  });

  test('onChange subscribers fire on mode change and can unsubscribe', () => {
    const seen = [];
    const unsub = theme.onChange((mode) => seen.push(mode));
    theme.setMode('dark');
    theme.setMode('light');
    expect(seen).toEqual(['dark', 'light']);
    unsub();
    theme.setMode('system');
    expect(seen).toEqual(['dark', 'light']); // no new entries after unsubscribe
  });

  test('applyTheme is a safe no-op without a DOM (returns a concrete theme)', () => {
    theme.setMode('dark');
    expect(['light', 'dark']).toContain(theme.applyTheme());
  });
});

describe('expanded locale dictionaries (wave-2)', () => {
  test('all three locales registered on globalThis.FINMAN_LOCALES', () => {
    expect(globalThis.FINMAN_LOCALES).toBeDefined();
    expect(globalThis.FINMAN_LOCALES.en).toBe(enDict);
    expect(globalThis.FINMAN_LOCALES.uk).toBe(ukDict);
    expect(globalThis.FINMAN_LOCALES.ru).toBe(ruDict);
  });

  test('all three share the EXACT same key set (no gaps after expansion)', () => {
    const en = Object.keys(enDict).sort();
    const uk = Object.keys(ukDict).sort();
    const ru = Object.keys(ruDict).sort();
    expect(uk).toEqual(en);
    expect(ru).toEqual(en);
  });

  test('expansion meaningfully grew coverage (>= 150 keys each)', () => {
    expect(Object.keys(enDict).length).toBeGreaterThanOrEqual(150);
    expect(Object.keys(ukDict).length).toBeGreaterThanOrEqual(150);
    expect(Object.keys(ruDict).length).toBeGreaterThanOrEqual(150);
  });

  test('covers each new wave-2 UI domain (theme/onboarding/ai/reports/export/widgets)', () => {
    const domains = ['theme.', 'onboarding.', 'ai.', 'reports.', 'export.', 'import.', 'widget'];
    [enDict, ukDict, ruDict].forEach((dict) => {
      const keys = Object.keys(dict);
      domains.forEach((prefix) => {
        expect(keys.some((k) => k.startsWith(prefix))).toBe(true);
      });
    });
  });

  test('no value is empty and every key is a flat dotted string', () => {
    [enDict, ukDict, ruDict].forEach((dict) => {
      Object.keys(dict).forEach((k) => {
        expect(k).toMatch(/^[\w.$-]+$/);
        expect(typeof dict[k]).toBe('string');
        expect(dict[k].length).toBeGreaterThan(0);
      });
    });
  });

  test('interpolation placeholders are consistent across languages', () => {
    // For each key, the set of {placeholders} must match between en/uk/ru so a
    // translated string can never drop or invent a variable.
    const placeholders = (s) => {
      const out = [];
      const re = /\{\{?\s*([\w.$-]+)\s*\}?\}/g;
      let m;
      while ((m = re.exec(s)) !== null) out.push(m[1]);
      return out.sort();
    };
    Object.keys(enDict).forEach((k) => {
      const pe = placeholders(enDict[k]);
      expect(placeholders(ukDict[k])).toEqual(pe);
      expect(placeholders(ruDict[k])).toEqual(pe);
    });
  });

  test('spot-check a few representative translations', () => {
    expect(enDict['theme.dark']).toBe('Dark');
    expect(ukDict['theme.dark']).toBe('Темна');
    expect(ruDict['theme.dark']).toBe('Тёмная');
    expect(enDict['onboarding.step']).toContain('{current}');
    expect(enDict['onboarding.step']).toContain('{total}');
    expect(enDict['import.success']).toContain('{count}');
    expect(ukDict['import.success']).toContain('{count}');
    expect(ruDict['import.success']).toContain('{count}');
  });
});
