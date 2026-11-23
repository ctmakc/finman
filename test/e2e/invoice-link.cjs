// test/e2e/invoice-link.cjs — the client link end to end, as people use it.
//   BASE=http://127.0.0.1:PORT [SHOTS=dir] [EMAIL=x@finman.test] node test/e2e/invoice-link.cjs
// A vault (encrypted) user makes a template with a card link, PayPal.me, e-Transfer and a 3 %
// payer card fee, issues an invoice, presses "Client link". A guest browser (no account) opens
// the link: amount, card amount with the fee, Pay button, PDF. The issuer's list then shows
// "Opened". Every request body the issuer's browser sent outside /api/invoices and /api/vault
// is checked: none carries the user's ledger data in the open.
'use strict';
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const BASE = process.env.BASE;
const SHOTS = process.env.SHOTS || '';
const PW = 'Invoice-Link-1122!';
const EMAIL = process.env.EMAIL || `inv-link-${Date.now()}@e2e.test`;
const shot = async (page, name, full = true) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full }); } };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const sent = [];
  p.on('request', (r) => { if (r.url().startsWith(BASE + '/api/') && r.method() !== 'GET') sent.push({ url: r.url().slice(BASE.length), body: r.postData() || '' }); });
  await p.goto(BASE + '/?fm_qa=1', { waitUntil: 'networkidle' });
  if (!(await p.locator('#register-email').isVisible())) await p.getByText(/^Create account$/).first().click().catch(() => {});
  await p.fill('#register-email', EMAIL); await p.fill('#register-password', PW);
  await p.locator('#register-form button[type="submit"]').click();
  await p.waitForSelector('.fmv-copy', { timeout: 40000 }); await p.click('.fmv-copy'); await p.click('.fmv-go');
  await p.waitForFunction(() => window.FMVault && window.FMVault.status().mode === 'vault', null, { timeout: 40000 });

  // A private ledger entry: it must never reach the server in the open.
  const SECRET = 'Rent-SECRET-Payee-7781';
  const inv = await p.evaluate(async (secret) => {
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
    const post = async (u, body) => (await fetch(u, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
    const acc = await post('/api/accounts', { name: 'Studio chequing', currency: 'CAD', balance: 0, accountType: 'checking' });
    const accId = (acc.data || acc.account || acc).id;
    await post('/api/transactions', { accountId: accId, date: new Date().toISOString().slice(0, 10), description: secret, amount: 2150, type: 'expense', category: 'Housing' });
    const prof = (await post('/api/invoices/profiles', { name: 'Morgan Design Studio', layout: 'classic', currency: 'CAD', number_format: 'MDS-{SEQ3}', is_default: true, data: {
      seller: { name: 'Morgan Design Studio', label: 'Supplier:', lines: ['220 Elgin St, Ottawa ON', 'hello@morgan.example'] },
      pay_online: { url: 'https://buy.stripe.com/test_00000000?client_reference_id={ref}', label: 'by card:', currencies: ['CAD'] },
      pay_paypal: 'paypal.me/morgandesign', pay_etransfer: 'pay@morgan.example', card_fee: { pct: 3 },
      bank: { title: 'Bank transfer', key: [{ k: 'Account name', v: 'Morgan Design Studio' }, { k: 'Institution / transit / account', v: '003 / 00012 / 1234567' }], rest: [] },
      payment_reference: 'Invoice {number}', tax: { label: 'HST 13%', rate: 13 },
    } })).profile;
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const i = (await post('/api/invoices', { profile_id: prof.id, issue_date: today, due_date: due, client_name: 'Lakeside Cafe Inc.', client_details: '45 Bank St\nOttawa ON K1P 5N2',
      items: [{ description: 'Menu and signage design', qty: 1, price: '1,250.00' }, { description: 'Print-ready files', detail: '3 formats', qty: 2, price: '150.00' }] })).invoice;
    // An older, overdue one for the list.
    const late = (await post('/api/invoices', { profile_id: prof.id, issue_date: '2026-10-01', due_date: '2026-10-15', client_name: 'Northside Bakery', items: [{ description: 'Logo refresh', qty: 1, price: '600.00' }] })).invoice;
    await post('/api/invoices/' + late.id + '/status', { status: 'sent' });
    return i;
  }, SECRET);
  await p.evaluate(() => navigateTo('invoices')); await p.waitForSelector('.inv-row', { timeout: 15000 });

  // "Client link" from the row → Create link.
  await p.click(`.inv-row[data-id="${inv.id}"] [data-action="inv:link"]`);
  await p.waitForSelector('[data-inv-link="create"]'); await shot(p, 'app-link-modal-before-1440', false);
  await p.click('[data-inv-link="create"]');
  await p.waitForSelector('.inv-share input', { timeout: 10000 });
  const url = await p.inputValue('.inv-share input');
  assert.match(url, /\/i\/[A-Za-z0-9_-]{22,}$/);
  await shot(p, 'app-link-modal-1440', false);
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);

  // Guest: no account, phone.
  for (const [w, h, tag, mobile] of [[390, 844, '390', true], [1440, 900, '1440', false]]) {
    const ua = mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
    const g = await b.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, locale: 'en-CA', userAgent: ua });
    const gp = await g.newPage();
    await gp.goto(url, { waitUntil: 'networkidle' });
    const text = await gp.textContent('body');
    assert.ok(text.includes('1,751.50'), 'amount due = 1,550.00 + 13% HST');
    assert.ok(text.includes('Pay by card · 1,804.05 CAD'), 'card amount includes the 3% fee');
    assert.ok(text.includes('includes 3% card fee, paid by the payer'));
    assert.ok(text.includes('pay@morgan.example'));
    assert.ok(!text.includes(SECRET), 'ledger data is not on the page');
    const href = await gp.getAttribute('[data-pay="card"]', 'href');
    assert.match(href, /^https:\/\/buy\.stripe\.com\//);
    assert.strictEqual(await gp.getAttribute('[data-pay="paypal"]', 'href'), 'https://paypal.me/morgandesign/1804.05CAD');
    const pdf = await gp.request.get(url + '/pdf');
    assert.strictEqual(pdf.headers()['content-type'], 'application/pdf');
    await gp.waitForTimeout(1500);
    await shot(gp, `client-page-${tag}`);
    await shot(gp, `client-page-${tag}-first-screen`, false);
    if (mobile) {
      await gp.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.75)); await gp.waitForTimeout(600);
      await shot(gp, 'client-page-390-scrolled', false);
    }
    await g.close();
  }

  // The issuer sees "Opened".
  await p.evaluate(() => navigateTo('invoices')); await p.waitForSelector('.inv-row-seen', { timeout: 15000 });
  const seen = await p.textContent(`.inv-row[data-id="${inv.id}"] .inv-row-seen`);
  assert.match(seen, /Opened/);
  assert.ok(await p.locator('.inv-row.is-overdue').count() >= 1, 'overdue row is highlighted');
  await shot(p, 'app-list-1440', false);
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(800); await shot(p, 'app-list-390', false);

  // What left the issuer's browser.
  const leaks = sent.filter((r) => !/^\/api\/(invoices|vault)\b/.test(r.url) && r.body.includes(SECRET));
  assert.deepStrictEqual(leaks, [], 'no ledger text in any request outside invoices/vault');
  const vaultPuts = sent.filter((r) => /^\/api\/vault\/blob/.test(r.url));
  console.log(JSON.stringify({ ok: true, url, invoice: inv.number, requests: sent.length, vaultPuts: vaultPuts.length, email: EMAIL }));
  await b.close();
})().catch((e) => { console.error('invoice-link: FAIL', e.message); process.exit(1); });
