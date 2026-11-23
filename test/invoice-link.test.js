// test/invoice-link.test.js — public client link (/i/<token>): page, PDF, payment buttons with the
// payer's card fee, view beacon, turning the link off, overdue filter and totals, ownership.
const { makeApp } = require('./helpers/app');
const core = require('../services/invoice/core');
const presets = require('../services/invoice/presets');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes }); });
  });
}
async function makeUser(ctx, username) {
  const jwt = require('jsonwebtoken');
  const config = require('../config/config');
  const ins = await dbRun(ctx.db, 'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)', [username, `${username}@example.com`, 'x', username]);
  return { id: ins.id, token: jwt.sign({ id: ins.id }, config.jwtSecret, { expiresIn: '1h' }) };
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const binaryParser = (res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); };
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('invoice core: card fee and payment methods', () => {
  test('fee, PayPal.me and e-Transfer helpers', () => {
    expect(core.cardFeePct({ card_fee: { pct: 3 } })).toBe(3);
    expect(core.cardFeePct({ card_fee: null })).toBe(0);
    expect(core.cardFeePct({ card_fee: { pct: 50 } })).toBe(0);
    expect(core.cardFeeCents(100000, 3)).toBe(3000);
    expect(core.paypalUrl('paypal.me/jane', 103000, 'cad')).toBe('https://paypal.me/jane/1030CAD');
    expect(core.paypalUrl('https://www.paypal.com/paypalme/jane.d', 10050, 'EUR')).toBe('https://paypal.me/jane.d/100.50EUR');
    expect(core.paypalUrl('javascript:alert(1)', 10000, 'EUR')).toBeNull();
    expect(core.etransferEmail('pay@studio.ca')).toBe('pay@studio.ca');
    expect(core.etransferEmail('<x>@y')).toBeNull();
  });
});

