// Unit tests for lib/fx.createConverter: rate lookup, caching, fallback,
// missingRates, convert/regroup/totals. Currency sources are mocked (offline).
'use strict';

jest.mock('../models/currency', () => ({ getRate: jest.fn() }));
jest.mock('../services/currencyService', () => ({ rateOrFallback: jest.fn() }));

const Currency = require('../models/currency');
const currencyService = require('../services/currencyService');
const { createConverter, lookupRate } = require('../lib/fx');

const RATES = { 'UAH>CAD': 0.033, 'USD>CAD': 1.37, 'EUR>UAH': 45 };

beforeEach(() => {
  Currency.getRate.mockReset();
  currencyService.rateOrFallback.mockReset();
  Currency.getRate.mockImplementation(async (f, t) => (RATES[`${f}>${t}`] ?? null));
  currencyService.rateOrFallback.mockResolvedValue(null);
});

describe('lookupRate', () => {
  test('primary source wins', async () => {
    expect(await lookupRate('USD', 'CAD')).toBe(1.37);
    expect(currencyService.rateOrFallback).not.toHaveBeenCalled();
  });

  test('falls back to currencyService when the model has no rate or throws', async () => {
    currencyService.rateOrFallback.mockResolvedValue({ rate: '0.68' });
    expect(await lookupRate('GBP', 'USD')).toBe(0.68);
    Currency.getRate.mockRejectedValueOnce(new Error('db'));
    expect(await lookupRate('USD', 'CAD')).toBe(0.68);
  });

  test('zero, negative, NaN and failing fallbacks give null', async () => {
    Currency.getRate.mockResolvedValue(0);
    expect(await lookupRate('A', 'B')).toBeNull();
    Currency.getRate.mockResolvedValue(-2);
    expect(await lookupRate('A', 'B')).toBeNull();
    Currency.getRate.mockResolvedValue('abc');
    currencyService.rateOrFallback.mockRejectedValue(new Error('net'));
    expect(await lookupRate('A', 'B')).toBeNull();
  });

  test('passes the date through (null when absent)', async () => {
    await lookupRate('USD', 'CAD', '2026-01-31');
    expect(Currency.getRate).toHaveBeenLastCalledWith('USD', 'CAD', '2026-01-31');
    await lookupRate('USD', 'CAD');
    expect(Currency.getRate).toHaveBeenLastCalledWith('USD', 'CAD', null);
  });
});

describe('createConverter', () => {
  test('normalises base currency and treats same-currency as 1 without lookup', async () => {
    const fx = createConverter(' cad ');
    expect(fx.baseCurrency).toBe('CAD');
    expect(await fx.rate('cad')).toBe(1);
    expect(Currency.getRate).not.toHaveBeenCalled();
  });

  test('convert multiplies and rounds to 2dp; null currency means already in target', async () => {
    const fx = createConverter('CAD');
    expect(await fx.convert(4000, 'UAH')).toBe(132);
    expect(await fx.convert(10.005, null)).toBe(10.01);
    expect(await fx.convert('abc', 'USD')).toBe(0);
    expect(await fx.convert(0, 'USD')).toBe(0);
  });

  test('explicit target currency', async () => {
    const fx = createConverter('CAD');
    expect(await fx.convert(2, 'EUR', 'UAH')).toBe(90);
  });

  test('rates are looked up once per pair (cached, even concurrently)', async () => {
    const fx = createConverter('CAD');
    await Promise.all([fx.convert(1, 'USD'), fx.convert(2, 'usd'), fx.convert(3, 'USD')]);
    expect(Currency.getRate).toHaveBeenCalledTimes(1);
  });

  test('missing rate falls back to 1:1 and is reported once', async () => {
    const fx = createConverter('CAD');
    expect(await fx.convert(50, 'XYZ')).toBe(50);
    expect(await fx.convert(25, 'xyz')).toBe(25);
    expect(fx.missingRates).toEqual(['XYZ']);
  });

  test('regroup merges per-currency rows by key, converting amounts and summing counts', async () => {
    const fx = createConverter('CAD');
    const rows = [
      { category: 'Food', currency: 'CAD', total: 10, n: 1, label: 'first' },
      { category: 'Rent', currency: 'USD', total: 100, n: 1 },
      { category: 'Food', currency: 'UAH', total: 1000, n: 3, label: 'second' },
    ];
    const out = await fx.regroup(rows, { keys: ['category'], amounts: ['total'], counts: ['n'] });
    expect(out).toEqual([
      { category: 'Food', total: 43, n: 4, label: 'first' },
      { category: 'Rent', total: 137, n: 1 },
    ]);
    // input rows are not mutated
    expect(rows[0].currency).toBe('CAD');
  });

  test('regroup with a custom currency field', async () => {
    const fx = createConverter('CAD');
    const out = await fx.regroup([{ m: '2026-01', ccy: 'USD', amt: 10 }], { keys: ['m'], amounts: ['amt'], currencyField: 'ccy' });
    expect(out).toEqual([{ m: '2026-01', amt: 13.7 }]);
  });

  test('totals sums everything into one row, empty input -> zeros', async () => {
    const fx = createConverter('CAD');
    const t = await fx.totals(
      [{ currency: 'USD', income: 100, expense: 0 }, { currency: 'CAD', income: 0, expense: 20.5 }],
      ['income', 'expense']
    );
    expect(t).toEqual({ income: 137, expense: 20.5 });
    expect(await fx.totals([], ['income'], { counts: ['n'] })).toEqual({ income: 0, n: 0 });
    expect(await fx.totals(null, ['income'])).toEqual({ income: 0 });
  });
});
