// test/e2e/invoices-vault.cjs — invoices inside the vault, in a real browser.
//   BASE=http://127.0.0.1:PORT DB=<server sqlite file> [SHOTS=dir] node test/e2e/invoices-vault.cjs
// 1. A vault user makes a template and an invoice: nothing about them lands in the server DB;
//    the PDF is made in the browser; a client link publishes only that invoice's snapshot.
// 2. Late import: invoice rows the server still holds for this vault account (made before the move)
//    come into the vault on the next open, and the server deletes them.
'use strict';
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const BASE = process.env.BASE;
const DB = process.env.DB;
const SHOTS = process.env.SHOTS || '';
const PW = 'Invoice-Vault-1123!';
const EMAIL = process.env.EMAIL || `inv-vault-${Date.now()}@e2e.test`;
const sqlite = (sql, params = []) => new Promise((res, rej) => {
  const s = require('sqlite3'); const d = new s.Database(DB);
  d.all(sql, params, (e, r) => { d.close(); if (e) rej(e); else res(r); });
});

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + '/?fm_qa=1', { waitUntil: 'networkidle' });
  if (!(await p.locator('#register-email').isVisible())) await p.getByText(/^Create account$/).first().click().catch(() => {});
  await p.fill('#register-email', EMAIL); await p.fill('#register-password', PW);
  await p.locator('#register-form button[type="submit"]').click();
  await p.waitForSelector('.fmv-copy', { timeout: 40000 }); await p.click('.fmv-copy'); await p.click('.fmv-go');
  await p.waitForFunction(() => window.FMVault && window.FMVault.status().mode === 'vault', null, { timeout: 40000 });
  const uid = (await sqlite('SELECT id FROM users WHERE email = ?', [EMAIL]))[0].id;

  // 1. Everything in the vault.
  const SECRET = 'Vault-Client-Ltd-5521';
  const inv = await p.evaluate(async (secret) => {
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
    const post = async (u, body, m) => (await fetch(u, { method: m || 'POST', headers: H, body: JSON.stringify(body) })).json();
    const prof = (await post('/api/invoices/profiles', { name: 'Vault Studio', currency: 'CAD', number_format: 'VS-{SEQ}', is_default: true,
      data: { seller: { name: 'Vault Studio Inc.' }, pay_online: { url: 'https://buy.stripe.com/test_x', label: 'by card' }, card_fee: { pct: 3 }, pay_etransfer: 'pay@vault.example' } })).profile;
    return (await post('/api/invoices', { profile_id: prof.id, client_name: secret, items: [{ description: 'Brand design', qty: 1, price: '2,000.00' }] })).invoice;
  }, SECRET);
  assert.strictEqual(inv.number, 'VS-1');
  for (const t of ['invoice_profiles', 'invoices']) {
    assert.strictEqual((await sqlite(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, [uid]))[0].n, 0, `${t}: no server rows`);
  }
  await p.evaluate(() => navigateTo('invoices')); await p.waitForSelector('.inv-row', { timeout: 15000 });
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click(`.inv-row[data-id="${inv.id}"] [data-action="inv:pdf"]`)]);
  const file = await dl.path(); const head = fs.readFileSync(file).slice(0, 5).toString();
  assert.strictEqual(head, '%PDF-', 'PDF made in the browser');
  await p.click(`.inv-row[data-id="${inv.id}"] [data-action="inv:link"]`);
  await p.click('[data-inv-link="create"]'); await p.waitForSelector('.inv-share input', { timeout: 15000 });
  const url = await p.inputValue('.inv-share input');
  await p.keyboard.press('Escape');
  const links = await sqlite('SELECT invoice_id, snapshot FROM invoice_links WHERE user_id = ?', [uid]);
  assert.strictEqual(links.length, 1); assert.ok(links[0].snapshot.includes(SECRET), 'the published invoice is on the server by consent');
  const g = await b.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const gp = await g.newPage(); await gp.goto(url, { waitUntil: 'networkidle' });
  assert.ok((await gp.textContent('body')).includes('Pay by card · 2,060.00 CAD'));
  if (SHOTS) await gp.screenshot({ path: SHOTS + '/vault-client-390.png', fullPage: true });
  await g.close();
  // Vault blob on the server: ciphertext, the client name is not readable.
  const vb = await sqlite('SELECT blob FROM user_vaults WHERE user_id = ?', [uid]);
  assert.ok(!Buffer.from(vb[0].blob).toString('latin1').includes(SECRET));

  // 2. Late import: rows the server still has for this account.
  await sqlite("INSERT INTO invoice_profiles (user_id, name, layout, currency, number_format, next_seq, due_days, data) VALUES (?, 'Old server template', 'classic', 'EUR', 'OLD-{SEQ}', 4, 14, '{}')", [uid]);
  const op = (await sqlite('SELECT id FROM invoice_profiles WHERE user_id = ?', [uid]))[0].id;
  await sqlite("INSERT INTO invoices (user_id, profile_id, number, status, issue_date, currency, client_name, items, subtotal_cents, total_cents, snapshot) VALUES (?, ?, 'OLD-3', 'sent', '2026-11-01', 'EUR', 'Legacy Client GmbH', '[]', 70000, 70000, '{}')", [uid, op]);
  await p.reload({ waitUntil: 'networkidle' });
  if (await p.locator('#fmv-pw, .fmv-overlay input[type=password]').first().isVisible().catch(() => false)) {
    await p.fill('.fmv-overlay input[type=password]', PW); await p.keyboard.press('Enter');
  }
  await p.waitForFunction(() => window.FMVault && window.FMVault.status().mode === 'vault', null, { timeout: 40000 });
  await p.waitForTimeout(1500);
  const left = (await sqlite('SELECT COUNT(*) n FROM invoices WHERE user_id = ?', [uid]))[0].n + (await sqlite('SELECT COUNT(*) n FROM invoice_profiles WHERE user_id = ?', [uid]))[0].n;
  assert.strictEqual(left, 0, 'server rows moved and deleted');
  await p.evaluate(() => navigateTo('invoices')); await p.waitForSelector('.inv-row', { timeout: 15000 });
  const nums = await p.$$eval('.inv-row-num', (els) => els.map((e) => e.textContent));
  assert.ok(nums.some((n) => n.includes('OLD-3')) && nums.some((n) => n.includes('VS-1')), 'both invoices in the vault: ' + nums.join(','));
  const seenOn = await p.$$eval('.inv-row', (rows) => rows.filter((r) => r.querySelector('.inv-row-seen')).map((r) => r.querySelector('.inv-row-num').textContent));
  assert.deepStrictEqual(seenOn, ['No. VS-1'], 'the client link stays on its own invoice');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/vault-list-1440.png' });
  console.log(JSON.stringify({ ok: true, uid, url, errs, email: EMAIL }));
  await b.close();
})().catch((e) => { console.error('invoices-vault: FAIL', e.message); process.exit(1); });
