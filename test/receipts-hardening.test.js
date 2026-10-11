// test/receipts-hardening.test.js — receipt -> transaction safety + vision gate.
//   - create-transaction is idempotent (409 on repeat, one row under concurrency);
//   - total must be > 0; receipt currency must match the account currency;
//   - unknown OCR currency stays NULL (= account currency);
//   - upload sends the image to LLM vision only for AI-opted-in users that pass the
//     /api/ai tier gate (Pro while billing is configured), tesseract otherwise.
const path = require('path');
const { makeApp } = require('./helpers/app');

const PROJECT_ROOT = path.join(__dirname, '..');
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('receipts: create-transaction safety', () => {
  let ctx;
  let db;
  let accCad;
  let accUsd;
  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    accCad = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'Chequing', 'CAD', 1000, 'checking']
    )).id;
    accUsd = (await db.run(
      'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
      [ctx.userId, 'US card', 'USD', 500, 'card']
    )).id;
  });
  afterAll(async () => ctx && ctx.close());

  const balance = async (id) => (await db.get('SELECT balance FROM accounts WHERE id = ?', [id])).balance;
  const manual = async (body) => {
    const r = await ctx.request.post('/api/receipts/manual').set(auth(ctx.token)).send(body);
    expect(r.status).toBe(201);
    return r.body.id;
  };

  test('second create-transaction -> 409 with the existing id; balance charged once', async () => {
    const id = await manual({ merchant: 'Shop', total_amount: 10, currency: 'CAD', receipt_date: '2026-10-01' });
    const first = await ctx.request.post(`/api/receipts/${id}/create-transaction`).set(auth(ctx.token)).send({ account_id: accCad });
    expect(first.status).toBe(200);
    const again = await ctx.request.post(`/api/receipts/${id}/create-transaction`).set(auth(ctx.token)).send({ account_id: accCad });
    expect(again.status).toBe(409);
    expect(again.body.transaction_id).toBe(first.body.transaction_id);
    expect(await balance(accCad)).toBe(990);
  });

  test('concurrent create-transaction: exactly one succeeds, one transaction row', async () => {
    const before = await balance(accCad);
    const id = await manual({ merchant: 'Race', total_amount: 7.5, currency: 'CAD' });
    const results = await Promise.all(
      [1, 2, 3].map(() => ctx.request.post(`/api/receipts/${id}/create-transaction`).set(auth(ctx.token)).send({ account_id: accCad }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const rows = await db.query(`SELECT id FROM transactions WHERE description = 'Race'`);
    expect(rows).toHaveLength(1);
    expect(await balance(accCad)).toBe(Math.round((before - 7.5) * 100) / 100);
  });

  test('total 0 / missing -> 400, nothing written', async () => {
    const zero = await manual({ merchant: 'Zero', total_amount: 0, currency: 'CAD' });
    const res = await ctx.request.post(`/api/receipts/${zero}/create-transaction`).set(auth(ctx.token)).send({ account_id: accCad });
    expect(res.status).toBe(400);
    const none = await manual({ merchant: 'None', currency: 'CAD' });
    const res2 = await ctx.request.post(`/api/receipts/${none}/create-transaction`).set(auth(ctx.token)).send({ account_id: accCad });
    expect(res2.status).toBe(400);
    expect(await db.query(`SELECT id FROM transactions WHERE description IN ('Zero', 'None')`)).toHaveLength(0);
  });

  test('receipt currency differs from the account -> 400 CURRENCY_MISMATCH; matching account works', async () => {
    const before = await balance(accCad);
    const id = await manual({ merchant: 'NYC', total_amount: 20, currency: 'usd' });
    const bad = await ctx.request.post(`/api/receipts/${id}/create-transaction`).set(auth(ctx.token)).send({ account_id: accCad });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('CURRENCY_MISMATCH');
    expect(bad.body.message).toContain('USD');
    expect(bad.body.message).toContain('CAD');
    expect(await balance(accCad)).toBe(before);
    const ok = await ctx.request.post(`/api/receipts/${id}/create-transaction`).set(auth(ctx.token)).send({ account_id: accUsd });
    expect(ok.status).toBe(200);
    expect(await balance(accUsd)).toBe(480);
  });

  test('receipt without a currency books into any account (stored NULL, not a guessed default)', async () => {
    const id = await manual({ merchant: 'NoCur', total_amount: 5 });
    const row = await db.get('SELECT currency FROM receipts WHERE id = ?', [id]);
    expect(row.currency).toBeNull();
    const res = await ctx.request.post(`/api/receipts/${id}/create-transaction`).set(auth(ctx.token)).send({ account_id: accUsd });
    expect(res.status).toBe(200);
  });
});

describe('receipts upload: LLM vision only with AI opt-in + tier', () => {
  let ctx;
  let routeOcrService;
  let orig;
  let seen;
  const savedStripe = process.env.STRIPE_SECRET_KEY;
  beforeAll(async () => {
    ctx = await makeApp();
    routeOcrService = require(path.join(PROJECT_ROOT, 'services', 'ocrService'));
    orig = routeOcrService.processImage;
    routeOcrService.processImage = async (input, opts) => {
      seen = opts;
      return { ocr_status: 'completed', ocr_raw: 'x', merchant: 'M', total_amount: 1, currency: null, receipt_date: null, category: 'other', items: [] };
    };
  });
  afterAll(async () => {
    routeOcrService.processImage = orig;
    if (savedStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedStripe;
    if (ctx) await ctx.close();
  });
  const upload = () =>
    ctx.request.post('/api/receipts/upload').set(auth(ctx.token)).send({ image_data: 'data:image/png;base64,eA==' });
  const setUser = (sql) => require('../db/database').run(sql, [ctx.userId]);

  test('not opted in -> tesseract only (vision:false)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(seen).toMatchObject({ vision: false });
  });

  test('opted in, billing off -> vision allowed', async () => {
    await setUser('UPDATE users SET ai_opt_in = 1 WHERE id = ?');
    await upload();
    expect(seen).toMatchObject({ vision: true });
  });

  test('opted in, billing on: free tier -> no vision; pro -> vision', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    await setUser(`UPDATE users SET subscription_tier = 'free' WHERE id = ?`);
    await upload();
    expect(seen).toMatchObject({ vision: false });
    await setUser(`UPDATE users SET subscription_tier = 'pro' WHERE id = ?`);
    await upload();
    expect(seen).toMatchObject({ vision: true });
  });
});
