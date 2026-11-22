// test/e2e/invoice-income.cjs — a paid invoice becomes income in the (encrypted) ledger.
//   BASE=http://127.0.0.1:PORT node test/e2e/invoice-income.cjs
// A vault user with a business account marks an invoice paid → the dialog offers the
// business account first → "Record income" adds one income transaction "Invoice N · Client"
// in category Business income → marking it unpaid and paid again offers nothing (no double).
'use strict';
const { chromium } = require('playwright');
const assert = require('assert');
const BASE = process.env.BASE;
const PW = 'Invoice-Income-1122!';

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.goto(BASE + '/?fm_qa=1', { waitUntil: 'networkidle' });
  if (!(await p.locator('#register-email').isVisible())) await p.getByText(/^Create account$/).first().click().catch(() => {});
  await p.fill('#register-email', `inv-income-${Date.now()}@e2e.test`); await p.fill('#register-password', PW);
  await p.locator('#register-form button[type="submit"]').click();
  await p.waitForSelector('.fmv-copy', { timeout: 40000 }); await p.click('.fmv-copy'); await p.click('.fmv-go');
  await p.waitForFunction(() => window.FMVault && window.FMVault.status().mode === 'vault', null, { timeout: 40000 });

  const inv = await p.evaluate(async () => {
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
    const post = async (u, body) => (await fetch(u, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
    await post('/api/accounts', { name: 'Personal chequing', currency: 'CAD', balance: 0, accountType: 'checking' });
    await post('/api/accounts', { name: 'Studio chequing', currency: 'CAD', balance: 0, accountType: 'checking', scope: 'business', businessName: 'Studio' });
    const prof = (await post('/api/invoices/profiles', { name: 'Studio', layout: 'classic', currency: 'CAD', number_format: '{SEQ}', data: {}, is_default: true })).profile;
    return (await post('/api/invoices', { profile_id: prof.id, issue_date: new Date().toISOString().slice(0, 10), client_name: 'Lakeside Cafe', items: [{ description: 'Menu design', qty: 1, price: '1,250.00' }] })).invoice;
  });
  await p.evaluate(() => navigateTo('invoices')); await p.waitForTimeout(2000);
  const mark = (status) => p.evaluate(([id, st]) => {
    const el = document.createElement('button'); el.dataset.action = 'inv:mark'; el.dataset.id = id; el.dataset.status = st;
    document.getElementById('main-content').appendChild(el); el.click();
  }, [inv.id, status]);

  await mark('paid'); await p.waitForSelector('[data-inv-inc="1"]', { timeout: 10000 });
  const first = await p.locator('#inv-inc-acc option').first().textContent();
  assert.match(first, /Studio chequing/, 'business account offered first');
  await p.click('[data-inv-inc="1"]'); await p.waitForTimeout(1500);
  const rows = await p.evaluate(async () => {
    const r = await fetch('/api/transactions?search=Invoice&limit=50', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    const j = await r.json();
    return (j.data || j.transactions || j).filter((t) => /^Invoice /.test(t.description)).map((t) => ({ d: t.description, a: Math.abs(t.amount), type: t.type, c: t.category }));
  });
  assert.deepStrictEqual(rows, [{ d: `Invoice ${inv.number} · Lakeside Cafe`, a: 1250, type: 'income', c: 'Business income' }]);

  await mark('sent'); await p.waitForTimeout(1200);
  await mark('paid'); await p.waitForTimeout(2500);
  assert.strictEqual(await p.locator('[data-inv-inc="1"]').count(), 0, 'no second offer for the same invoice');
  console.log('invoice-income: OK');
  await b.close();
})().catch((e) => { console.error('invoice-income: FAIL', e.message); process.exit(1); });
