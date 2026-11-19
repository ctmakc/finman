// test/credits-fx-middleware.test.js — lib/fx converter (rate lookup, cache,
// fallback, regroup/totals), the auth/tier/ownership middleware and services/geo.
// Rates and the PAT service are mocked: no DB, no network.
'use strict';

jest.mock('../models/currency', () => ({ getRate: jest.fn() }));
jest.mock('../services/currencyService', () => ({ rateOrFallback: jest.fn() }));
jest.mock('../services/patService', () => ({ verify: jest.fn() }));

const Currency = require('../models/currency');
const currencyService = require('../services/currencyService');
const patService = require('../services/patService');
const fx = require('../lib/fx');
const { requireTier, TIER_ORDER } = require('../middleware/requireTier');
const { requireOwnership } = require('../middleware/authorize');
const patAuth = require('../middleware/patAuth');
const geo = require('../services/geo');

const RATES = { 'USD>CAD': 1.35, 'UAH>CAD': 0.033, 'EUR>CAD': 1.5 };

beforeEach(() => {
  jest.clearAllMocks();
  Currency.getRate.mockImplementation(async (f, t) => (RATES[`${f}>${t}`] ?? null));
  currencyService.rateOrFallback.mockResolvedValue(null);
});

describe('lib/fx.lookupRate', () => {
  test('primary table rate', async () => {
    await expect(fx.lookupRate('USD', 'CAD')).resolves.toBe(1.35);
    expect(currencyService.rateOrFallback).not.toHaveBeenCalled();
  });

  test('falls back to currencyService when the table has nothing (or throws)', async () => {
    Currency.getRate.mockRejectedValueOnce(new Error('db down'));
    currencyService.rateOrFallback.mockResolvedValueOnce({ rate: 0.92 });
    await expect(fx.lookupRate('CAD', 'EUR', '2026-01-01')).resolves.toBe(0.92);
    expect(currencyService.rateOrFallback).toHaveBeenCalledWith('CAD', 'EUR', '2026-01-01');
  });

  test('zero, negative, NaN or missing rates -> null', async () => {
    for (const bad of [0, -1, 'abc', null]) {
      Currency.getRate.mockResolvedValueOnce(bad);
      currencyService.rateOrFallback.mockResolvedValueOnce(bad === null ? null : { rate: bad });
      await expect(fx.lookupRate('XXX', 'CAD')).resolves.toBeNull();
    }
  });
});

describe('lib/fx.createConverter', () => {
  test('base currency is normalised; same currency is 1 with no lookup', async () => {
    const c = fx.createConverter(' cad ');
    expect(c.baseCurrency).toBe('CAD');
    await expect(c.rate('cad')).resolves.toBe(1);
    expect(Currency.getRate).not.toHaveBeenCalled();
  });

  test('convert rounds to cents; null currency means already in target; 0/garbage -> 0', async () => {
    const c = fx.createConverter('CAD');
    await expect(c.convert(100, 'USD')).resolves.toBe(135);
    await expect(c.convert(10.005, null)).resolves.toBe(10.01);
    await expect(c.convert(0, 'USD')).resolves.toBe(0);
    await expect(c.convert('abc', 'USD')).resolves.toBe(0);
    await expect(c.convert(3, 'CAD', 'USD')).resolves.toBe(3); // no USD rate from CAD -> 1:1
  });

  test('rates are cached per pair (one lookup per request)', async () => {
    const c = fx.createConverter('CAD');
    await Promise.all([c.convert(1, 'USD'), c.convert(2, 'usd'), c.convert(3, 'USD')]);
    expect(Currency.getRate).toHaveBeenCalledTimes(1);
  });

  test('missing rate falls back 1:1 and is reported once in missingRates', async () => {
    const c = fx.createConverter('CAD');
    await expect(c.convert(50, 'GBP')).resolves.toBe(50);
    await c.convert(5, 'GBP');
    expect(c.missingRates).toEqual(['GBP']);
  });

  test('regroup merges currency groups by key, converts amounts, sums counts, keeps first-seen order', async () => {
    const c = fx.createConverter('CAD');
    const out = await c.regroup(
      [
        { category: 'Food', currency: 'CAD', total: 10, n: 1, label: 'first' },
        { category: 'Rent', currency: 'UAH', total: 30000, n: 1 },
        { category: 'Food', currency: 'USD', total: 10, n: 2, label: 'second' },
      ],
      { keys: ['category'], amounts: ['total'], counts: ['n'] }
    );
    expect(out).toEqual([
      { category: 'Food', total: 23.5, n: 3, label: 'first' },
      { category: 'Rent', total: 990, n: 1 },
    ]);
  });

  test('totals sums everything into one row; empty input gives zeroed fields', async () => {
    const c = fx.createConverter('CAD');
    await expect(
      c.totals([{ currency: 'EUR', income: 100, expense: -20 }, { currency: 'CAD', income: 1, expense: 0 }], ['income', 'expense'])
    ).resolves.toEqual({ income: 151, expense: -30 });
    await expect(c.totals([], ['income'], { counts: ['n'] })).resolves.toEqual({ income: 0, n: 0 });
  });
});

