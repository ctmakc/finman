// test/invoices.test.js — invoicing: pure helpers (numbering, words, pay link), templates,
// invoices CRUD, ownership (IDOR), PDF with the Finman footer, shared templates.
const { makeApp } = require('./helpers/app');
const core = require('../services/invoice/core');
const presets = require('../services/invoice/presets');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

async function makeUser(ctx, username) {
  const jwt = require('jsonwebtoken');
  const config = require('../config/config');
  const ins = await dbRun(ctx.db,
    'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)',
    [username, `${username}@example.com`, 'x', username]);
  return { id: ins.id, token: jwt.sign({ id: ins.id }, config.jwtSecret, { expiresIn: '1h' }) };
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });
// 1×1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function pdfText(buf) {
  // pdfkit writes text as hex glyph strings; the footer URL is also stored as a plain link annotation.
  return buf.toString('latin1');
}
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('invoice core helpers', () => {
  test('money parsing and formatting', () => {
    expect(core.toCents('1,500.00')).toBe(150000);
    expect(core.toCents('1.500,25')).toBe(150025);
    expect(core.toCents('38.4')).toBe(3840);
    expect(core.toCents('abc')).toBeNull();
    expect(core.fmtCents(169500)).toBe('1,695.00');
  });

  test('totals round tax once on the subtotal (OH! Catering invoice No. 4)', () => {
    const t = core.computeTotals([{ qty: 18, price_cents: 3840 }], 13);
    expect(t.subtotal_cents).toBe(69120);
    expect(t.tax_cents).toBe(8986);
    expect(t.total_cents).toBe(78106);
  });

  test('numbering: {N} takes the smallest free number of the day, {SEQ} the running counter', () => {
    expect(core.suggestNumber('{DD}-{MM}-{YY}-{N}', '2026-11-13', 1, new Set())).toBe('13-11-26-1');
    expect(core.suggestNumber('{DD}-{MM}-{YY}-{N}', '2026-11-13', 1, new Set(['13-11-26-1']))).toBe('13-11-26-2');
    expect(core.suggestNumber('INV-{YYYY}-{SEQ4}', '2026-11-13', 7, new Set())).toBe('INV-2026-0007');
    expect(core.seqFromNumber('INV-{YYYY}-{SEQ4}', 'INV-2026-0007')).toBe(7);
    expect(core.seqFromNumber('{SEQ}', '12')).toBe(12);
    expect(core.seqFromNumber('{DD}-{MM}-{YY}-{N}', '13-11-26-1')).toBeNull();
  });

  test('amount in words', () => {
    expect(core.amountInWords(169500, 'CAD')).toBe('One thousand six hundred ninety-five Canadian dollars 00 cents');
    expect(core.amountInWords(10000, 'EUR')).toBe('One hundred euros 00 cents');
    expect(core.amountInWords(20000, 'EUR', { one: 'euro', many: 'euro', minor: 'euro cents' })).toBe('Two hundred euro 00 euro cents');
  });

  test('pay link mirrors innova pay_link.py', () => {
    const po = presets.OWNER_PRESETS['innova-cad'].data.pay_online;
    expect(core.payUrl(po, '03-08-26-1', 169500, 'CAD')).toBe('https://innovacg.com/en/invoice?ref=03-08-26-1&amount=1695&currency=CAD');
    expect(core.payUrl(po, '03-08-26-1', 169550, 'EUR')).toBe('https://innovacg.com/en/invoice?ref=03-08-26-1&amount=1695.50&currency=EUR');
    expect(core.payUrl(po, '03-08-26-1', 50, 'CAD')).toBeNull(); // below 1.00
    expect(core.payUrl(po, '03-08-26-1', 10000, 'GBP')).toBeNull(); // currency not accepted
    expect(core.payUrl(po, 'bad ref!', 10000, 'CAD')).toBeNull();
    expect(core.payUrl({ url: 'javascript:alert(1)?{ref}' }, '1', 10000, 'CAD')).toBeNull();
  });
});

