// test/regression-custom-bank-url.test.js — custom bank apiUrl was checked
// with new URL() only, which accepts javascript:, data: and file: URLs.

const { makeApp } = require('./helpers/app');

describe('custom banks: apiUrl must be http(s)', () => {
  let ctx;
  let h;
  beforeAll(async () => {
    ctx = await makeApp();
    h = { Authorization: `Bearer ${ctx.token}` };
  });
  afterAll(async () => ctx && ctx.close());

  test.each([['javascript:alert(1)'], ['data:text/html,<b>x</b>'], ['file:///etc/passwd'], ['ftp://bank.example'], ['not a url']])(
    'POST rejects %s',
    async (apiUrl) => {
      const res = await ctx.request.post('/api/bank-api/custom-banks').set(h).send({ name: `B ${apiUrl}`, country: 'ca', apiUrl });
      expect(res.status).toBe(400);
    }
  );

  test('https URL is accepted; PUT applies the same rule', async () => {
    const created = await ctx.request
      .post('/api/bank-api/custom-banks')
      .set(h)
      .send({ name: 'Good Bank', country: 'ca', apiUrl: 'https://api.bank.example/v1' });
    expect(created.status).toBe(201);
    const id = created.body.bank.id;
    const bad = await ctx.request.put(`/api/bank-api/custom-banks/${id}`).set(h).send({ apiUrl: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    const good = await ctx.request.put(`/api/bank-api/custom-banks/${id}`).set(h).send({ apiUrl: 'http://localhost:9999/api' });
    expect(good.status).toBe(200);
  });
});
