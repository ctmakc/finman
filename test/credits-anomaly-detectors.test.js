// Unit tests for anomalyService pure detectors (amount outliers, duplicate charges).
'use strict';

jest.mock('../db/database', () => ({ query: jest.fn(), get: jest.fn() }));

const { _internals } = require('../services/anomalyService');
const { detectAmountOutliers, detectDuplicates, DEFAULTS } = _internals;

const cfg = { ...DEFAULTS };
const exp = (id, amount, extra = {}) => ({ id, amount, type: 'expense', category: 'Food', date: '2026-10-01', ...extra });

describe('detectAmountOutliers', () => {
  test('flags a z-score outlier within its category', () => {
    const txs = [];
    for (let i = 1; i <= 20; i++) txs.push(exp(i, -(10 + (i % 3))));
    txs.push(exp(99, -500));
    const out = detectAmountOutliers(txs, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ transactionId: 99, type: 'amount_outlier', category: 'Food', amount: -500 });
    expect(out[0].zScore).toBeGreaterThanOrEqual(3);
    expect(['low', 'medium', 'high']).toContain(out[0].severity);
  });

  test('categories with fewer than minSamplesForStats rows are skipped', () => {
    const txs = [exp(1, -10), exp(2, -10), exp(3, -1000)];
    expect(detectAmountOutliers(txs, cfg)).toEqual([]);
  });

  test('income, transfers and opening balances are ignored when expenseOnly', () => {
    const txs = [];
    for (let i = 1; i <= 10; i++) txs.push(exp(i, -10));
    txs.push({ id: 50, amount: 100000, type: 'income', category: 'Food' });
    txs.push({ id: 51, amount: -100000, type: 'opening', category: 'Food' });
    expect(detectAmountOutliers(txs, cfg)).toEqual([]);
  });

  test('uncategorized rows are grouped together and reported with category null', () => {
    const txs = [];
    for (let i = 1; i <= 20; i++) txs.push(exp(i, -10 - (i % 2), { category: null }));
    txs.push(exp(77, -900, { category: null }));
    const out = detectAmountOutliers(txs, cfg);
    expect(out.map((a) => a.transactionId)).toEqual([77]);
    expect(out[0].category).toBeNull();
    expect(out[0].reason).toMatch(/uncategorized/);
  });

  test('identical amounts produce no anomalies', () => {
    const txs = [1, 2, 3, 4, 5].map((i) => exp(i, -25));
    expect(detectAmountOutliers(txs, cfg)).toEqual([]);
  });
});

describe('detectDuplicates', () => {
  test('same merchant + amount within the window flags the later one', () => {
    const txs = [
      exp(1, -9.99, { description: 'Netflix', date: '2026-10-01' }),
      exp(2, -9.99, { description: ' NETFLIX ', date: '2026-10-02' }),
    ];
    const out = detectDuplicates(txs, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ transactionId: 2, duplicateOf: 1, severity: 'high', type: 'duplicate_charge' });
  });

  test('2-3 days apart is medium, beyond the window is not flagged', () => {
    const near = detectDuplicates([
      exp(1, -50, { description: 'Shop', date: '2026-10-01' }),
      exp(2, -50, { description: 'Shop', date: '2026-10-04' }),
    ], cfg);
    expect(near.map((a) => a.severity)).toEqual(['medium']);
    const far = detectDuplicates([
      exp(1, -50, { description: 'Shop', date: '2026-10-01' }),
      exp(2, -50, { description: 'Shop', date: '2026-10-05' }),
    ], cfg);
    expect(far).toEqual([]);
  });

  test('different amounts, missing description, zero amount or bad dates are not duplicates', () => {
    expect(detectDuplicates([
      exp(1, -50, { description: 'Shop' }), exp(2, -51, { description: 'Shop' }),
      exp(3, -5, { description: '' }), exp(4, -5, { description: '' }),
      exp(5, 0, { description: 'Zero' }), exp(6, 0, { description: 'Zero' }),
      exp(7, -3, { description: 'Bad', date: 'not-a-date' }), exp(8, -3, { description: 'Bad', date: 'nope' }),
    ], cfg)).toEqual([]);
  });

  test('same-day ties: the lower id is the original regardless of input order', () => {
    const out = detectDuplicates([
      exp(20, -7, { description: 'Cafe', date: '2026-10-01' }),
      exp(10, -7, { description: 'Cafe', date: '2026-10-01' }),
    ], cfg);
    expect(out).toEqual([expect.objectContaining({ transactionId: 20, duplicateOf: 10 })]);
  });

  test('a chain of three charges yields two anomalies, each pointing to its predecessor', () => {
    const out = detectDuplicates([
      exp(1, -5, { description: 'Bus', date: '2026-10-01' }),
      exp(2, -5, { description: 'Bus', date: '2026-10-02' }),
      exp(3, -5, { description: 'Bus', date: '2026-10-03' }),
    ], cfg);
    expect(out.map((a) => [a.transactionId, a.duplicateOf])).toEqual([[2, 1], [3, 2]]);
  });

  test('custom window from config is honoured', () => {
    const txs = [
      exp(1, -5, { description: 'Gym', date: '2026-10-01' }),
      exp(2, -5, { description: 'Gym', date: '2026-10-08' }),
    ];
    expect(detectDuplicates(txs, { ...cfg, duplicateWindowDays: 7 })).toHaveLength(1);
  });
});
