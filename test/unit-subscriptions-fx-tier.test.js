// test/unit-subscriptions-fx-tier.test.js — detection/conversion/gating logic
// with the DB and rate sources mocked:
//   - services/subscriptionDetector: frequency bands and the detectRecurring pipeline
//   - lib/fx: createConverter (rate cache, 1:1 fallback + missingRates, regroup/totals)
//   - middleware/requireTier: 401/402 gate, DB fallback
//   - lib/validateEnv: prod fail-fast vs dev warning
'use strict';

jest.mock('../db/database', () => ({
  query: jest.fn(async () => []),
  get: jest.fn(async () => null),
  run: jest.fn(async () => ({ changes: 0 })),
}));
jest.mock('../models/currency', () => ({ getRate: jest.fn() }));
jest.mock('../services/currencyService', () => ({ rateOrFallback: jest.fn() }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const db = require('../db/database');
const sd = require('../services/subscriptionDetector');
const { createConverter } = require('../lib/fx');
const Currency = require('../models/currency');
const currencyService = require('../services/currencyService');
const { requireTier, TIER_ORDER } = require('../middleware/requireTier');
const validateEnv = require('../lib/validateEnv');
const logger = require('../lib/logger');

// ---------------------------------------------------------------------------
describe('subscriptionDetector primitives', () => {
  test('classifyFrequency band edges', () => {
    const cycle = (g) => (sd.classifyFrequency(g) || {}).cycle || null;
    expect([5, 6, 9, 10].map(cycle)).toEqual([null, 'weekly', 'weekly', null]);
    expect([11, 12, 16, 17].map(cycle)).toEqual([null, 'biweekly', 'biweekly', null]);
    expect([24, 25, 35, 36].map(cycle)).toEqual([null, 'monthly', 'monthly', null]);
    expect([79, 80, 100, 101].map(cycle)).toEqual([null, 'quarterly', 'quarterly', null]);
    expect([329, 330, 400, 401].map(cycle)).toEqual([null, 'yearly', 'yearly', null]);
  });

  test('median handles empty, odd, even and does not mutate input', () => {
    const arr = [4, 1, 3, 2];
    expect(sd.median([])).toBe(0);
    expect(sd.median([3, 1, 2])).toBe(2);
    expect(sd.median(arr)).toBe(2.5);
    expect(arr).toEqual([4, 1, 3, 2]);
  });

  test('normalize drops digits/punctuation so card refs do not split a merchant', () => {
    expect(sd.normalize('NETFLIX.COM 866-579 #1234')).toBe('netflix com');
    expect(sd.normalize('Київстар *0931234567')).toBe('київстар');
    expect(sd.normalize(null)).toBe('');
  });
});

describe('subscriptionDetector.detectRecurring (mocked DB)', () => {
  const now = '2026-10-31';
  const tx = (date, amount, description, extra = {}) => ({ date, amount, description, category: 'Subs', currency: 'UAH', ...extra });

  function mockDb(txs, subs = []) {
    db.query.mockImplementation(async (sql) => (/FROM subscriptions/.test(sql) ? subs : txs));
  }

  afterEach(() => db.query.mockReset());

  test('monthly charges become a candidate with monthly cost, dates and latest description', async () => {
    mockDb([
      tx('2026-08-01', 199, 'NETFLIX 001'),
      tx('2026-09-01', 199, 'NETFLIX 002'),
      tx('2026-10-01', 209, 'NETFLIX 003'),
    ]);
    const { candidates, monthlyTotal } = await sd.detectRecurring(1, { now });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      normalizedKey: 'netflix',
      description: 'NETFLIX 003',
      amount: 199,
      billingCycle: 'monthly',
      occurrences: 3,
      firstDate: '2026-08-01',
      lastDate: '2026-10-01',
      currency: 'UAH',
      monthlyCost: 199,
    });
    expect(monthlyTotal).toBe(199);
  });

  test('weekly cost is scaled to a month; candidates sorted by monthly cost desc', async () => {
    mockDb([
      tx('2026-10-01', 10, 'Gym pass'), tx('2026-10-08', 10, 'Gym pass'), tx('2026-10-15', 10, 'Gym pass'),
      tx('2026-08-15', 30, 'Cloud'), tx('2026-09-15', 30, 'Cloud'), tx('2026-10-15', 30, 'Cloud'),
    ]);
    const { candidates, monthlyTotal } = await sd.detectRecurring(1, { now });
    expect(candidates.map((c) => c.normalizedKey)).toEqual(['gym pass', 'cloud']);
    expect(candidates[0]).toMatchObject({ billingCycle: 'weekly', monthlyCost: 43.45 });
    expect(monthlyTotal).toBe(73.45);
  });

  test('unstable amounts (>20% off median), irregular gaps and single charges are rejected', async () => {
    mockDb([
      tx('2026-08-01', 100, 'Groceries'), tx('2026-09-01', 300, 'Groceries'), tx('2026-10-01', 100, 'Groceries'),
      // median gap 30 but one gap of 10 is outside ±35%
      tx('2026-07-01', 50, 'Odd'), tx('2026-07-11', 50, 'Odd'), tx('2026-08-10', 50, 'Odd'), tx('2026-09-09', 50, 'Odd'),
      tx('2026-10-01', 999, 'Rent'),
    ]);
    const { candidates, monthlyTotal } = await sd.detectRecurring(1, { now });
    expect(candidates).toEqual([]);
    expect(monthlyTotal).toBe(0);
  });

  test('already-tracked active subscriptions are excluded by normalized name', async () => {
    mockDb(
      [tx('2026-09-01', 99, 'Spotify 1111'), tx('2026-10-01', 99, 'SPOTIFY #2222')],
      [{ name: 'Spotify' }]
    );
    const { candidates } = await sd.detectRecurring(1, { now });
    expect(candidates).toEqual([]);
  });

  test('lookback window is passed to SQL as a cutoff date relative to `now`', async () => {
    mockDb([]);
    await sd.detectRecurring(7, { now, lookbackDays: 30 });
    const txCall = db.query.mock.calls.find(([sql]) => /FROM transactions/.test(sql));
    expect(txCall[1]).toEqual([7, '2026-10-01']);
  });

  test('missing account currency falls back to the default currency', async () => {
    const def = require('../config/config').defaultCurrency;
    mockDb([tx('2026-09-01', 5, 'App', { currency: null }), tx('2026-10-01', 5, 'App', { currency: null })]);
    const { candidates } = await sd.detectRecurring(1, { now });
    expect(candidates[0].currency).toBe(def);
  });
});