describe('invoice client link', () => {
  let ctx;
  beforeEach(async () => { ctx = await makeApp(); });
  afterEach(async () => { await ctx.close(); });
  const H = () => auth(ctx.token);

  async function template(dataExtra = {}) {
    const p = presets.OWNER_PRESETS['innova-cad'];
    const res = await ctx.request.post('/api/invoices/profiles').set(H()).send({
      name: 'Studio', layout: p.layout, currency: 'CAD', number_format: '{SEQ}', due_days: 14,
      data: { ...p.data, pay_online: { url: 'https://buy.stripe.com/test_x?ref={ref}&amount={amount}', label: 'by card', currencies: ['CAD'] },
        pay_paypal: 'paypal.me/studio', pay_etransfer: 'pay@studio.ca', card_fee: { pct: 3 }, ...dataExtra },
    });
    expect(res.status).toBe(201);
    return res.body.profile;
  }
  async function invoice(p, body = {}) {
    const r = await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, client_name: 'Client Co', items: [{ description: 'Design work', qty: 1, price: '1,000.00' }], tax_rate: 0, ...body });
    expect(r.status).toBe(201);
    return r.body.invoice;
  }

  test('create link: draft becomes sent, page shows amount, card + PayPal include the fee, bank stays at total', async () => {
    const p = await template();
    const inv = await invoice(p);
    expect(inv.card_fee_pct).toBe(3);
    expect(inv.pay_url).toContain('amount=1030');
    const r = await ctx.request.post(`/api/invoices/${inv.id}/link`).set(H());
    expect(r.status).toBe(201);
    expect(r.body.invoice.status).toBe('sent');
    const url = r.body.invoice.link.url;
    const token = url.split('/i/')[1];
    expect(token.length).toBeGreaterThanOrEqual(22);
    const again = await ctx.request.post(`/api/invoices/${inv.id}/link`).set(H());
    expect(again.status).toBe(200);
    expect(again.body.invoice.link.url).toBe(url);

    const pageRes = await ctx.request.get(`/i/${token}`).set('Accept-Language', 'en');
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers['x-robots-tag']).toMatch(/noindex/);
    const html = pageRes.text;
    expect(html).toContain('1,000.00');
    expect(html).toContain('Pay by card · 1,030.00 CAD');
    expect(html).toContain('https://paypal.me/studio/1030CAD');
    expect(html).toContain('includes 3% card fee');
    expect(html).toContain('pay@studio.ca');
    expect(html).toContain('Interac e-Transfer · 1,000.00 CAD');
    expect(html).not.toMatch(/free/i);

    const ru = await ctx.request.get(`/i/${token}`).set('Accept-Language', 'ru-RU,ru;q=0.9');
    expect(ru.text).toContain('Оплатить картой');

    const pdf = await ctx.request.get(`/i/${token}/pdf`).buffer(true).parse(binaryParser);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('views: the beacon counts a browser, not a link preview bot, reloads within 10 min count once', async () => {
    const p = await template();
    const inv = await invoice(p);
    const token = (await ctx.request.post(`/api/invoices/${inv.id}/link`).set(H())).body.invoice.link.url.split('/i/')[1];
    let l = (await ctx.request.get(`/api/invoices/${inv.id}`).set(H())).body.invoice.link;
    expect(l.view_count).toBe(0);
    await ctx.request.post(`/i/${token}/seen`).set('User-Agent', 'TelegramBot (like TwitterBot)');
    l = (await ctx.request.get(`/api/invoices/${inv.id}`).set(H())).body.invoice.link;
    expect(l.view_count).toBe(0);
    expect((await ctx.request.post(`/i/${token}/seen`).set('User-Agent', BROWSER)).status).toBe(204);
    await ctx.request.post(`/i/${token}/seen`).set('User-Agent', BROWSER);
    const list = (await ctx.request.get('/api/invoices').set(H())).body.invoices;
    l = list.find((x) => x.id === inv.id).link;
    expect(l.view_count).toBe(1);
    expect(l.first_viewed_at).toBeTruthy();
    expect(l.last_viewed_at).toBeTruthy();
  });

  test('turning the link off: the page answers 410, a new link has a new address', async () => {
    const p = await template();
    const inv = await invoice(p);
    const url1 = (await ctx.request.post(`/api/invoices/${inv.id}/link`).set(H())).body.invoice.link.url;
    const off = await ctx.request.delete(`/api/invoices/${inv.id}/link`).set(H());
    expect(off.body.invoice.link).toBeNull();
    expect((await ctx.request.get(`/i/${url1.split('/i/')[1]}`)).status).toBe(410);
    const url2 = (await ctx.request.post(`/api/invoices/${inv.id}/link`).set(H())).body.invoice.link.url;
    expect(url2).not.toBe(url1);
    expect((await ctx.request.get(`/i/${url2.split('/i/')[1]}`)).status).toBe(200);
    expect((await ctx.request.get('/i/not-a-real-token-at-all-xxxxx')).status).toBe(404);
  });

  test('paid invoice: no pay buttons; void invoice cannot be shared; fee off = plain total', async () => {
    const p = await template({ card_fee: null });
    const inv = await invoice(p);
    const token = (await ctx.request.post(`/api/invoices/${inv.id}/link`).set(H())).body.invoice.link.url.split('/i/')[1];
    let html = (await ctx.request.get(`/i/${token}`)).text;
    expect(html).toContain('Pay by card · 1,000.00 CAD');
    expect(html).not.toContain('card fee');
    await ctx.request.post(`/api/invoices/${inv.id}/status`).set(H()).send({ status: 'paid' });
    html = (await ctx.request.get(`/i/${token}`)).text;
    expect(html).toContain('This invoice is paid');
    expect(html).not.toContain('Pay by card');
    const v = await invoice(p);
    await ctx.request.post(`/api/invoices/${v.id}/status`).set(H()).send({ status: 'void' });
    expect((await ctx.request.post(`/api/invoices/${v.id}/link`).set(H())).status).toBe(400);
  });

  test('overdue: filter, totals and the page banner', async () => {
    const p = await template();
    const late = await invoice(p, { issue_date: '2026-01-01', due_date: '2026-01-15' });
    await ctx.request.post(`/api/invoices/${late.id}/status`).set(H()).send({ status: 'sent' });
    const fresh = await invoice(p, { due_date: '2099-01-01' });
    await ctx.request.post(`/api/invoices/${fresh.id}/status`).set(H()).send({ status: 'sent' });
    const r = await ctx.request.get('/api/invoices?status=overdue').set(H());
    expect(r.body.invoices.map((x) => x.id)).toEqual([late.id]);
    expect(r.body.totals.CAD.overdue_cents).toBe(100000);
    expect(r.body.totals.CAD.overdue_count).toBe(1);
    const token = (await ctx.request.post(`/api/invoices/${late.id}/link`).set(H())).body.invoice.link.url.split('/i/')[1];
    expect((await ctx.request.get(`/i/${token}`)).text).toContain('Payment is overdue');
  });

  test('ownership: another user cannot create or turn off my link', async () => {
    const p = await template();
    const inv = await invoice(p);
    const other = await makeUser(ctx, 'mallory');
    expect((await ctx.request.post(`/api/invoices/${inv.id}/link`).set(auth(other.token))).status).toBe(404);
    await ctx.request.post(`/api/invoices/${inv.id}/link`).set(H());
    expect((await ctx.request.delete(`/api/invoices/${inv.id}/link`).set(auth(other.token))).status).toBe(404);
    const l = (await ctx.request.get(`/api/invoices/${inv.id}`).set(H())).body.invoice.link;
    expect(l).toBeTruthy();
  });
});

