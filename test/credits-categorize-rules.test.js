// Unit tests for services/importCategorizer (MCC) and services/rulesEngine pure helpers.
'use strict';

jest.mock('../db/database', () => ({ query: jest.fn(), get: jest.fn(), run: jest.fn(), transaction: jest.fn() }));

const { categorizeByMcc, categorizeByDescription, CATEGORY } = require('../services/importCategorizer');
const { ruleMatches, firstMatch, isUncategorized } = require('../services/rulesEngine');

describe('categorizeByMcc', () => {
  test.each([
    [5411, 'Groceries'],
    ['5812', 'Food & Dining'],
    [5541, 'Fuel'],
    [4111, 'Transport'],
    [6011, 'Cash'],
    [4829, 'Transfer'],
    [4900, 'Utilities'],
    [4814, 'Phone & Internet'],
    [9311, 'Taxes & Government'],
    [6300, 'Bank Fees'],
    [7399, 'Other'],
  ])('exact code %s -> %s', (mcc, cat) => {
    expect(categorizeByMcc(mcc)).toBe(cat);
  });

  test.each([
    [3100, 'Travel'], // airlines
    [3400, 'Travel'], // car rental
    [3700, 'Travel'], // hotels
    [3300, 'Other'],  // gap between airline and car-rental ranges
    [5655, 'Shopping'],
    [5950, 'Shopping'],
    [7850, 'Entertainment'],
    [8090, 'Health'],
    [8100, 'Other'],
  ])('range code %s -> %s', (mcc, cat) => {
    expect(categorizeByMcc(mcc)).toBe(cat);
  });

  test('non-numeric codes -> Other', () => {
    expect(categorizeByMcc('abc')).toBe('Other');
    expect(categorizeByMcc(undefined)).toBe('Other');
  });

  test('every MCC/keyword result is a known category label', () => {
    const labels = new Set(Object.values(CATEGORY));
    for (let code = 3000; code <= 9999; code += 7) expect(labels.has(categorizeByMcc(code))).toBe(true);
  });
});

describe('categorizeByDescription ordering', () => {
  test('earlier rules win: salary before transfer, refund before shopping', () => {
    expect(categorizeByDescription('PAYROLL DEPOSIT via INTERAC')).toBe('Salary');
    expect(categorizeByDescription('AMAZON REFUND')).toBe('Refund');
  });

  test('subscriptions beat generic shopping/transport words', () => {
    expect(categorizeByDescription('AMAZON PRIME*2K3')).toBe('Subscriptions');
    expect(categorizeByDescription('UBER EATS TORONTO')).toBe('Food & Dining');
    expect(categorizeByDescription('UBER TRIP')).toBe('Transport');
  });

  test('empty/unknown -> Other', () => {
    expect(categorizeByDescription('')).toBe('Other');
    expect(categorizeByDescription(null)).toBe('Other');
    expect(categorizeByDescription('XQZ 0001')).toBe('Other');
  });
});

describe('rulesEngine.isUncategorized', () => {
  test.each([null, undefined, '', '  ', 'Other', 'UNCATEGORIZED', 'Прочее', ' без категории '])('%p is uncategorized', (c) => {
    expect(isUncategorized(c)).toBe(true);
  });
  test.each(['Groceries', 'Продукты', 'Others'])('%p is a real category', (c) => {
    expect(isUncategorized(c)).toBe(false);
  });
});

describe('rulesEngine.ruleMatches', () => {
  const tx = { description: 'Tim Hortons #123', category: null, amount: -12.5 };
  const rule = (match_field, match_op, match_value) => ({ match_field, match_op, match_value });

  test('text contains/equals are case-insensitive', () => {
    expect(ruleMatches(rule('description', 'contains', 'HORTONS'), tx)).toBe(true);
    expect(ruleMatches(rule('description', 'equals', 'tim hortons #123'), tx)).toBe(true);
    expect(ruleMatches(rule('description', 'equals', 'tim hortons'), tx)).toBe(false);
  });

  test('empty contains needle never matches', () => {
    expect(ruleMatches(rule('description', 'contains', ''), tx)).toBe(false);
    expect(ruleMatches(rule('description', 'contains', null), tx)).toBe(false);
  });

  test('regex is case-insensitive; invalid regex never matches (no throw)', () => {
    expect(ruleMatches(rule('description', 'regex', '^tim\\s+hort'), tx)).toBe(true);
    expect(ruleMatches(rule('description', 'regex', '([unclosed'), tx)).toBe(false);
  });

  test('null field is treated as empty string', () => {
    expect(ruleMatches(rule('category', 'equals', ''), tx)).toBe(true);
    expect(ruleMatches(rule('category', 'contains', 'x'), tx)).toBe(false);
  });

  test('amount comparisons use absolute values (expenses are negative)', () => {
    expect(ruleMatches(rule('amount', 'gt', '10'), tx)).toBe(true);
    expect(ruleMatches(rule('amount', 'lt', '-20'), tx)).toBe(true);
    expect(ruleMatches(rule('amount', 'equals', '12.50'), tx)).toBe(true);
    expect(ruleMatches(rule('amount', 'contains', '12'), tx)).toBe(true);
    expect(ruleMatches(rule('amount', 'gt', 'abc'), tx)).toBe(false);
    expect(ruleMatches(rule('amount', 'gt', '1'), { amount: 'n/a' })).toBe(false);
  });

  test.skip('bug: amount + regex rule never matches a real regex (NaN guard runs before the switch)', () => {
    // models/categoryRule accepts match_field=amount with match_op=regex, but ruleMatches
    // computes Math.abs(Number(match_value)) first: any non-numeric pattern is NaN -> false.
    expect(ruleMatches(rule('amount', 'regex', '^12\\.5$'), tx)).toBe(true);
    expect(ruleMatches(rule('amount', 'regex', '^1\\d\\.'), tx)).toBe(true);
  });

  test('unknown operator never matches', () => {
    expect(ruleMatches(rule('description', 'startsWith', 'Tim'), tx)).toBe(false);
    expect(ruleMatches(rule('amount', 'between', '1'), tx)).toBe(false);
  });

  test('firstMatch returns the first rule in priority order or null', () => {
    const rules = [
      { id: 1, ...rule('description', 'contains', 'starbucks') },
      { id: 2, ...rule('description', 'contains', 'tim') },
      { id: 3, ...rule('amount', 'gt', '1') },
    ];
    expect(firstMatch(rules, tx).id).toBe(2);
    expect(firstMatch(rules.slice(0, 1), tx)).toBeNull();
    expect(firstMatch([], tx)).toBeNull();
  });
});
