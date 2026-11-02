// test/regression-budget-validation.test.js — POST/PUT /api/budgets input checks.
//
// Before: amount "abc" -> 500 (NaN hit the NOT NULL column), amount "1e400"
// -> 201 with an Infinity/0 budget, carryover "x" silently became 0, PUT took
// any period, and any currency string (e.g. "<b>") was stored and rendered.

const { makeApp } = require('./helpers/app');

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

describe('budgets: amount / carryover / period / currency validation', () => {
  let ctx;
  let h;
  beforeAll(async () => {
    ctx = await makeApp();
    h = AUTH(ctx.token);
  });
  afterAll(async () => ctx && ctx.close());

  test.each([
    [{ name: 'a', amount: 'abc' }, /amount/i],
    [{ name: 'b', amount: '1e400' }, /amount/i],
    [{ name: 'c', amount: [5] }, /amount/i],
    [{ name: 'd', amount: true }, /amount/i],
    [{ name: 'e', amount: -1 }, /amount/i],
    [{ name: 'f', amount: 0 }, /amount/i],
    [{ name: 'g', amount: 100, carryover: 'x' }, /carryover/i],
    [{ name: 'h', amount: 100, currency: '<b>' }, /currency/i],
    [{ name: 'i', amount: 100, currency: 'US$' }, /currency/i],
    [{ name: 'j', amount: 100, period: 'hourly' }, /period/i],
  ])('POST %j -> 400', async (body, message) => {
    const res = await ctx.request.post('/api/budgets').set(h).send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  test('nothing invalid was stored', async () => {
    const res = await ctx.request.get('/api/budgets?includeInactive=true').set(h);
    expect(res.body).toEqual([]);
  });

  test('valid input still works: numeric strings, lower-case currency, empty carryover', async () => {
    const res = await ctx.request
      .post('/api/budgets')
      .set(h)
      .send({ name: 'Food', amount: '250.50', currency: 'eur', carryover: '', period: 'weekly' });
    expect(res.status).toBe(201);
    expect(res.body.budget).toMatchObject({ amount: 250.5, currency: 'EUR', carryover: 0, effectiveLimit: 250.5 });
  });

  test('PUT rejects the same bad values and keeps the stored budget', async () => {
    const created = await ctx.request.post('/api/budgets').set(h).send({ name: 'Fun', amount: 100 });
    const id = created.body.budget.id;
    for (const body of [{ amount: 'abc' }, { amount: '1e400' }, { carryover: 'x' }, { period: 'hourly' }, { currency: '<b>' }]) {
      const res = await ctx.request.put(`/api/budgets/${id}`).set(h).send(body);
      expect(res.status).toBe(400);
    }
    const ok = await ctx.request.put(`/api/budgets/${id}`).set(h).send({ amount: '120', carryover: 15.5, currency: 'usd' });
    expect(ok.status).toBe(200);
    expect(ok.body.budget).toMatchObject({ amount: 120, carryover: 15.5, currency: 'USD', effectiveLimit: 135.5 });
    const reset = await ctx.request.put(`/api/budgets/${id}`).set(h).send({ carryover: null });
    expect(reset.status).toBe(200);
    expect(reset.body.budget.carryover).toBe(0);
  });
});
