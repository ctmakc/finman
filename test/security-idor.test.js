// test/security-idor.test.js — кросс-юзерный доступ к split/investments запрещён.
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

describe('IDOR — cross-user access is denied (split + investments)', () => {
  let ctx, request, tokenA, tokenB;
  let groupId, portfolioId, investmentId;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    tokenA = ctx.token;

    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcrypt');
    const config = require('../config/config');
    const hash = await bcrypt.hash('password123', 10);
    const insB = await dbRun(ctx.db,
      'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)',
      ['attacker', 'attacker@example.com', hash, 'Attacker']);
    tokenB = jwt.sign({ id: insB.id }, config.jwtSecret, { expiresIn: '1h' });

    const auth = (t) => ({ Authorization: `Bearer ${t}` });
    const g = await request.post('/api/split/groups').set(auth(tokenA)).send({ name: 'A private group' });
    groupId = g.body.id;
    const p = await request.post('/api/investments/portfolios').set(auth(tokenA)).send({ name: 'A portfolio' });
    portfolioId = p.body.id;
    const inv = await request.post(`/api/investments/portfolios/${portfolioId}/investments`).set(auth(tokenA))
      .send({ symbol: 'AAPL', name: 'Apple', type: 'stock', quantity: 1, buy_price: 100, buy_date: '2026-01-01' });
    investmentId = inv.body.id;
  });

  afterAll(async () => { if (ctx) await ctx.close(); });

  test('owner A reaches own resources (sanity)', async () => {
    const a = (t) => ({ Authorization: `Bearer ${t}` });
    expect((await request.get(`/api/split/groups/${groupId}`).set(a(tokenA))).status).toBe(200);
    expect((await request.get(`/api/investments/portfolios/${portfolioId}/investments`).set(a(tokenA))).status).toBe(200);
    expect(groupId).toBeTruthy();
    expect(investmentId).toBeTruthy();
  });

  test('B cannot READ A split group / members / expenses / balances / settlements', async () => {
    const paths = [
      `/api/split/groups/${groupId}`,
      `/api/split/groups/${groupId}/stats`,
      `/api/split/groups/${groupId}/members`,
      `/api/split/groups/${groupId}/expenses`,
      `/api/split/groups/${groupId}/balances`,
      `/api/split/groups/${groupId}/settlements`,
    ];
    for (const path of paths) {
      const res = await request.get(path).set({ Authorization: `Bearer ${tokenB}` });
      expect([403, 404]).toContain(res.status);
    }
  });

  test('B cannot MODIFY A split group or add to it', async () => {
    expect([403, 404]).toContain((await request.put(`/api/split/groups/${groupId}`)
      .set({ Authorization: `Bearer ${tokenB}` }).send({ name: 'hacked' })).status);
    expect([403, 404]).toContain((await request.post(`/api/split/groups/${groupId}/members`)
      .set({ Authorization: `Bearer ${tokenB}` }).send({ name: 'evil' })).status);
  });

  test('B cannot READ/MODIFY/SELL A investments', async () => {
    expect([403, 404]).toContain((await request.get(`/api/investments/portfolios/${portfolioId}/investments`)
      .set({ Authorization: `Bearer ${tokenB}` })).status);
    expect([403, 404]).toContain((await request.put(`/api/investments/investments/${investmentId}`)
      .set({ Authorization: `Bearer ${tokenB}` }).send({ notes: 'x' })).status);
    expect([403, 404]).toContain((await request.post(`/api/investments/investments/${investmentId}/sell`)
      .set({ Authorization: `Bearer ${tokenB}` }).send({ quantity: 1, price: 200 })).status);
  });
});
