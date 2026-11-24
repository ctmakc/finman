// test/e2e/nav-same-page.cjs — a tap on the page that is already open does not rebuild it.
//
//   BASE=http://127.0.0.1:3498 node test/e2e/nav-same-page.cjs
//
// User #41 (17.11) tapped Home 9 times in 6 s; each tap rebuilt Home (6 API calls) and logged one
// more checklist_shown. Now: 8 taps on Home (rail at 1440, tab bar at 390, the logo) while on Home →
// Home's panels are not painted again and none of Home's data calls go out (accounts, transactions,
// journey, onboarding state, overview; the delayed survey check may still run); Home → Transactions → Home paints once.
'use strict';
const { chromium } = require('playwright');

const BASE = process.env.BASE;
const PW = 'NavSamePage-1124-pass';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function answerPrompts(page, until) {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (await page.locator(until).count()) return;
    if (await page.locator('#fmv-rktext').count()) { await page.check('#fmv-saved'); await page.click('.fmv-go'); }
    else if (await page.locator('.fmv-pw-new').count()) await page.click('.fmv-pw-new');
    else if (await page.locator('#fmv-secret2').count()) { await page.fill('#fmv-secret', PW); await page.fill('#fmv-secret2', PW); await page.click('.fmv-form button[type=submit]'); }
    else if (await page.locator('#fmv-secret').count() && await page.locator('#fmv-secret').isVisible()) { await page.fill('#fmv-secret', PW); await page.click('.fmv-form button[type=submit]'); }
    await page.waitForTimeout(400);
  }
  throw new Error('app did not open');
}

async function run(browser, w) {
  const mobile = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__api = 0; window.__apiUrls = [];
    const f = window.fetch;
    window.fetch = function (u) { if (/\/api\/(accounts|transactions|engagement\/journey|onboarding\/state|analytics\/overview)/.test(String(u))) { window.__api += 1; window.__apiUrls.push(String(u).replace(location.origin, '').split('?')[0]); } return f.apply(this, arguments); };
  });
  await page.goto(BASE + '/?fm_qa=1');
  await page.click('.auth-tab[data-tab="register"]');
  await page.fill('#register-email', `nav-${w}-${Date.now()}@finman-smoke.test`);
  await page.fill('#register-password', PW);
  await page.click('#register-form button[type=submit]');
  await answerPrompts(page, '#main-content h1');
  await page.evaluate(() => navigateTo('dashboard'));
  await page.waitForTimeout(2500);
  // Count Home paints: Engage.afterDashboard runs once per rebuilt Home.
  await page.evaluate(() => {
    window.__paints = 0;
    const orig = window.Engage.afterDashboard;
    window.Engage.afterDashboard = function () { window.__paints += 1; return orig.apply(this, arguments); };
    window.__api = 0; window.__apiUrls = [];
  });
  const home = mobile ? '.sd-tabbar [data-page="dashboard"]' : '.sd-rail [data-page="dashboard"]';
  for (let i = 0; i < 8; i++) { await page.click(home); await page.waitForTimeout(120); }
  await page.click('#logo-link').catch(() => {}); // the logo may be hidden inside the shell
  await page.waitForTimeout(1500);
  const same = await page.evaluate(() => ({ paints: window.__paints, api: window.__api, urls: window.__apiUrls.slice(), page: appState.currentPage }));
  if (same.urls.length) log(w + ' api during taps:', same.urls.join(', '));
  const other = mobile ? '.sd-tabbar [data-page="transactions"]' : '.sd-rail [data-page="transactions"]';
  await page.click(other);
  await page.waitForTimeout(1500);
  await page.click(home);
  await page.waitForTimeout(2500);
  const back = await page.evaluate(() => ({ paints: window.__paints, page: appState.currentPage }));
  await ctx.close();
  const ok = same.paints === 0 && same.api === 0 && same.page === 'dashboard' && back.paints === 1 && back.page === 'dashboard' && !errors.length;
  log(`${w}: 8 taps on open Home → paints ${same.paints}, api ${same.api}; Transactions → Home → paints ${back.paints}; errors ${errors.length} → ${ok ? 'PASS' : 'FAIL'}`);
  if (errors.length) log(errors.slice(0, 3));
  return ok;
}

(async () => {
  const browser = await chromium.launch();
  let ok = true;
  for (const w of [1440, 390]) ok = (await run(browser, w)) && ok;
  await browser.close();
  log(ok ? 'ALL PASS' : 'FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
