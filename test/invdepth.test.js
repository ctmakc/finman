// test/invdepth.test.js — investment depth (Ghostfolio gap):
//   - события (dividend/fee) влияют на чистый P&L;
//   - аллокация суммируется ~100%;
//   - FIRE-проекция возвращает конечное число лет;
//   - IDOR-guard на новых depth-роутах не регрессирует.
//
// investments router смонтирован в server.js -> используем makeApp-харнесс.
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('investment depth — events, allocation, FIRE', () => {
  let ctx, request, token, portfolioId, invA, invB;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    token = ctx.token;

    const p = await request.post('/api/investments/portfolios').set(auth(token)).send({ name: 'Depth PF', currency: 'USD' });
    portfolioId = p.body.id;

    // Актив A: 10 шт по 100, текущая 110 -> gross P&L = +100.
    const a = await request.post(`/api/investments/portfolios/${portfolioId}/investments`).set(auth(token))
      .send({ symbol: 'AAA', name: 'Asset A', type: 'stock', quantity: 10, buy_price: 100, current_price: 110, buy_date: '2026-01-01' });
    invA = a.body.id;

    // Актив B: 5 шт по 50, текущая 50 -> gross P&L = 0 (для аллокации).
    const b = await request.post(`/api/investments/portfolios/${portfolioId}/investments`).set(auth(token))
      .send({ symbol: 'BBB', name: 'Asset B', type: 'crypto', quantity: 5, buy_price: 50, current_price: 50, buy_date: '2026-01-01' });
    invB = b.body.id;
  });

  afterAll(async () => { if (ctx) await ctx.close(); });

  test('добавление дивиденда повышает чистый P&L (netProfitLoss), не трогая profitLoss', async () => {
    const before = await request.get(`/api/investments/portfolios/${portfolioId}`).set(auth(token));
    const baseProfit = before.body.totalProfitLoss;
    const baseNet = before.body.totalNetProfitLoss;

    const ev = await request.post(`/api/investments/investments/${invA}/events`).set(auth(token))
      .send({ type: 'dividend', amount: 25, date: '2026-02-01' });
    expect(ev.status).toBe(201);
    expect(ev.body.type).toBe('dividend');

    const after = await request.get(`/api/investments/portfolios/${portfolioId}`).set(auth(token));
    // profitLoss (по сделкам) не меняется; netProfitLoss растёт ровно на дивиденд.
    expect(after.body.totalProfitLoss).toBe(baseProfit);
    expect(after.body.totalNetProfitLoss).toBe(baseNet + 25);
    expect(after.body.totalDividends).toBe(25);
  });

  test('добавление комиссии (fee) понижает чистый P&L', async () => {
    const before = await request.get(`/api/investments/portfolios/${portfolioId}`).set(auth(token));
    const baseNet = before.body.totalNetProfitLoss;

    const ev = await request.post(`/api/investments/investments/${invA}/events`).set(auth(token))
      .send({ type: 'fee', amount: 10, date: '2026-02-02' });
    expect(ev.status).toBe(201);

    const after = await request.get(`/api/investments/portfolios/${portfolioId}`).set(auth(token));
    expect(after.body.totalNetProfitLoss).toBe(baseNet - 10);
    expect(after.body.totalEventFees).toBe(10);
  });

  test('per-investment calculateValue отражает дивиденды и event-комиссии', async () => {
    const list = await request.get(`/api/investments/portfolios/${portfolioId}/investments`).set(auth(token));
    const aHolding = list.body.find(h => h.symbol === 'AAA');
    // profitLoss = (110-100)*10 = 100 (комиссий по сделкам нет).
    expect(aHolding.profitLoss).toBe(100);
    expect(aHolding.dividends).toBe(25);
    expect(aHolding.eventFees).toBe(10);
    // netProfitLoss = 100 + 25 - 10 = 115.
    expect(aHolding.netProfitLoss).toBe(115);
  });

  test('событие split — информационное, на деньги не влияет', async () => {
    const before = await request.get(`/api/investments/portfolios/${portfolioId}`).set(auth(token));
    const baseNet = before.body.totalNetProfitLoss;
    const ev = await request.post(`/api/investments/investments/${invA}/events`).set(auth(token))
      .send({ type: 'split', note: '2:1' });
    expect(ev.status).toBe(201);
    const after = await request.get(`/api/investments/portfolios/${portfolioId}`).set(auth(token));
    expect(after.body.totalNetProfitLoss).toBe(baseNet);
  });

  test('некорректный тип события -> 400', async () => {
    const res = await request.post(`/api/investments/investments/${invA}/events`).set(auth(token))
      .send({ type: 'bogus', amount: 5 });
    expect(res.status).toBe(400);
  });

  test('денежное событие без суммы -> 400', async () => {
    const res = await request.post(`/api/investments/investments/${invA}/events`).set(auth(token))
      .send({ type: 'dividend' });
    expect(res.status).toBe(400);
  });

  test('GET events возвращает добавленные события', async () => {
    const res = await request.get(`/api/investments/investments/${invA}/events`).set(auth(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const types = res.body.map(e => e.type);
    expect(types).toContain('dividend');
    expect(types).toContain('fee');
  });

  test('аллокация: проценты по типу и по символу суммируются ~100%', async () => {
    const res = await request.get(`/api/investments/portfolios/${portfolioId}/allocation`).set(auth(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.byType)).toBe(true);
    expect(Array.isArray(res.body.bySymbol)).toBe(true);

    const sumType = res.body.byType.reduce((s, r) => s + r.percent, 0);
    const sumSymbol = res.body.bySymbol.reduce((s, r) => s + r.percent, 0);
    // Допускаем округление до 2 знаков на каждой строке.
    expect(Math.abs(sumType - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(sumSymbol - 100)).toBeLessThanOrEqual(1);

    // Конкретные веса: A=1100, B=250, итого 1350 -> A ~81.48%, B ~18.52%.
    const a = res.body.bySymbol.find(r => r.symbol === 'AAA');
    expect(a.value).toBe(1100);
    expect(a.percent).toBeGreaterThan(80);
    expect(a.percent).toBeLessThan(83);
  });

  test('аллокация пустого портфеля не падает (0 строк)', async () => {
    const empty = await request.post('/api/investments/portfolios').set(auth(token)).send({ name: 'Empty PF' });
    const res = await request.get(`/api/investments/portfolios/${empty.body.id}/allocation`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.byType).toEqual([]);
    expect(res.body.bySymbol).toEqual([]);
  });

  test('FIRE: возвращает конечное число лет при положительных взносах', async () => {
    const res = await request.get(`/api/investments/portfolios/${portfolioId}/fire?contribution=1000&rate=7&target=100000`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(Number.isFinite(res.body.years)).toBe(true);
    expect(res.body.years).toBeGreaterThan(0);
    expect(Number.isFinite(res.body.months)).toBe(true);
  });

  test('FIRE: цель уже достигнута -> 0 лет', async () => {
    const res = await request.get(`/api/investments/portfolios/${portfolioId}/fire?contribution=100&rate=5&target=1`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.years).toBe(0);
  });

  test('FIRE: rate как доля (0.07) эквивалентна процентам (7)', async () => {
    const asPct = await request.get(`/api/investments/portfolios/${portfolioId}/fire?contribution=500&rate=7&target=200000`).set(auth(token));
    const asFraction = await request.get(`/api/investments/portfolios/${portfolioId}/fire?contribution=500&rate=0.07&target=200000`).set(auth(token));
    expect(asPct.body.months).toBe(asFraction.body.months);
  });

  test('FIRE: недостижимая цель -> reachable=false, years=null', async () => {
    const res = await request.get(`/api/investments/portfolios/${portfolioId}/fire?contribution=0&rate=0&target=999999999`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(false);
    expect(res.body.years).toBeNull();
  });
});

describe('investment depth — IDOR guards not regressed', () => {
  let ctx, request, tokenA, tokenB, portfolioId, invId;

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
      ['attacker2', 'attacker2@example.com', hash, 'Attacker2']);
    tokenB = jwt.sign({ id: insB.id }, config.jwtSecret, { expiresIn: '1h' });

    const p = await request.post('/api/investments/portfolios').set(auth(tokenA)).send({ name: 'A depth PF' });
    portfolioId = p.body.id;
    const inv = await request.post(`/api/investments/portfolios/${portfolioId}/investments`).set(auth(tokenA))
      .send({ symbol: 'AAPL', name: 'Apple', type: 'stock', quantity: 1, buy_price: 100, buy_date: '2026-01-01' });
    invId = inv.body.id;
  });

  afterAll(async () => { if (ctx) await ctx.close(); });

  test('B не может добавить событие к активу A (no IDOR)', async () => {
    const res = await request.post(`/api/investments/investments/${invId}/events`).set(auth(tokenB))
      .send({ type: 'dividend', amount: 100 });
    expect([403, 404]).toContain(res.status);
  });

  test('B не видит аллокацию/FIRE/события портфеля A', async () => {
    expect([403, 404]).toContain((await request.get(`/api/investments/portfolios/${portfolioId}/allocation`).set(auth(tokenB))).status);
    expect([403, 404]).toContain((await request.get(`/api/investments/portfolios/${portfolioId}/fire?contribution=1&rate=1&target=1`).set(auth(tokenB))).status);
    expect([403, 404]).toContain((await request.get(`/api/investments/investments/${invId}/events`).set(auth(tokenB))).status);
  });

  test('owner A проходит свои depth-роуты (sanity)', async () => {
    expect((await request.get(`/api/investments/portfolios/${portfolioId}/allocation`).set(auth(tokenA))).status).toBe(200);
    expect((await request.post(`/api/investments/investments/${invId}/events`).set(auth(tokenA)).send({ type: 'dividend', amount: 5 })).status).toBe(201);
  });
});