function runMw(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      status(s) { this.statusCode = s; return this; },
      json(b) { resolve({ res: this, body: b, nextArg: undefined, nextCalled: false }); return this; },
    };
    mw(req, res, (arg) => resolve({ res, body: null, nextArg: arg, nextCalled: true }));
  });
}

describe('middleware/requireTier', () => {
  test('unknown tier name fails fast at mount time', () => {
    expect(() => requireTier('gold')).toThrow('unknown tier');
    expect(Object.keys(TIER_ORDER)).toEqual(['free', 'pro', 'family']);
  });

  test('401 without a user', async () => {
    const r = await runMw(requireTier('pro'), {});
    expect(r.nextArg).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  test('402 when the plan is lower; passes when equal or higher', async () => {
    const lower = await runMw(requireTier('pro'), { user: { id: 1, subscription_tier: 'free' } });
    expect(lower.nextArg).toMatchObject({ status: 402, code: 'PAYMENT_REQUIRED' });
    expect(lower.nextArg.message).toContain('"pro"');

    const equal = await runMw(requireTier('pro'), { user: { id: 1, subscription_tier: 'pro' } });
    expect(equal.nextCalled).toBe(true);
    expect(equal.nextArg).toBeUndefined();

    const higher = await runMw(requireTier('pro'), { user: { id: 1, subscription_tier: 'family' } });
    expect(higher.nextArg).toBeUndefined();
  });

  test('an unknown stored tier ranks as free', async () => {
    const r = await runMw(requireTier('pro'), { user: { id: 1, subscription_tier: 'platinum' } });
    expect(r.nextArg).toMatchObject({ status: 402 });
    const free = await runMw(requireTier('free'), { user: { id: 1, subscription_tier: 'platinum' } });
    expect(free.nextArg).toBeUndefined();
  });
});

describe('middleware/authorize.requireOwnership', () => {
  test('needs a loader function', () => {
    expect(() => requireOwnership()).toThrow('loadResource');
  });

  test('401 / 404 / 403 / pass-through with req.resource', async () => {
    const loader = jest.fn();
    const mw = requireOwnership(loader);

    expect((await runMw(mw, {})).nextArg).toMatchObject({ status: 401 });

    loader.mockResolvedValueOnce(null);
    expect((await runMw(mw, { user: { id: 1 } })).nextArg).toMatchObject({ status: 404, code: 'NOT_FOUND' });

    loader.mockResolvedValueOnce({ id: 9, user_id: 2 });
    expect((await runMw(mw, { user: { id: 1 } })).nextArg).toMatchObject({ status: 403, code: 'FORBIDDEN' });

    const req = { user: { id: '7' } };
    loader.mockResolvedValueOnce({ id: 9, user_id: 7 });
    const ok = await runMw(mw, req);
    expect(ok.nextArg).toBeUndefined();
    expect(req.resource).toEqual({ id: 9, user_id: 7 }); // string vs number id compared numerically
  });

  test('loader errors are forwarded to next(err)', async () => {
    const boom = new Error('db');
    const r = await runMw(requireOwnership(async () => { throw boom; }), { user: { id: 1 } });
    expect(r.nextArg).toBe(boom);
  });
});

describe('middleware/patAuth', () => {
  test('no / malformed Authorization header -> 401 NO_TOKEN', async () => {
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer    ' }]) {
      const r = await runMw(patAuth, { headers });
      expect(r.res.statusCode).toBe(401);
      expect(r.body).toEqual({ success: false, error: { code: 'NO_TOKEN', message: 'Personal access token required' } });
    }
    expect(patService.verify).not.toHaveBeenCalled();
  });

  test('revoked/unknown token -> 401 INVALID_TOKEN', async () => {
    patService.verify.mockResolvedValueOnce(null);
    const r = await runMw(patAuth, { headers: { authorization: 'Bearer finman_pat_x' } });
    expect(r.res.statusCode).toBe(401);
    expect(r.body.error.code).toBe('INVALID_TOKEN');
  });

  test('valid token sets req.user; scheme is case-insensitive and token trimmed', async () => {
    patService.verify.mockResolvedValueOnce(42);
    const req = { headers: { authorization: 'bearer   finman_pat_abc  ' } };
    const r = await runMw(patAuth, req);
    expect(r.nextCalled).toBe(true);
    expect(patService.verify).toHaveBeenCalledWith('finman_pat_abc');
    expect(req.user).toEqual({ id: 42 });
  });

  test('user id 0 is still a valid user (only null/undefined are rejected)', async () => {
    patService.verify.mockResolvedValueOnce(0);
    const req = { headers: { authorization: 'Bearer t' } };
    const r = await runMw(patAuth, req);
    expect(r.nextCalled).toBe(true);
    expect(req.user).toEqual({ id: 0 });
  });

  test('service errors go to next(err)', async () => {
    const boom = new Error('x');
    patService.verify.mockRejectedValueOnce(boom);
    const r = await runMw(patAuth, { headers: { authorization: 'Bearer t' } });
    expect(r.nextArg).toBe(boom);
  });
});

describe('services/geo', () => {
  const OLD = process.env.GEO_DB_DIR;
  afterAll(() => {
    if (OLD === undefined) delete process.env.GEO_DB_DIR;
    else process.env.GEO_DB_DIR = OLD;
    geo.reset();
  });

  test('cleanIp strips the IPv4-mapped prefix and whitespace', () => {
    expect(geo.cleanIp(' ::ffff:8.8.8.8 ')).toBe('8.8.8.8');
    expect(geo.cleanIp('2001:db8::1')).toBe('2001:db8::1');
    expect(geo.cleanIp(null)).toBe('');
  });

  test('geoDir: env override, else <dir of DATABASE_PATH>/geo', () => {
    process.env.GEO_DB_DIR = '/tmp/geo-x';
    expect(geo.geoDir()).toBe('/tmp/geo-x');
    delete process.env.GEO_DB_DIR;
    const prev = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = '/srv/data/finance.db';
    expect(geo.geoDir()).toBe('/srv/data/geo');
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
  });

  test('private / empty IPs and a missing database give {} without throwing', () => {
    process.env.GEO_DB_DIR = '/nonexistent-geo-dir-for-test';
    geo.reset();
    for (const ip of ['', '10.0.0.1', '127.0.0.1', '192.168.1.5', '172.20.0.1', '::1', 'fd00::1', '8.8.8.8']) {
      expect(geo.lookup(ip)).toEqual({});
    }
  });
});