describe('invoices API', () => {
  let ctx;
  beforeEach(async () => { ctx = await makeApp(); });
  afterEach(async () => { await ctx.close(); });

  const H = () => auth(ctx.token);

  async function innovaTemplate(extra = {}) {
    const p = presets.OWNER_PRESETS['innova-cad'];
    const res = await ctx.request.post('/api/invoices/profiles').set(H())
      .send({ name: p.name, layout: p.layout, currency: p.currency, number_format: p.number_format, due_days: p.due_days, data: p.data, logo: PNG, signature: PNG, ...extra });
    expect(res.status).toBe(201);
    return res.body.profile;
  }

  test('templates: create, list without image bytes, image, update, default', async () => {
    const a = await innovaTemplate();
    expect(a.has_logo).toBe(true);
    expect(a.is_default).toBe(1);
    expect(a.logo).toBeUndefined();
    const b = await ctx.request.post('/api/invoices/profiles').set(H())
      .send({ name: 'Light', layout: 'light', currency: 'CAD', number_format: '{SEQ}', next_seq: 5, data: presets.BLANKS[1].data, is_default: true });
    expect(b.status).toBe(201);
    const list = await ctx.request.get('/api/invoices/profiles').set(H());
    expect(list.body.profiles.map((p) => p.name)).toEqual(['Light', a.name]);
    expect(JSON.stringify(list.body)).not.toContain('base64');
    const img = await ctx.request.get(`/api/invoices/profiles/${a.id}/image/logo`).set(H());
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const up = await ctx.request.put(`/api/invoices/profiles/${a.id}`).set(H()).send({ due_days: 15, logo: null });
    expect(up.body.profile.due_days).toBe(15);
    expect(up.body.profile.has_logo).toBe(false);
    const bad = await ctx.request.post('/api/invoices/profiles').set(H()).send({ name: 'x', logo: 'data:image/svg+xml;base64,PHN2Zz4=' });
    expect(bad.status).toBe(400);
  });

  test('invoice: auto number, totals, tax and terms from the template, pay link', async () => {
    const p = await innovaTemplate();
    const res = await ctx.request.post('/api/invoices').set(H()).send({
      profile_id: p.id, issue_date: '2026-08-03', client_name: 'MARYNA KARA INC.',
      client_details: '78 Meadowhawk Trail, Bradford', items: [{ description: 'Legal services', qty: 1, price: '1,500.00' }],
    });
    expect(res.status).toBe(201);
    const inv = res.body.invoice;
    expect(inv.number).toBe('03-08-26-1');
    expect(inv.due_date).toBe('2026-09-02');
    expect(inv.subtotal_cents).toBe(150000);
    expect(inv.tax_cents).toBe(19500);
    expect(inv.total_cents).toBe(169500);
    expect(inv.tax_label).toMatch(/HST/);
    expect(inv.pay_url).toBe('https://innovacg.com/en/invoice?ref=03-08-26-1&amount=1695&currency=CAD');
    expect(inv.status).toBe('draft');

    const second = await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, issue_date: '2026-08-03', items: [{ description: 'x', qty: 2, price: 10 }] });
    expect(second.body.invoice.number).toBe('03-08-26-2');
    const dup = await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, number: '03-08-26-1', items: [] });
    expect(dup.status).toBe(400);

    const nn = await ctx.request.get(`/api/invoices/next-number?profile_id=${p.id}&date=2026-08-03`).set(H());
    expect(nn.body.number).toBe('03-08-26-3');

    const list = await ctx.request.get('/api/invoices').set(H());
    expect(list.body.invoices).toHaveLength(2);
    expect(list.body.invoices[0].pay_url).toMatch(/^https:\/\/innovacg\.com/);
  });

  test('{SEQ} templates move their counter; status, duplicate, edit, delete', async () => {
    const p = await ctx.request.post('/api/invoices/profiles').set(H())
      .send({ name: 'OH', layout: 'light', currency: 'CAD', number_format: '{SEQ}', next_seq: 4, data: presets.OWNER_PRESETS['oh-catering'].data });
    const pid = p.body.profile.id;
    const a = await ctx.request.post('/api/invoices').set(H()).send({ profile_id: pid, client_name: 'Angela', items: [{ description: 'Deposit', qty: 18, price: 38.4 }] });
    expect(a.body.invoice.number).toBe('4');
    expect(a.body.invoice.total_cents).toBe(78106);
    const prof = await ctx.request.get(`/api/invoices/profiles/${pid}`).set(H());
    expect(prof.body.profile.next_seq).toBe(5);

    const id = a.body.invoice.id;
    const sent = await ctx.request.post(`/api/invoices/${id}/status`).set(H()).send({ status: 'sent' });
    expect(sent.body.invoice.status).toBe('sent');
    expect(sent.body.invoice.sent_at).toBeTruthy();
    const totals = await ctx.request.get('/api/invoices').set(H());
    expect(totals.body.totals.CAD.outstanding_cents).toBe(78106);
    const paid = await ctx.request.post(`/api/invoices/${id}/status`).set(H()).send({ status: 'paid' });
    expect(paid.body.invoice.paid_at).toBeTruthy();

    const copy = await ctx.request.post(`/api/invoices/${id}/duplicate`).set(H());
    expect(copy.status).toBe(201);
    expect(copy.body.invoice.number).toBe('5');
    expect(copy.body.invoice.status).toBe('draft');
    expect(copy.body.invoice.items[0].description).toBe('Deposit');

    const ed = await ctx.request.put(`/api/invoices/${copy.body.invoice.id}`).set(H()).send({ items: [{ description: 'Full', qty: 1, price: 100 }], tax_rate: 0 });
    expect(ed.body.invoice.total_cents).toBe(10000);
    expect(ed.body.invoice.number).toBe('5');

    await ctx.request.post(`/api/invoices/${id}/status`).set(H()).send({ status: 'void' });
    const voidEdit = await ctx.request.put(`/api/invoices/${id}`).set(H()).send({ notes: 'x' });
    expect(voidEdit.status).toBe(400);

    const del = await ctx.request.delete(`/api/invoices/${copy.body.invoice.id}`).set(H());
    expect(del.body.ok).toBe(true);
  });

  test('issued invoice keeps its template snapshot after the template changes', async () => {
    const p = await innovaTemplate();
    const inv = (await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, items: [{ description: 'a', qty: 1, price: 1 }] })).body.invoice;
    await ctx.request.post(`/api/invoices/${inv.id}/status`).set(H()).send({ status: 'sent' });
    const data = { ...p.data, seller: { ...p.data.seller, name: 'RENAMED LTD.' } };
    await ctx.request.put(`/api/invoices/profiles/${p.id}`).set(H()).send({ data });
    await ctx.request.put(`/api/invoices/${inv.id}`).set(H()).send({ notes: 'paid by wire' });
    const svc = require('../services/invoice/service');
    const row = await new Promise((r) => ctx.db.get('SELECT snapshot FROM invoices WHERE id = ?', [inv.id], (e, x) => r(x)));
    expect(JSON.parse(row.snapshot).data.seller.name).toBe('INNOVA CONSULT LTD');
    expect(svc).toBeTruthy();
  });

  test('another user cannot see or touch my templates and invoices', async () => {
    const p = await innovaTemplate();
    const inv = (await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, items: [{ description: 'a', qty: 1, price: 5 }] })).body.invoice;
    const other = await makeUser(ctx, 'mallory');
    const O = auth(other.token);
    expect((await ctx.request.get(`/api/invoices/${inv.id}`).set(O)).status).toBe(404);
    expect((await ctx.request.get(`/api/invoices/${inv.id}/pdf`).set(O)).status).toBe(404);
    expect((await ctx.request.put(`/api/invoices/${inv.id}`).set(O).send({ notes: 'x' })).status).toBe(404);
    expect((await ctx.request.delete(`/api/invoices/${inv.id}`).set(O)).status).toBe(404);
    expect((await ctx.request.post(`/api/invoices/${inv.id}/duplicate`).set(O)).status).toBe(404);
    expect((await ctx.request.get(`/api/invoices/profiles/${p.id}`).set(O)).status).toBe(404);
    expect((await ctx.request.get(`/api/invoices/profiles/${p.id}/image/logo`).set(O)).status).toBe(404);
    expect((await ctx.request.post(`/api/invoices/profiles/${p.id}/share`).set(O)).status).toBe(404);
    expect((await ctx.request.post('/api/invoices').set(O).send({ profile_id: p.id, items: [] })).status).toBe(404);
    expect((await ctx.request.get('/api/invoices').set(O)).body.invoices).toHaveLength(0);
    expect((await ctx.request.get('/api/invoices')).status).toBe(401);
  });

  test('PDF: a valid PDF with the Finman Online footer link', async () => {
    const p = await innovaTemplate();
    const inv = (await ctx.request.post('/api/invoices').set(H()).send({ profile_id: p.id, client_name: 'ACME', items: [{ description: 'Work', qty: 1, price: 100 }] })).body.invoice;
    const res = await ctx.request.get(`/api/invoices/${inv.id}/pdf?download=1`).set(H()).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Invoice_INNOVA_.*\.pdf"/);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    const txt = pdfText(res.body);
    expect(txt).toContain('utm_source=invoice');
    expect(txt).toContain('utm_campaign=invoice_footer');
    expect(txt).toMatch(/fm_ref=invite-[a-z0-9]+/);

    const prev = await ctx.request.post('/api/invoices/preview').set(H())
      .send({ profile_id: p.id, client_name: 'Preview', items: [{ description: 'x', qty: 1, price: 1 }] }).buffer(true).parse(binaryParser);
    expect(prev.status).toBe(200);
    expect(prev.body.slice(0, 5).toString()).toBe('%PDF-');
    expect((await ctx.request.get('/api/invoices').set(H())).body.invoices).toHaveLength(1);
  });

  test('every layout renders, including blank presets', async () => {
    const { renderInvoicePdf, FOOTER_TEXT } = require('../services/invoice/pdf');
    const svc = require('../services/invoice/service');
    expect(FOOTER_TEXT).toMatch(/Finman Online/);
    for (const p of [...Object.values(presets.OWNER_PRESETS), ...Object.values(presets.BLANKS)]) {
      const items = core.computeTotals([{ description: 'Line', qty: 2, price_cents: 12345 }], p.data.tax && p.data.tax.rate);
      const data = svc.mergeData(p.layout, p.data);
      const buf = await renderInvoicePdf({
        layout: p.layout, number: 'T-1', issue_date: '2026-11-13', due_date: '2026-11-20', currency: p.currency,
        client_name: 'Client', client_details: 'Street', ...items, tax_rate: data.tax.rate, tax_label: data.tax.label,
        tax_sub: data.tax.sub, tax_text: data.tax.text, terms: data.terms, data, logo: null, signature: null,
        seller_name: data.seller.name, pay_url: core.payUrl(data.pay_online, 'T-1', items.total_cents, p.currency),
      }, { url: 'https://app.finman.money/?signup' });
      expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    }
  });

  test('shared template: public preview, import once per user, copy is independent', async () => {
    const p = await innovaTemplate();
    const share = await ctx.request.post(`/api/invoices/profiles/${p.id}/share`).set(H());
    expect(share.body.code).toMatch(/^[a-z0-9]{10}$/);
    expect(share.body.url).toContain(`tpl=${share.body.code}`);
    expect(share.body.url).toContain('utm_source=invoice_template');

    const pub = await ctx.request.get(`/api/invoices/shared/${share.body.code}`);
    expect(pub.status).toBe(200);
    expect(pub.body.template.seller_name).toBe('INNOVA CONSULT LTD');
    expect(JSON.stringify(pub.body)).not.toContain('4101');
    expect((await ctx.request.get('/api/invoices/shared/nope123456')).status).toBe(404);

    const other = await makeUser(ctx, 'nastya');
    const O = auth(other.token);
    const imp = await ctx.request.post(`/api/invoices/shared/${share.body.code}/import`).set(O);
    expect(imp.status).toBe(201);
    expect(imp.body.profile.has_logo).toBe(true);
    expect(imp.body.profile.next_seq).toBe(1);
    const again = await ctx.request.post(`/api/invoices/shared/${share.body.code}/import`).set(O);
    expect(again.status).toBe(200);
    expect(again.body.profile.id).toBe(imp.body.profile.id);
    await ctx.request.put(`/api/invoices/profiles/${imp.body.profile.id}`).set(O).send({ name: 'Mine' });
    expect((await ctx.request.get(`/api/invoices/profiles/${p.id}`).set(H())).body.profile.name).toBe(p.name);
    expect((await ctx.request.post(`/api/invoices/shared/${share.body.code}/import`)).status).toBe(401);
  });

  test('presets list the blank starters only', async () => {
    const res = await ctx.request.get('/api/invoices/presets').set(H());
    expect(res.body.presets.map((p) => p.key).sort()).toEqual(['classic', 'light']);
    expect(JSON.stringify(res.body)).not.toContain('INNOVA');
  });

  test('activity journal names invoice actions', () => {
    const { eventFor } = require('../middleware/activity');
    expect(eventFor('POST', '/api/invoices', true)).toBe('invoice_created');
    expect(eventFor('POST', '/api/invoices/preview', true)).toBeNull();
    expect(eventFor('POST', '/api/invoices/profiles', true)).toBe('invoice_template_created');
    expect(eventFor('POST', '/api/invoices/shared/abc/import', true)).toBe('invoice_template_imported');
  });
});
