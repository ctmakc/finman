// test/goals-debts-validation.test.js — wave3b/be-en-semantics:
// POST /api/goals and /api/debts accept camelCase (public API docs) and
// snake_case (PWA) bodies; missing fields -> 400 with an English list.
const { makeApp } = require('./helpers/app');
const { normalizeBody, missingFields, missingFieldsMessage } = require('../lib/bodyFields');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('lib/bodyFields', () => {
  test('normalizeBody maps camelCase aliases to snake_case, snake wins', () => {
    const out = normalizeBody(
      { targetAmount: 100, target_amount: 200, dueDate: '2027-01-01', name: '' },
      { name: [], target_amount: ['targetAmount'], due_date: ['dueDate'] }
    );
    expect(out).toEqual({ target_amount: 200, due_date: '2027-01-01' });
  });

  test('missingFields / message', () => {
    const missing = missingFields({ name: 'x' }, ['name', 'target_amount']);
    expect(missing).toEqual(['target_amount']);
    expect(missingFieldsMessage(missing)).toBe('Missing required fields: target_amount');
  });
});

describe('POST /api/goals validation', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { if (ctx) await ctx.close(); });

  test('camelCase body is accepted', async () => {
    const res = await ctx.request
      .post('/api/goals')
      .set(AUTH(ctx.token))
      .send({ name: 'Trip', targetAmount: 3000, currentAmount: 250, targetDate: '2027-06-01', currency: 'CAD' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Trip', target_amount: 3000, current_amount: 250, target_date: '2027-06-01', currency: 'CAD' });
  });

  test('snake_case body is accepted; default currency CAD', async () => {
    const res = await ctx.request
      .post('/api/goals')
      .set(AUTH(ctx.token))
      .send({ name: 'Laptop', target_amount: '1500.5' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Laptop', target_amount: 1500.5, current_amount: 0, currency: 'CAD' });
  });

  test('missing fields -> 400 with an English list', async () => {
    const res = await ctx.request.post('/api/goals').set(AUTH(ctx.token)).send({ description: 'no name' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Missing required fields: name, target_amount');
    expect(res.body.missing).toEqual(['name', 'target_amount']);
    expect(res.body.message).not.toMatch(/[А-Яа-я]/);
  });

  test('non-positive target -> 400', async () => {
    const res = await ctx.request.post('/api/goals').set(AUTH(ctx.token)).send({ name: 'Zero', targetAmount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/positive/);
  });

  test('PUT accepts camelCase too', async () => {
    const created = await ctx.request.post('/api/goals').set(AUTH(ctx.token)).send({ name: 'Edit', targetAmount: 10 });
    const res = await ctx.request
      .put(`/api/goals/${created.body.id}`)
      .set(AUTH(ctx.token))
      .send({ targetAmount: 20, targetDate: '2027-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.target_amount).toBe(20);
    expect(res.body.target_date).toBe('2027-01-01');
  });
});

describe('POST /api/debts validation', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { if (ctx) await ctx.close(); });

  test('camelCase body is accepted (totalAmount, paidAmount, interestRate, startDate, dueDate)', async () => {
    const res = await ctx.request
      .post('/api/debts')
      .set(AUTH(ctx.token))
      .send({
        name: 'Car loan', type: 'loan', totalAmount: 20000, paidAmount: 5000, interestRate: 6.5,
        minimumPayment: 400, startDate: '2026-01-01', dueDate: '2029-01-01', currency: 'CAD',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Car loan', type: 'loan', amount: 20000, paid_amount: 5000, interest_rate: 6.5,
      start_date: '2026-01-01', due_date: '2029-01-01', currency: 'CAD', is_paid: 0,
    });
  });

  test('snake_case body (PWA) is accepted', async () => {
    const res = await ctx.request
      .post('/api/debts')
      .set(AUTH(ctx.token))
      .send({ name: 'Friend', type: 'owe_me', amount: 100, interest_rate: 0, start_date: '2026-10-01' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Friend', type: 'owe_me', amount: 100, paid_amount: 0, currency: 'CAD' });
  });

  test('missing fields -> 400 listing them in English', async () => {
    const res = await ctx.request.post('/api/debts').set(AUTH(ctx.token)).send({ name: 'Nothing' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Missing required fields: type, amount, start_date');
    expect(res.body.missing).toEqual(['type', 'amount', 'start_date']);
  });

  test('unknown type -> 400', async () => {
    const res = await ctx.request
      .post('/api/debts')
      .set(AUTH(ctx.token))
      .send({ name: 'X', type: 'weird', totalAmount: 10, startDate: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/type must be one of/);
  });

  test('paidAmount above amount -> 400', async () => {
    const res = await ctx.request
      .post('/api/debts')
      .set(AUTH(ctx.token))
      .send({ name: 'X', type: 'loan', totalAmount: 10, paidAmount: 11, startDate: '2026-01-01' });
    expect(res.status).toBe(400);
  });
});
