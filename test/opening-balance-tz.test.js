// test/opening-balance-tz.test.js — the opening balance row of a new account is
// dated «today» in the user's time zone (users.timezone, America/Toronto by
// default). Bug 13.11.2026: an account created at 21:30 in Toronto got
// tomorrow's UTC date.
const { makeApp } = require('./helpers/app');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });
// Only Date is faked: sqlite and supertest keep their real timers.
const REAL = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

describe('opening balance date follows the user time zone', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
  });

  afterEach(() => jest.useRealTimers());

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  async function openAt(iso, tz, name) {
    await db.run('UPDATE users SET timezone = ? WHERE id = ?', [tz, ctx.userId]);
    jest.useFakeTimers({ now: new Date(iso), doNotFake: REAL });
    const res = await ctx.request.post('/api/accounts').set(AUTH(ctx.token)).send({ name, balance: 100, currency: 'CAD' });
    jest.useRealTimers();
    expect(res.status).toBe(201);
    const row = await db.get("SELECT date FROM transactions WHERE account_id = ? AND type = 'opening'", [res.body.id]);
    return row.date;
  }

  test('Toronto evening (02:30 UTC next day) keeps the Toronto date', async () => {
    expect(await openAt('2026-11-14T02:30:00Z', 'America/Toronto', 'Evening')).toBe('2026-11-13');
  });

  test('Toronto morning is the same day in both zones', async () => {
    expect(await openAt('2026-11-13T14:00:00Z', 'America/Toronto', 'Morning')).toBe('2026-11-13');
  });

  test('another zone uses its own date (Kyiv is already on the next day)', async () => {
    expect(await openAt('2026-11-13T23:30:00Z', 'Europe/Kyiv', 'Kyiv')).toBe('2026-11-14');
  });

  test('empty or broken timezone falls back to Toronto', async () => {
    expect(await openAt('2026-11-14T02:30:00Z', 'Not/AZone', 'Broken')).toBe('2026-11-13');
  });

  test('an explicit openingDate is kept as is', async () => {
    const Account = require('../models/account');
    const acc = await Account.createWithOpeningBalance({ userId: ctx.userId, name: 'Dated', balance: 50, openingDate: '2026-01-31' });
    const row = await db.get("SELECT date FROM transactions WHERE account_id = ? AND type = 'opening'", [acc.id]);
    expect(row.date).toBe('2026-01-31');
  });

  test('zero balance writes no opening row', async () => {
    const res = await ctx.request.post('/api/accounts').set(AUTH(ctx.token)).send({ name: 'Empty', balance: 0 });
    expect(res.status).toBe(201);
    const rows = await db.query('SELECT id FROM transactions WHERE account_id = ?', [res.body.id]);
    expect(rows).toEqual([]);
  });
});
