// test/e2e/vault-sync-race.cjs — Finman Vault: no local change may be lost around an upload.
//   BASE=http://127.0.0.1:PORT node test/e2e/vault-sync-race.cjs
// A: the server accepts the PUT, the page is closed before it hears back, a second change
//    was made while the PUT was in flight → after reopening both changes are there.
// B: a second change is made while the PUT is in flight, the PUT answers, the page closes
//    before the next upload → after reopening both changes are there.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE;
const PW = 'Race-Vault-1121!';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function open(dir, warnings) {
  const ctx = await chromium.launchPersistentContext(dir, { serviceWorkers: 'block' });
  const p = ctx.pages()[0] || await ctx.newPage();
  p.on('console', (m) => { if (/replaced unsent local changes/.test(m.text())) warnings.push(m.text()); });
  return { ctx, p };
}
const tx = (p, d) => p.evaluate(async (d) => {
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
  const r = await fetch('/api/transactions', { method: 'POST', headers: h, body: JSON.stringify({ accountId: 1, amount: 3.21, type: 'expense', description: d, category: 'Food', date: '2026-11-21' }) });
  return r.status;
}, d);
const descs = (p) => p.evaluate(async () => {
  const r = await fetch('/api/transactions?limit=500', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
  const j = await r.json(); const list = j.transactions || j.data || j;
  return (Array.isArray(list) ? list : []).map((t) => t.description);
});

async function scenario(name, email, holdResponse) {
  const dir = `/fast/claude-tmp/fm-race-${name}`; fs.rmSync(dir, { recursive: true, force: true });
  const warnings = [];
  let { ctx, p } = await open(dir, warnings);
  await p.goto(BASE + '/'); await p.waitForTimeout(800);
  await p.click('.auth-tab[data-tab="register"]');
  await p.fill('#register-email', email); await p.fill('#register-password', PW);
  await p.click('#register-form button[type=submit]');
  await p.waitForSelector('#fmv-rktext', { timeout: 90000 }); await p.check('#fmv-saved'); await p.click('.fmv-go');
  await p.waitForSelector('#main-content', { timeout: 60000 }); await p.waitForTimeout(1500);
  await p.evaluate(async () => { const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
    await fetch('/api/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Race', currency: 'CAD', balance: 100 }) }); });
  await p.evaluate(() => window.FMVault.syncNow()); await p.waitForTimeout(1000);

  let landed; const putLanded = new Promise((r) => { landed = r; });
  let releasePut; const hold = new Promise((r) => { releasePut = r; });
  let first = true;
  await p.route('**/api/vault/blob', async (route) => {
    if (route.request().method() !== 'PUT' || !first) return route.continue();
    first = false;
    log(name, 'PUT intercepted');
    const resp = await route.fetch();          // the server stores the new version
    log(name, 'PUT stored by server', resp.status());
    landed();
    if (holdResponse) { await hold; return; }  // A: the page never hears back
    await new Promise((r) => setTimeout(r, 1500));
    return route.fulfill({ response: resp });  // B: late answer
  });
  log(name, 'tx1', await tx(p, `${name}-one`));
  await p.evaluate(() => { window.FMVault.syncNow().catch(() => {}); });   // fire and forget: the PUT goes out
  await putLanded;
  log(name, 'tx2 (PUT in flight)', await tx(p, `${name}-two`));
  await p.waitForTimeout(holdResponse ? 400 : 1700);   // B: PUT answered, next upload not done yet
  await ctx.close();
  releasePut && releasePut();

  ({ ctx, p } = await open(dir, warnings));
  await p.goto(BASE + '/'); await p.waitForSelector('#main-content', { timeout: 60000 }); await p.waitForTimeout(4000);
  const got = await descs(p);
  await p.evaluate(() => window.FMVault.syncNow()); await p.waitForTimeout(1000);
  await ctx.close();
  // the server copy must have both too: open on a fresh device (password unlock)
  const fresh = await chromium.launch(); const q = await fresh.newPage();
  await q.goto(BASE + '/'); await q.waitForTimeout(800);
  await q.click('.auth-tab[data-tab="login"]').catch(() => {});
  await q.fill('#login-username', email); await q.fill('#login-password', PW);
  await q.click('#login-form button[type=submit]'); await q.waitForSelector('#main-content', { timeout: 60000 }); await q.waitForTimeout(3000);
  const server = await descs(q); await fresh.close();
  const ok = ['one', 'two'].every((k) => got.includes(`${name}-${k}`) && server.includes(`${name}-${k}`));
  log(name, ok ? 'PASS' : 'FAIL', 'local:', got.filter((d) => d && d.startsWith(name)).join(','), '| server:', server.filter((d) => d && d.startsWith(name)).join(','), '| warnings:', warnings.length);
  return ok;
}

(async () => {
  const stamp = Date.now() % 100000;
  const a = await scenario('A', `race-a-${stamp}@finman.test`, true);
  const b = await scenario('B', `race-b-${stamp}@finman.test`, false);
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(2); });
