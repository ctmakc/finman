// test/e2e/vault-quiet.cjs — quiet vault start (owner 23.11: «для первого входа мне нужно просто залогиниться»).
//
//   BASE=http://127.0.0.1:PORT DB=/path/stand.db JWT_SECRET=… node test/e2e/vault-quiet.cjs
//
// 1. Google user, new: no vault screen at all → app opens, data written, protectionPending = password + recovery.
// 2. Second device (fresh browser): cannot open yet, the prompt says where to protect.
// 3. Device 1: FMVault.protect() → vault password + recovery key → pending cleared.
// 4. Second device: the vault password opens it, the data is there.
// 5. Password sign-up: no recovery-key screen; another browser opens with the login password.
// 6. Google user with readable (legacy) data: moved into the vault quietly, every row kept.
'use strict';
const { chromium } = require('playwright');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const BASE = process.env.BASE; const DB = process.env.DB; const SECRET = process.env.JWT_SECRET;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const db = new sqlite3.Database(DB);
const run = (s, p = []) => new Promise((r, j) => db.run(s, p, function (e) { e ? j(e) : r(this); }));
const all = (s, p = []) => new Promise((r, j) => db.all(s, p, (e, x) => (e ? j(e) : r(x))));

async function googleUser(tag, legacy) {
  const email = `vq-${tag}-${Date.now()}@finman-smoke.test`;
  const u = await run("INSERT INTO users (username, email, password, full_name, google_id, email_verified_at) VALUES (?, ?, 'x', 'Quiet Test', ?, CURRENT_TIMESTAMP)", [email.split('@')[0], email, 'g' + Date.now() + tag]);
  if (legacy) {
    const a = await run("INSERT INTO accounts (user_id, name, account_type, balance, currency) VALUES (?, 'TD Chequing', 'checking', 2400, 'CAD')", [u.lastID]);
    for (let i = 1; i <= 12; i++) await run('INSERT INTO transactions (account_id, user_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, ?, ?, ?)', [a.lastID, u.lastID, `2026-10-${String(i * 2).padStart(2, '0')}`, 'SHOP #' + i, 'Groceries', -(20 + i), 'expense']);
  }
  return { id: u.lastID, email, token: jwt.sign({ id: u.lastID, tv: 0 }, SECRET, { expiresIn: '1h' }) };
}