describe('invoice quick wins: payments, repeat, CSV', () => {
  let ctx;
  beforeEach(async () => { ctx = await makeApp(); });
  afterEach(async () => { await ctx.close(); });
  const H = () => auth(ctx.token);
  async function setup() {
    const p = (await ctx.request.post('/api/invoices/profiles').set(H()).send({ name: 'S', layout: 'classic', currency: 'CAD', number_format: 'R-{SEQ}', due_days: 10, data: {} })).body.profile;
    const inv = (await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, issue_date: '2026-09-30', client_name: 'Acme, "North"', items: [{ description: 'Retainer', qty: 1, price: '1,000.00' }] })).body.invoice;
    return { p, inv };
  }

  test('deposit 30 % then the rest: partial keeps it open, the rest marks it paid', async () => {
    const { inv } = await setup();
    const a = await ctx.request.post(`/api/invoices/${inv.id}/payments`).set(H()).send({ amount: '300.00', method: 'e-Transfer' });
    expect(a.status).toBe(201);
    expect(a.body.invoice.status).toBe('sent');
    expect(a.body.invoice.paid_cents).toBe(30000);
    expect(a.body.invoice.balance_cents).toBe(70000);
    const over = await ctx.request.post(`/api/invoices/${inv.id}/payments`).set(H()).send({ amount: '800' });
    expect(over.status).toBe(400);
    const b = await ctx.request.post(`/api/invoices/${inv.id}/payments`).set(H()).send({});
    expect(b.body.invoice.status).toBe('paid');
    expect((await ctx.request.get(`/api/invoices/${inv.id}/payments`).set(H())).body.payments).toHaveLength(2);
    const del = await ctx.request.delete(`/api/invoices/${inv.id}/payments/${b.body.payments[1].id}`).set(H());
    expect(del.body.invoice.status).toBe('sent');
  });

  test('repeat monthly: catches up drafts up to today, keeps lines and due days, stops on request', async () => {
    const { inv } = await setup();
    const r = await ctx.request.put(`/api/invoices/${inv.id}/repeat`).set(H()).send({ every: 'month' });
    expect(r.status).toBe(200);
    expect(r.body.invoice.repeat.every).toBe('month');
    expect(r.body.invoice.repeat.next_date >= '2026-10-30').toBe(true);
    // Pretend the rule was set long ago: next draft due on 2026-10-30.
    await new Promise((res, rej) => ctx.db.run("UPDATE invoice_repeats SET next_date = '2026-10-30'", (e) => (e ? rej(e) : res())));
    const list = (await ctx.request.get('/api/invoices').set(H())).body.invoices;
    const drafts = list.filter((x) => x.id !== inv.id);
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts.every((d) => d.status === 'draft' && d.total_cents === 100000 && d.client_name === 'Acme, "North"')).toBe(true);
    expect(drafts.map((d) => d.issue_date)).toContain('2026-10-30');
    const oct = drafts.find((d) => d.issue_date === '2026-10-30');
    expect(oct.due_date).toBe('2026-11-09');
    const again = (await ctx.request.get('/api/invoices').set(H())).body.invoices;
    expect(again.length).toBe(list.length); // no duplicates on the next load
    const stop = await ctx.request.put(`/api/invoices/${inv.id}/repeat`).set(H()).send({ every: null });
    expect(stop.body.invoice.repeat).toBeNull();
  });

  test('CSV export: header, quoting, no formulas, only my invoices', async () => {
    const { inv } = await setup();
    await ctx.request.post(`/api/invoices/${inv.id}/payments`).set(H()).send({ amount: '250' });
    const r = await ctx.request.get('/api/invoices/export.csv').set(H());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('number,status,issue_date,due_date,client,currency,subtotal,tax,total,paid,balance,sent_at,paid_at,client_views');
    expect(lines[1]).toContain('"Acme, ""North"""');
    expect(lines[1]).toContain(',1000.00,250.00,750.00,');
    const p2 = (await ctx.request.post('/api/invoices/profiles').set(H()).send({ name: 'T', currency: 'CAD', data: {} })).body.profile;
    await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p2.id, client_name: '=HYPERLINK("x")', items: [] });
    const r2 = await ctx.request.get('/api/invoices/export.csv').set(H());
    expect(r2.text).toContain("'=HYPERLINK");
    expect((await ctx.request.get('/api/invoices/export.csv')).status).toBe(401);
  });
});
