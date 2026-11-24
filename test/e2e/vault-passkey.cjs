// test/e2e/vault-passkey.cjs — «Protect your data» with a passkey (WebAuthn PRF) after a quiet start.
//
//   BASE=http://localhost:PORT DB=/path/stand.db JWT_SECRET=… node test/e2e/vault-passkey.cjs
//   (WebAuthn needs a host name: use localhost, not 127.0.0.1)
//
// Chrome's virtual authenticator with PRF stands in for Face ID / Google Password Manager.
// 1. Google user, quiet start, own data → First steps shows «only in this browser» + Protect.
// 2. Protect → passkey → pending cleared, the notice is gone.
// 3. Second device with the same (synced) passkey: «Use your passkey» opens the vault, data there.
'use strict';
const { chromium } = require('playwright');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const BASE = process.env.BASE; const DB = process.env.DB; const SECRET = process.env.JWT_SECRET;
const SHOTS = process.env.SHOTS || '/fast/claude-tmp/finman-vq';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const db = new sqlite3.Database(DB);
const run = (s, p = []) => new Promise((r, j) => db.run(s, p, function (e) { e ? j(e) : r(this); }));

async function withAuthenticator(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
}
const api = (page, path, init) => page.evaluate(async ([p, i]) => { const r = await fetchWithAuth(p, i); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init || {}]);

(async () => {
  const email = `vq-pk-${Date.now()}@finman-smoke.test`;
  const u = await run("INSERT INTO users (username, email, password, full_name, google_id, email_verified_at) VALUES (?, ?, 'x', 'Passkey Test', ?, CURRENT_TIMESTAMP)", [email.split('@')[0], email, 'gpk' + Date.now()]);
  const token = jwt.sign({ id: u.lastID, tv: 0 }, SECRET, { expiresIn: '1h' });
  const browser = await chromium.launch();
  const mk = async (W) => {
    const ctx = await browser.newContext({ viewport: { width: W, height: W === 390 ? 844 : 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { try { if (!sessionStorage.getItem('x')) { localStorage.setItem('token', t); localStorage.setItem('fm_qa', '1'); sessionStorage.setItem('x', '1'); } } catch (_) {} }, token);
    const page = await ctx.newPage(); page.on('pageerror', (e) => log('PAGEERR', e.message));
    return { ctx, page, auth: await withAuthenticator(ctx, page) };
  };
  // 1
  const d1 = await mk(390);
  await d1.page.goto(BASE + '/dashboard');
  await d1.page.waitForFunction(() => window.FMVault && window.FMVault.status().mode === 'vault', null, { timeout: 60000 });
  await d1.page.waitForTimeout(2500);
  await d1.page.fill('#sd-quick-amount', '7.25'); await d1.page.fill('#sd-quick-what', 'Passkey tea');
  await d1.page.click('#sd-quick-save'); await d1.page.waitForTimeout(2500);
  await d1.page.evaluate(() => window.FMVault.syncNow()); await d1.page.waitForTimeout(800);
  const notice = await d1.page.locator('.sd-deviceonly').count();
  log('1 notice «only in this browser»:', notice, '| protect step:', await d1.page.locator('[data-sd="protect"]').count());
  if (!notice) fail('no device-only notice');
  await d1.page.locator('.sd-deviceonly').scrollIntoViewIfNeeded(); await d1.page.screenshot({ path: SHOTS + '/pk-1-notice-390.png' });
  // 2
  await d1.page.click('.sd-deviceonly [data-sd="protect"]');
  await d1.page.waitForSelector('.fmv-pk-new', { timeout: 20000 });
  await d1.page.screenshot({ path: SHOTS + '/pk-2-choice-390.png' });
  await d1.page.click('.fmv-pk-new');
  await d1.page.waitForSelector('#fmv-rktext', { timeout: 60000 });
  await d1.page.check('#fmv-saved'); await d1.page.click('.fmv-go');
  await d1.page.waitForTimeout(2500);
  const pend = await d1.page.evaluate(() => window.FMVault.protectionPending());
  log('2 after passkey: pending', JSON.stringify(pend), '| notice left:', await d1.page.locator('.sd-deviceonly').count());
  if (pend) fail('still pending after passkey');
  const { credentials } = await d1.auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: d1.auth.authenticatorId });
  log('2 passkeys on device 1:', credentials.length);
  // 3. «Cleared browser» on the same authenticator: local vault copy and device key gone → «Use your passkey».
  // (Chrome's virtual authenticator cannot export a credential's PRF secret to another browser, so the
  //  cross-device case is the platform's passkey sync; the unlock path is the same.)
  await d1.page.evaluate(async () => { await new Promise((r) => { const q = indexedDB.deleteDatabase('finman-vault'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
  const dbs = await d1.page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
  for (const n of dbs) await d1.page.evaluate((nm) => new Promise((r) => { const q = indexedDB.deleteDatabase(nm); q.onsuccess = q.onerror = q.onblocked = () => r(); }), n);
  await d1.page.reload();
  await d1.page.waitForSelector('.fmv-pk', { timeout: 30000 });
  await d1.page.screenshot({ path: SHOTS + '/pk-3-unlock-390.png' });
  await d1.page.click('.fmv-pk');
  await d1.page.waitForFunction(() => window.FMVault && window.FMVault.status().mode === 'vault', null, { timeout: 60000 }).catch(() => {});
  const ok = await d1.page.evaluate(() => window.FMVault && window.FMVault.status().mode);
  if (ok !== 'vault') log('3 prompt now:', (await d1.page.locator('.fmv-err').innerText().catch(() => '')).slice(0, 200));
  const tx = ok === 'vault' ? await api(d1.page, '/api/transactions?limit=200') : null;
  const mine = tx && JSON.stringify(tx.body || '').includes('Passkey tea');
  log('3 cleared browser + passkey: mode', ok, '| own entry there:', mine, '| idb was', JSON.stringify(dbs));
  if (ok !== 'vault' || !mine) fail('passkey did not open the vault');
  await browser.close(); db.close();
  log(process.exitCode ? 'FAILED' : 'OK');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
