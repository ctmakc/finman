// test/native-web.test.js — web side of the iOS / Android app shell.
//
// The Capacitor shell loads the live site, so the website itself has to
// recognise the app and stay unchanged everywhere else:
//   - index.html: viewport-fit=cover, early detection script, native.css/js wired;
//   - the early script tags <html> from the "FinmanApp" user agent and the
//     ?native= preview, and leaves a normal browser alone;
//   - native.js is a no-op on the website (no globals, no patched APIs);
//   - app-return.html sends the browser back to money.finman.app://auth-done;
//   - the service worker precaches the new assets;
//   - Settings carries the Danger zone wired to DELETE /api/auth/me.

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');

function earlyScript() {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const s = scripts.find((x) => x.includes('FinmanApp'));
  if (!s) throw new Error('early native detection script not found');
  return s;
}

function fakeStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m
  };
}

function runEarly({ ua = 'Mozilla/5.0 (Macintosh)', search = '', storage, capacitor } = {}) {
  const classes = new Set();
  const window = {};
  if (capacitor) window.Capacitor = capacitor;
  const ctx = {
    window,
    navigator: { userAgent: ua },
    location: { search },
    localStorage: storage || fakeStorage(),
    URLSearchParams,
    document: { documentElement: { classList: { add: (...c) => c.forEach((x) => classes.add(x)) } } }
  };
  vm.runInNewContext(earlyScript(), ctx);
  return { classes, FM_NATIVE: window.FM_NATIVE };
}

describe('index.html native wiring', () => {
  const html = read('index.html');

  test('viewport covers the notch area and still allows zoom', () => {
    const vp = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
    expect(vp).toContain('viewport-fit=cover');
    expect(vp).not.toMatch(/user-scalable=no|maximum-scale/);
  });

  test('native.css loads after fresh.css and native.js after billing.js', () => {
    expect(html.indexOf('/css/native.css')).toBeGreaterThan(html.indexOf('/css/fresh.css'));
    expect(html.indexOf('/js/native.js')).toBeGreaterThan(html.indexOf('/js/billing.js'));
  });

  test('early script runs before any stylesheet so the first paint is right', () => {
    const at = html.indexOf('FinmanApp');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });
});

describe('early detection script', () => {
  test('a normal browser stays untouched', () => {
    const r = runEarly({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
    expect(r.classes.size).toBe(0);
    expect(r.FM_NATIVE).toBeUndefined();
  });

  test('iOS shell user agent', () => {
    const r = runEarly({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 FinmanApp/1.0' });
    expect([...r.classes]).toEqual(['is-native', 'platform-ios']);
    expect(r.FM_NATIVE).toEqual({ platform: 'ios', debug: false });
  });

  test('Android shell user agent', () => {
    const r = runEarly({ ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131 Mobile FinmanApp/1.0' });
    expect([...r.classes]).toEqual(['is-native', 'platform-android']);
    expect(r.FM_NATIVE.debug).toBe(false);
  });

  test('Capacitor bridge counts as native too', () => {
    const r = runEarly({ capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } });
    expect(r.FM_NATIVE).toEqual({ platform: 'android', debug: false });
  });

  test('?native=ios turns the desktop preview on, ?native=off turns it off', () => {
    const storage = fakeStorage();
    const on = runEarly({ search: '?native=ios', storage });
    expect(on.FM_NATIVE).toEqual({ platform: 'ios', debug: true });
    const again = runEarly({ storage });
    expect(again.FM_NATIVE).toEqual({ platform: 'ios', debug: true });
    const off = runEarly({ search: '?native=off', storage });
    expect(off.FM_NATIVE).toBeUndefined();
    expect(storage._m.size).toBe(0);
  });
});

describe('native.js on the website', () => {
  test('does nothing without the shell', () => {
    const createObjectURL = () => 'blob:x';
    const open = () => null;
    const anchorClick = function () {};
    const window = { open, addEventListener: () => { throw new Error('listener added'); } };
    window.window = window;
    const ctx = {
      window,
      document: {
        documentElement: { classList: { add: () => { throw new Error('class added'); } } },
        addEventListener: () => { throw new Error('listener added'); }
      },
      URL: { createObjectURL },
      HTMLAnchorElement: { prototype: { click: anchorClick } },
      localStorage: fakeStorage()
    };
    vm.runInNewContext(read('js/native.js'), ctx);
    expect(window.FinmanNative).toBeUndefined();
    expect(ctx.URL.createObjectURL).toBe(createObjectURL);
    expect(ctx.HTMLAnchorElement.prototype.click).toBe(anchorClick);
    expect(window.open).toBe(open);
  });

  test('plugins go through registerPlugin only and nothing is logged', () => {
    const src = read('js/native.js');
    expect(src).toContain('window.Capacitor && window.Capacitor.registerPlugin ? window.Capacitor.registerPlugin(n) : null');
    expect(src).not.toMatch(/console\.(log|info|debug)\(/);
  });
});

describe('app-return.html', () => {
  const html = read('app-return.html');

  test('links back to the app scheme and is kept out of search', () => {
    expect(html).toContain('href="money.finman.app://auth-done"');
    expect(html).toContain('name="robots" content="noindex"');
  });

  test('error codes are whitelisted by pattern before use', () => {
    expect(html).toContain('/^[a-z_]{1,40}$/');
    expect(html).toContain("'?error=' + encodeURIComponent(reason)");
    expect(html).not.toMatch(/src="https?:\/\//);
  });
});

describe('service worker', () => {
  test('precaches the native assets', () => {
    const sw = read('sw.js');
    expect(sw).toContain("'/css/native.css'");
    expect(sw).toContain("'/js/native.js'");
  });
});

describe('Settings danger zone', () => {
  const app = read('js/app.js');

  test('card, modal and DELETE call are wired', () => {
    expect(app).toContain('fm-danger-zone');
    expect(app).toContain("fetchWithAuth('/api/auth/me', { method: 'DELETE'");
    expect(app).toContain("confirm.trim() !== 'DELETE'");
    expect(app).toContain('function renderAccountDeleted');
  });

  test('copy exists in every locale', () => {
    for (const lang of ['en', 'uk', 'ru']) {
      const src = read(`js/locales/${lang}.js`);
      for (const key of ['account.danger.title', 'account.delete.confirm', 'account.deleted.title']) {
        expect(src).toContain(`'${key}'`);
      }
    }
  });
});