// ---------------------------------------------------------------------------
describe('lib/fx createConverter (mocked rate sources)', () => {
  beforeEach(() => {
    Currency.getRate.mockReset();
    currencyService.rateOrFallback.mockReset();
  });

  test('same currency is 1:1 without any lookup; codes are case/space-insensitive', async () => {
    const fx = createConverter(' cad ');
    expect(fx.baseCurrency).toBe('CAD');
    expect(await fx.convert(12.345, 'cad')).toBe(12.35);
    expect(await fx.convert(10, null)).toBe(10); // null currency = already base
    expect(Currency.getRate).not.toHaveBeenCalled();
  });

  test('rates are looked up once per pair and cached', async () => {
    Currency.getRate.mockResolvedValue(0.033);
    const fx = createConverter('CAD');
    expect(await fx.convert(1000, 'UAH')).toBe(33);
    expect(await fx.convert(-500, 'uah')).toBe(-16.5);
    expect(Currency.getRate).toHaveBeenCalledTimes(1);
    expect(Currency.getRate).toHaveBeenCalledWith('UAH', 'CAD', null);
    expect(fx.missingRates).toEqual([]);
  });

  test('falls back to currencyService when the model has no rate', async () => {
    Currency.getRate.mockResolvedValue(null);
    currencyService.rateOrFallback.mockResolvedValue({ rate: 1.4 });
    const fx = createConverter('CAD', { date: '2026-01-15' });
    expect(await fx.convert(10, 'USD')).toBe(14);
    expect(currencyService.rateOrFallback).toHaveBeenCalledWith('USD', 'CAD', '2026-01-15');
  });

  test('missing / invalid / non-positive rate -> 1:1 and currency reported in missingRates', async () => {
    Currency.getRate.mockImplementation(async (from) => ({ EUR: 0, GBP: 'abc' }[from] ?? null));
    currencyService.rateOrFallback.mockImplementation(async (from) => (from === 'PLN' ? { rate: -2 } : null));
    const fx = createConverter('CAD');
    expect(await fx.convert(10, 'EUR')).toBe(10);
    expect(await fx.convert(10, 'GBP')).toBe(10);
    expect(await fx.convert(10, 'PLN')).toBe(10);
    expect(fx.missingRates.sort()).toEqual(['EUR', 'GBP', 'PLN']);
  });

  test('throwing rate sources degrade to the 1:1 fallback instead of failing', async () => {
    Currency.getRate.mockRejectedValue(new Error('db down'));
    currencyService.rateOrFallback.mockRejectedValue(new Error('net down'));
    const fx = createConverter('CAD');
    expect(await fx.convert(7, 'USD')).toBe(7);
    expect(fx.missingRates).toEqual(['USD']);
  });

  test('regroup merges per-currency rows by key, converts amounts, sums counts, keeps first-seen order', async () => {
    Currency.getRate.mockImplementation(async (from) => ({ USD: 1.5, UAH: 0.03 }[from]));
    const fx = createConverter('CAD');
    const rows = [
      { category: 'Food', currency: 'CAD', total: 10, n: 1, label: 'first' },
      { category: 'Rent', currency: 'UAH', total: 10000, n: 1 },
      { category: 'Food', currency: 'USD', total: 10, n: 2, label: 'second' },
    ];
    const out = await fx.regroup(rows, { keys: ['category'], amounts: ['total'], counts: ['n'] });
    expect(out).toEqual([
      { category: 'Food', total: 25, n: 3, label: 'first' },
      { category: 'Rent', total: 300, n: 1 },
    ]);
    // input untouched
    expect(rows[0]).toHaveProperty('currency', 'CAD');
  });

  test('totals returns zeroed fields for empty input', async () => {
    const fx = createConverter('CAD');
    expect(await fx.totals([], ['income', 'expense'], { counts: ['n'] })).toEqual({ income: 0, expense: 0, n: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('middleware/requireTier', () => {
  const run = async (mw, req) => {
    let arg = 'not-called';
    await mw(req, {}, (e) => { arg = e; });
    return arg;
  };

  beforeEach(() => db.get.mockReset());

  test('unknown tier is a programming error at definition time', () => {
    expect(() => requireTier('platinum')).toThrow(/unknown tier/);
    expect(Object.keys(TIER_ORDER)).toEqual(['free', 'pro', 'family']);
  });

  test('no user -> 401; lower tier -> 402; equal or higher -> next()', async () => {
    const pro = requireTier('pro');
    expect((await run(pro, {})).status).toBe(401);
    expect((await run(pro, { user: { id: null } })).status).toBe(401);
    const e = await run(pro, { user: { id: 1, subscription_tier: 'free' } });
    expect(e.status).toBe(402);
    expect(e.code).toBe('PAYMENT_REQUIRED');
    expect(await run(pro, { user: { id: 1, subscription_tier: 'pro' } })).toBeUndefined();
    expect(await run(pro, { user: { id: 1, subscription_tier: 'family' } })).toBeUndefined();
    expect((await run(requireTier('family'), { user: { id: 1, subscription_tier: 'pro' } })).status).toBe(402);
  });

  test('unknown tier on the user counts as free', async () => {
    expect((await run(requireTier('pro'), { user: { id: 1, subscription_tier: 'gold' } })).status).toBe(402);
    expect(await run(requireTier('free'), { user: { id: 1, subscription_tier: 'gold' } })).toBeUndefined();
  });

  test('tier missing on req.user is loaded from DB and cached on the request', async () => {
    db.get.mockResolvedValue({ subscription_tier: 'family' });
    const req = { user: { id: 9 } };
    expect(await run(requireTier('pro'), req)).toBeUndefined();
    expect(db.get).toHaveBeenCalledWith(expect.stringMatching(/subscription_tier FROM users/), [9]);
    expect(req.user.subscription_tier).toBe('family');
  });

  test('DB failure while resolving tier degrades to free (402), not 500', async () => {
    db.get.mockRejectedValue(new Error('no such column'));
    expect((await run(requireTier('pro'), { user: { id: 9 } })).status).toBe(402);
  });
});

// ---------------------------------------------------------------------------
describe('lib/validateEnv', () => {
  const good = { JWT_SECRET: 'j'.repeat(40), SESSION_SECRET: 's'.repeat(40), ENCRYPTION_KEY: 'e'.repeat(64) };

  beforeEach(() => { logger.warn.mockClear(); logger.error.mockClear(); });

  test('all secrets present -> ok', () => {
    expect(validateEnv({ ...good, NODE_ENV: 'production' })).toEqual({ ok: true, missing: [] });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('production: missing, blank or change-me placeholder secrets throw and name the keys', () => {
    const env = { ...good, NODE_ENV: 'production', JWT_SECRET: '   ', SESSION_SECRET: 'Change-me-please' };
    delete env.ENCRYPTION_KEY;
    expect(() => validateEnv(env)).toThrow('JWT_SECRET, SESSION_SECRET, ENCRYPTION_KEY');
  });

  test('production: short secrets only warn', () => {
    expect(validateEnv({ ...good, NODE_ENV: 'production', JWT_SECRET: 'short' }).ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET'));
  });

  test('development: missing secrets warn and report instead of throwing', () => {
    const res = validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'change-me' });
    expect(res).toEqual({ ok: false, missing: ['JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY'] });
    expect(logger.warn).toHaveBeenCalled();
  });

  test('optional env vars are never required', () => {
    const res = validateEnv({ ...good, NODE_ENV: 'production' });
    expect(res.ok).toBe(true);
    for (const k of validateEnv.OPTIONAL_ENV) expect(validateEnv.REQUIRED_SECRETS).not.toContain(k);
  });
});
