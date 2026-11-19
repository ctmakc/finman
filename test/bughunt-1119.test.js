// Regression tests for credits/repo-bughunt-1119-0102 fixes (offline, DB mocked).
const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('events');

describe('GET /api/t/unsubscribe: multibyte token must not throw', () => {
  let app, run;
  beforeAll(() => {
    jest.resetModules();
    run = jest.fn().mockResolvedValue({});
    jest.doMock('../db/database', () => ({ run }));
    jest.doMock('../services/tracker', () => ({ track: jest.fn(), clientIp: () => '127.0.0.1' }));
    const { router, unsubToken } = require('../routes/track');
    app = express(); app.use('/api/t', router);
    app.locals.tok = unsubToken;
  });
  test('32 chars / 33 bytes -> 400, no crash', async () => {
    const t = encodeURIComponent('é' + 'a'.repeat(31));
    const r = await request(app).get(`/api/t/unsubscribe?u=1&t=${t}`);
    expect(r.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  test('valid token still works', async () => {
    const r = await request(app).get(`/api/t/unsubscribe?u=7&t=${app.locals.tok(7)}`);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalledWith(expect.stringContaining('lifecycle_opt_out'), [7]);
  });
});

describe('PUT /api/recurring/:id checks BOTH accountId and account_id', () => {
  let app, update;
  beforeAll(() => {
    jest.resetModules();
    update = jest.fn().mockResolvedValue(true);
    jest.doMock('passport', () => ({ authenticate: () => (req, _res, next) => { req.user = { id: 1 }; next(); } }));
    jest.doMock('../models/account', () => ({ findById: jest.fn(async (id, uid) => (Number(id) === 10 && uid === 1 ? { id: 10 } : null)) }));
    jest.doMock('../models/recurringPayment', () => ({ update, findById: jest.fn(async () => ({ id: 5 })) }));
    const router = require('../routes/recurring');
    app = express(); app.use(express.json()); app.use('/api/recurring', router.router || router);
  });
  test('own accountId + foreign account_id -> 404, nothing written', async () => {
    const r = await request(app).put('/api/recurring/5').send({ accountId: 10, account_id: 99 });
    expect(r.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });
  test('own account only -> updated', async () => {
    const r = await request(app).put('/api/recurring/5').send({ accountId: 10 });
    expect(r.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});

describe('Currency.fetchRatesFromNBU: non-JSON body rejects instead of crashing', () => {
  test('HTML error page -> handled', async () => {
    jest.resetModules();
    jest.doMock('../db/database', () => ({ query: jest.fn(), get: jest.fn(), run: jest.fn() }));
    jest.doMock('https', () => ({
      get: (_url, cb) => {
        const res = new EventEmitter(); const req = new EventEmitter();
        process.nextTick(() => { cb(res); res.emit('data', '<html>502</html>'); res.emit('end'); });
        return req;
      },
    }));
    const Currency = require('../models/currency');
    const onUncaught = jest.fn();
    process.on('uncaughtException', onUncaught);
    let outcome;
    try { outcome = await Currency.fetchRatesFromNBU(); } catch (e) { outcome = e; }
    await new Promise(r => setImmediate(r));
    process.removeListener('uncaughtException', onUncaught);
    expect(onUncaught).not.toHaveBeenCalled();
    expect(outcome).toBeDefined();
  });
});