async function device(browser, token) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  if (token) await ctx.addInitScript((t) => { try { if (!sessionStorage.getItem('x')) { localStorage.setItem('token', t); localStorage.setItem('fm_qa', '1'); sessionStorage.setItem('x', '1'); } } catch (_) {} }, token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERR', e.message));
  return { ctx, page };
}
// Waits for the app; records every vault screen that showed up on the way.
async function waitApp(page, ms = 60000, allowPrompt = false) {
  const seen = new Set(); const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (const sel of ['#fmv-secret2', '#fmv-secret', '#fmv-rktext', '.fmv-steps, .fmv-step']) if (await page.locator(sel).count()) seen.add(sel);
    const mode = await page.evaluate(() => window.FMVault && window.FMVault.status().mode).catch(() => null);
    if (mode === 'vault' && await page.locator('#main-content').count()) return { ok: true, seen: [...seen] };
    if (!allowPrompt && seen.has('#fmv-secret') && !seen.has('#fmv-secret2')) return { ok: false, seen: [...seen], prompt: (await page.locator('.fmv-box, .fmv-overlay, [class*=fmv]').first().innerText().catch(() => '')).replace(/\s+/g, ' ') };
    await page.waitForTimeout(300);
  }
  return { ok: false, seen: [...seen], timeout: true };
}
const api = (page, path, init) => page.evaluate(async ([p, i]) => { const r = await fetchWithAuth(p, i); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init || {}]);
async function addData(page) {
  const a = await api(page, '/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'Quiet Chequing', currency: 'CAD', balance: 500, accountType: 'checking' }) });
  const acc = (a.body && (a.body.account || a.body.data || a.body)) || {};
  await api(page, '/api/transactions', { method: 'POST', body: JSON.stringify({ accountId: acc.id, amount: 12.5, type: 'expense', description: 'Quiet coffee', category: 'Dining', date: new Date().toISOString().slice(0, 10) }) });
  await page.evaluate(() => window.FMVault.syncNow()); await page.waitForTimeout(1200);
}
const txCount = async (page) => { const r = await api(page, '/api/transactions?limit=100'); const b = r.body || {}; return (b.data || b.transactions || b || []).length; };

(async () => {
  const browser = await chromium.launch();
  // 1
  const g = await googleUser('new');
  const d1 = await device(browser, g.token);
  await d1.page.goto(BASE + '/dashboard');
  let w = await waitApp(d1.page);
  log('1 google new: app', w.ok, 'screens seen', JSON.stringify(w.seen));
  if (!w.ok || w.seen.length) fail('google user saw a vault screen or app did not open');
  await addData(d1.page);
  const pend = await d1.page.evaluate(() => window.FMVault.protectionPending());
  log('1 pending', JSON.stringify(pend), 'tx', await txCount(d1.page));
  if (!pend || !pend.password || !pend.recovery) fail('protectionPending should be password+recovery');
  const rows = await all('SELECT COUNT(*) n FROM transactions WHERE user_id = ?', [g.id]);
  if (rows[0].n !== 0) fail('readable rows on the server');
  // 2
  const d2 = await device(browser, g.token);
  await d2.page.goto(BASE + '/dashboard');
  w = await waitApp(d2.page, 20000);
  log('2 second device before protect: app', w.ok, (w.prompt || '').slice(0, 160));
  if (w.ok || !/Never set one/.test(w.prompt || '')) fail('second device should ask and explain');
  await d2.ctx.close();
  // 3
  const p = d1.page.evaluate(() => window.FMVault.protect());
  // A browser with WebAuthn first offers a passkey (test/e2e/vault-passkey.cjs); here: the vault password.
  await d1.page.waitForSelector('.fmv-pw-new, #fmv-secret2', { timeout: 20000 });
  if (await d1.page.locator('.fmv-pw-new').count()) await d1.page.click('.fmv-pw-new');
  await d1.page.waitForSelector('#fmv-secret2', { timeout: 20000 });
  await d1.page.fill('#fmv-secret', 'Quiet-pass-1124!'); await d1.page.fill('#fmv-secret2', 'Quiet-pass-1124!');
  await d1.page.click('.fmv-form button[type=submit]');
  await d1.page.waitForSelector('#fmv-rktext', { timeout: 60000 });
  await d1.page.click('.fmv-copy').catch(() => {}); await d1.page.check('#fmv-saved'); await d1.page.click('.fmv-go');
  log('3 protect →', await p, 'pending now', JSON.stringify(await d1.page.evaluate(() => window.FMVault.protectionPending())));
  // 4
  const d3 = await device(browser, g.token);
  await d3.page.goto(BASE + '/dashboard');
  await d3.page.waitForSelector('#fmv-secret', { timeout: 30000 });
  await d3.page.fill('#fmv-secret', 'Quiet-pass-1124!'); await d3.page.click('.fmv-form button[type=submit]');
  w = await waitApp(d3.page, 60000, true);
  const n3 = w.ok ? await txCount(d3.page) : -1;
  log('4 second device after protect: app', w.ok, 'tx', n3);
  if (!w.ok || n3 < 1) fail('second device did not open with the vault password');
  await d3.ctx.close(); await d1.ctx.close();
  // 5
  const d5 = await device(browser, null);
  const email = `vq-pw-${Date.now()}@finman-smoke.test`;
  await d5.page.goto(BASE + '/?fm_qa=1');
  await d5.page.click('.auth-tab[data-tab="register"]');
  await d5.page.fill('#register-email', email); await d5.page.fill('#register-password', 'Quiet-Pass-2026!');
  await d5.page.click('#register-form button[type=submit]');
  w = await waitApp(d5.page);
  log('5 password sign-up: app', w.ok, 'screens', JSON.stringify(w.seen));
  if (!w.ok || w.seen.length) fail('password sign-up saw a vault screen');
  await addData(d5.page);
  log('5 pending', JSON.stringify(await d5.page.evaluate(() => window.FMVault.protectionPending())));
  await d5.ctx.close();
  const d6 = await device(browser, null);
  await d6.page.goto(BASE + '/?fm_qa=1');
  await d6.page.click('.auth-tab[data-tab="login"]').catch(() => {});
  await d6.page.fill('#login-username', email); await d6.page.fill('#login-password', 'Quiet-Pass-2026!');
  await d6.page.click('#login-form button[type=submit]');
  w = await waitApp(d6.page);
  const n6 = w.ok ? await txCount(d6.page) : -1;
  log('5 other browser with the login password: app', w.ok, 'tx', n6);
  if (!w.ok || n6 < 1) fail('password user lost data on another browser');
  await d6.ctx.close();
  // 6
  const L = await googleUser('legacy', true);
  const d7 = await device(browser, L.token);
  await d7.page.goto(BASE + '/dashboard');
  w = await waitApp(d7.page);
  const n7 = w.ok ? await txCount(d7.page) : -1;
  const left = await all('SELECT COUNT(*) n FROM transactions WHERE user_id = ?', [L.id]);
  log('6 google legacy: app', w.ok, 'screens', JSON.stringify(w.seen), 'tx in vault', n7, 'readable left on server', left[0].n);
  if (!w.ok || n7 !== 12 || left[0].n !== 0) fail('legacy move lost rows or left readable rows');
  await d7.ctx.close();
  await browser.close(); db.close();
  log(process.exitCode ? 'FAILED' : 'OK');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
