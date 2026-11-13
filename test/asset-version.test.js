// Versioned shell links: a release must never paint new markup with a cached
// old stylesheet (12.11.2026 sign-in screen in the old mint palette).
const fs = require('fs');
const path = require('path');
const av = require('../lib/assetVersion');

const PUB = path.join(__dirname, '..', 'public');

describe('asset versioning', () => {
  const shell = av.create(PUB);

  test('every /css, /js and /vendor link in index.html carries ?v=<hash>', () => {
    expect(shell.v).toMatch(/^[0-9a-f]{10}$/);
    const links = [...shell.html.matchAll(/(?:href|src)="(\/(?:css|js|vendor)\/[^"]+\.(?:css|js)[^"]*)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(20);
    for (const l of links) expect(l).toMatch(new RegExp(`\\?v=${shell.v}$`));
    expect(shell.html).toContain(`/css/fresh.css?v=${shell.v}`);
    expect(shell.html).toContain('href="/manifest.json"');
  });

  test('style.css @imports are versioned too', () => {
    const css = av.stampCss(fs.readFileSync(path.join(PUB, 'css', 'style.css'), 'utf8'), 'abc');
    const imports = [...css.matchAll(/@import\s+url\(([^)]+)\)/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(3);
    for (const i of imports) expect(i).toMatch(/\?v=abc["']?$/);
  });

  test('the hash follows file content', () => {
    expect(av.stampHtml('<link href="/css/a.css"><script src="/js/b.js"></script><img src="/img/c.png">', 'x1'))
      .toBe('<link href="/css/a.css?v=x1"><script src="/js/b.js?v=x1"></script><img src="/img/c.png">');
    expect(av.hashFiles(PUB)).toBe(shell.v);
  });

  test('service worker loads CSS/JS network-first with an offline fallback', () => {
    const sw = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
    expect(sw).toMatch(/async function codeNetworkFirst/);
    expect(sw).toMatch(/isCodeAsset\(url\)\)\s*\{\s*event\.respondWith\(codeNetworkFirst/);
    expect(sw).toMatch(/ignoreSearch: true/);
  });
});
