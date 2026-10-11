// test/fe-shell.test.js — app shell blockers (wave3/fe-shell).
//
// Covers CRITIQUE.md items 1, 3 (client side), 6 (app.js side), 10–14:
//   - /api/accounts {own, shared, all} is normalised to an array for consumers
//   - formatCurrency defaults to the user's base currency (never RUB)
//   - grouped navigation + routes for the six orphan modules
//   - no third-party CDNs: Chart.js + Font Awesome self-hosted under /vendor
//   - service worker precache + cache version bump
//   - viewport allows zoom; token contrast >= 4.5:1 in both themes
//   - toast CSS exists; English-first shell (lang="en", title/manifest "Finman")
//
// app.js is a classic browser script that also `module.exports` its pure
// helpers when required under node (DOM calls are guarded), so the pure parts
// are unit-tested directly. Everything served is checked through supertest.

const path = require('path');
const fs = require('fs');
const { makeApp } = require('./helpers/app');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');

// ---- WCAG helpers ----------------------------------------------------------
function luminance(hex) {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(c.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
// Extract the --fm-* declarations of the first block whose selector text
// starts with `selector` (handles nested @media blocks by brace counting).
// Supports modern single-source tokens via light-dark(#L, #D) and var() resolution.
function tokensOf(css, selector, mode) {
  const effectiveMode = mode || (selector.includes('dark') ? 'dark' : 'light');
  let block;
  const start = css.indexOf(selector);
  if (start !== -1) {
    const open = css.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    block = css.slice(open + 1, end);
  }

  // Also read the :root block for light-dark() and alias resolution
  const rootStart = css.indexOf(':root {');
  let rootBlock = '';
  if (rootStart !== -1) {
    const rootOpen = css.indexOf('{', rootStart);
    let depth = 0;
    let end = rootOpen;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    rootBlock = css.slice(rootOpen + 1, end);
  }

  const raw = {};
  (rootBlock + '\n' + (block || '')).replace(/(--[\w-]+)\s*:\s*([^;]+);/g, (m, k, v) => {
    raw[k] = v.trim();
    return m;
  });

  const resolved = {};
  for (const k of Object.keys(raw)) {
    let val = raw[k];
    let guard = 0;
    while (val && val.startsWith('var(') && guard++ < 5) {
      const ref = val.replace(/^var\((--[\w-]+)\)$/, '$1');
      val = raw[ref] || val;
    }
    const ld = val ? val.match(/light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\)/) : null;
    if (ld) {
      resolved[k] = effectiveMode === 'dark' ? ld[2] : ld[1];
    } else {
      resolved[k] = val;
    }
  }
  return resolved;
}

// ---- app.js pure helpers -----------------------------------------------------
describe('app.js shell helpers (node)', () => {
  let app;
  beforeAll(() => {
    app = require(path.join(PUBLIC, 'js', 'app.js'));
  });

  test('normalizeAccounts accepts {own, shared, all} and plain arrays', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    expect(app.normalizeAccounts({ own: [a], shared: [b], all: [a, b] })).toEqual([a, b]);
    expect(app.normalizeAccounts({ own: [a], shared: [] })).toEqual([a]);
    expect(app.normalizeAccounts([a])).toEqual([a]);
    expect(app.normalizeAccounts(null)).toEqual([]);
    expect(app.normalizeAccounts(undefined)).toEqual([]);
  });

  test('formatCurrency defaults to the base currency (CAD), never RUB', () => {
    app.appState.baseCurrency = 'CAD';
    const s = app.formatCurrency(1234.5);
    expect(s).toMatch(/1,234\.50/);
    expect(s).toMatch(/\$/);
    expect(s).not.toMatch(/RUB|₽/);
  });

  test('formatCurrency follows appState.baseCurrency and explicit codes', () => {
    app.appState.baseCurrency = 'EUR';
    expect(app.formatCurrency(2)).toMatch(/€/);
    expect(app.formatCurrency(5, 'UAH')).toMatch(/UAH|₴/);
    expect(app.formatCurrency(5, 'usd')).toMatch(/\$/);
    app.appState.baseCurrency = 'CAD';
  });

  test('formatCurrency never throws on bad input', () => {
    expect(app.formatCurrency(1, 'NOT-A-CODE')).toMatch(/1\.00/);
    expect(app.formatCurrency(NaN)).toMatch(/0\.00/);
    expect(app.formatCurrency('12.5')).toMatch(/12\.50/);
  });

  test('currencySymbol returns a symbol or the code', () => {
    expect(['$', 'CA$']).toContain(app.currencySymbol('CAD'));
    expect(app.currencySymbol('EUR')).toBe('€');
    expect(app.currencySymbol('XXXZ')).toBe('XXXZ');
  });

  test('resolvePageFromPath maps URLs to known pages, unknown -> dashboard', () => {
    expect(app.resolvePageFromPath('/')).toBe('dashboard');
    expect(app.resolvePageFromPath('')).toBe('dashboard');
    expect(app.resolvePageFromPath('/transactions')).toBe('transactions');
    expect(app.resolvePageFromPath('/transactions?page=2')).toBe('transactions');
    expect(app.resolvePageFromPath('/rules')).toBe('rules');
    expect(app.resolvePageFromPath('/api-tokens')).toBe('api-tokens');
    expect(app.resolvePageFromPath('/nope')).toBe('dashboard');
  });

  test('grouped navigation: primary + Plan/Wealth/Tools, every item routable', () => {
    expect(app.NAV_PRIMARY.map((i) => i.page)).toEqual([
      'dashboard', 'transactions', 'accounts', 'budgets', 'ai',
    ]);
    expect(app.NAV_GROUPS.map((g) => g.title)).toEqual(['Plan', 'Wealth', 'Tools']);
    const all = [...app.NAV_PRIMARY, ...app.NAV_GROUPS.flatMap((g) => g.items)];
    for (const item of all) {
      expect(typeof app.PAGE_RENDERERS[item.page]).toBe('function');
      expect(item.label).toMatch(/^[A-Za-z0-9 ]+$/);
    }
    // the six wave-2 orphans now have routes
    for (const page of ['rules', 'reconcile', 'billing', 'api-tokens', 'data-export', 'onboarding']) {
      expect(typeof app.PAGE_RENDERERS[page]).toBe('function');
    }
    // single, unique destinations
    const pages = all.map((i) => i.page);
    expect(new Set(pages).size).toBe(pages.length);
  });

  test('app.js globals are not redeclared by the feature modules (shadowing)', () => {
    // All files are classic scripts sharing one global scope: a later
    // `function x()` silently replaces app.js's x. (Regression: currency.js
    // shadowed fetchCurrencySettings, so the base currency never applied and
    // a failed /api/currency/settings left the app on the spinner.)
    const names = [...read('js/app.js').matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const dir = path.join(PUBLIC, 'js');
    const modules = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'app.js');
    const known = { formatCurrency: ['recurring.js', 'family.js'] }; // fe-logic removes these
    const clashes = [];
    for (const file of modules) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const n of names) {
        if (new RegExp('^(?:async )?function ' + n + '\\b', 'm').test(src) && !(known[n] || []).includes(file)) {
          clashes.push(`${n} in ${file}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  test('app.js own strings are English and no RUB default remains', () => {
    const src = read('js/app.js');
    expect(/[Ѐ-ӿ]/.test(src)).toBe(false);
    expect(src).not.toMatch(/'RUB'/);
    expect(src).toMatch(/data\.all/);
  });
});

// ---- static shell files --------------------------------------------------------
describe('index.html / manifest / sw', () => {
  const html = read('index.html');

  test('English-first shell: lang, title, no zoom lock', () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<title>Finman<\/title>/);
    const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no/);
    expect(viewport).not.toMatch(/maximum-scale/);
  });

  test('no third-party CDN or Google Fonts references', () => {
    const external = html.match(/(?:href|src)="https?:\/\/[^"]+"/g) || [];
    expect(external).toEqual([]);
    expect(html).not.toMatch(/fonts\.googleapis\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/);
  });

  test('vendored Chart.js + Font Awesome + locales + i18n are wired in order', () => {
    expect(html).toMatch(/<script src="\/vendor\/chart\.min\.js">/);
    expect(html).toMatch(/<link rel="stylesheet" href="\/vendor\/fa\.min\.css">/);
    const order = ['/js/locales/en.js', '/js/i18n.js', '/js/theme.js', '/js/app.js', '/js/rules.js'];
    const idx = order.map((s) => html.indexOf(s));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test('fa.min.css points at the vendored webfonts directory', () => {
    const css = read('vendor/fa.min.css');
    expect(css).not.toMatch(/\.\.\/webfonts/);
    expect(css).toMatch(/url\(webfonts\/fa-solid-900\.woff2\)/);
    for (const f of ['fa-solid-900.woff2', 'fa-regular-400.woff2', 'fa-brands-400.woff2']) {
      expect(fs.existsSync(path.join(PUBLIC, 'vendor', 'webfonts', f))).toBe(true);
    }
  });

  test('manifest is English and named Finman', () => {
    const manifest = JSON.parse(read('manifest.json'));
    expect(manifest.name).toBe('Finman');
    expect(manifest.short_name).toBe('Finman');
    expect(manifest.lang).toBe('en');
    expect(/[Ѐ-ӿ]/.test(manifest.description)).toBe(false);
  });

  test('service worker: cache version bumped and vendor files precached', () => {
    const sw = read('sw.js');
    const version = sw.match(/const CACHE_VERSION = '([^']+)'/)[1];
    expect(version).not.toBe('finman-v2');
    expect(version).not.toBe('finman-v1');
    const list = sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1];
    for (const asset of [
      '/vendor/chart.min.js', '/vendor/fa.min.css', '/vendor/webfonts/fa-solid-900.woff2',
      '/js/i18n.js', '/js/theme.js', '/js/locales/en.js', '/js/rules.js', '/js/reconcile.js',
      '/js/api-tokens.js', '/js/data-export.js', '/js/billing.js', '/js/onboarding.js',
      '/css/parts/dashboard.css',
    ]) {
      expect(list).toContain(`'${asset}'`);
    }
    expect(sw).not.toMatch(/cdn\.jsdelivr|cdnjs/);
  });
});

describe('style.css tokens and shell CSS', () => {
  const css = read('css/style.css');

  test('toast, drawer and font tokens exist', () => {
    expect(css).toMatch(/\.notification\b/);
    expect(css).toMatch(/\.toast\b/);
    expect(css).toMatch(/\.fm-drawer\b/);
    expect(css).toMatch(/--fm-font-num\s*:/);
    expect(css).toMatch(/--fm-font-ui\s*:/);
    expect(css).not.toMatch(/Space Grotesk|'Inter'/);
    expect(css).toMatch(/tabular-nums/);
  });

  test.each([
    ['light :root', ':root {'],
    ['light explicit', 'html[data-theme="light"]'],
  ])('%s: ink-3 / warning / positive / negative >= 4.5:1 on surface & surface-2', (_n, sel) => {
    const t = tokensOf(css, sel);
    for (const key of ['--fm-ink-3', '--fm-warning', '--fm-positive', '--fm-negative']) {
      expect(contrast(t[key], t['--fm-surface'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t[key], t['--fm-surface-2'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.each([
    ['dark media', '@media (prefers-color-scheme: dark)'],
    ['dark explicit', 'html[data-theme="dark"]'],
  ])('%s: ink-3 / warning / positive / negative >= 4.5:1 on surface & surface-2', (_n, sel) => {
    const t = tokensOf(css, sel);
    for (const key of ['--fm-ink-3', '--fm-warning', '--fm-positive', '--fm-negative']) {
      expect(contrast(t[key], t['--fm-surface'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t[key], t['--fm-surface-2'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('visible focus ring kept', () => {
    expect(css).toMatch(/:focus-visible\s*[,{][\s\S]*?outline:\s*2px solid/);
  });
});

// ---- served over HTTP -------------------------------------------------------------
describe('shell assets over HTTP', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
  });
  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET / serves the English shell', async () => {
    const res = await ctx.request.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<html lang="en">/);
  });

  test.each([
    ['/vendor/chart.min.js', /javascript/],
    ['/vendor/fa.min.css', /text\/css/],
    ['/vendor/webfonts/fa-solid-900.woff2', /font\/woff2|application\/font-woff2|application\/octet-stream/],
    ['/js/locales/en.js', /javascript/],
    ['/manifest.json', /json/],
  ])('GET %s -> 200', async (url, type) => {
    const res = await ctx.request.get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(type);
  });

  test('GET /api/accounts shape is {own, shared, all} (what app.js normalises)', async () => {
    const res = await ctx.request.get('/api/accounts').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.all)).toBe(true);
    expect(Array.isArray(res.body.own)).toBe(true);
  });

  test('GET /api/currency/settings exposes base_currency for formatCurrency', async () => {
    const res = await ctx.request.get('/api/currency/settings').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.base_currency).toBe('string');
  });
});
