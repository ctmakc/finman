// test/unit-rules-ledger.test.js — pure parts of services/rulesEngine
// (rule matching semantics) and services/ledgerExport (Beancount name/amount
// helpers). The DB layer is mocked so nothing touches SQLite.
'use strict';

jest.mock('../db/database', () => ({
  query: jest.fn(async () => []),
  get: jest.fn(async () => null),
  run: jest.fn(async () => ({ changes: 0 })),
  transaction: jest.fn(async (fn) => fn()),
}));
jest.mock('../models/categoryRule', () => ({ findByUserId: jest.fn(async () => []) }));

const rules = require('../services/rulesEngine');
const ledger = require('../services/ledgerExport');

const rule = (field, op, value, extra = {}) => ({ match_field: field, match_op: op, match_value: value, ...extra });

describe('rulesEngine.isUncategorized', () => {
  test('null, blank and placeholder categories (any case, padded, Cyrillic) are uncategorized', () => {
    for (const c of [null, undefined, '', '   ', 'Other', 'OTHER', 'uncategorized', ' Прочее ', 'Без категории']) {
      expect(rules.isUncategorized(c)).toBe(true);
    }
  });
  test('real categories are not', () => {
    for (const c of ['Groceries', 'Other stuff', 'Продукти', 0]) {
      expect(rules.isUncategorized(c)).toBe(false);
    }
  });
});

describe('rulesEngine.ruleMatches — amount field', () => {
  test('compares absolute values so rules use human amounts for negative expenses', () => {
    expect(rules.ruleMatches(rule('amount', 'gt', '100'), { amount: -150 })).toBe(true);
    expect(rules.ruleMatches(rule('amount', 'gt', '-100'), { amount: -150 })).toBe(true);
    expect(rules.ruleMatches(rule('amount', 'lt', '100'), { amount: -150 })).toBe(false);
    expect(rules.ruleMatches(rule('amount', 'gt', '150'), { amount: -150 })).toBe(false); // strict
    expect(rules.ruleMatches(rule('amount', 'equals', '12.50'), { amount: -12.5 })).toBe(true);
  });

  test('contains works on the absolute amount text', () => {
    expect(rules.ruleMatches(rule('amount', 'contains', '99'), { amount: -199 })).toBe(true);
    expect(rules.ruleMatches(rule('amount', 'contains', '.99'), { amount: -12.99 })).toBe(true);
    expect(rules.ruleMatches(rule('amount', 'contains', '5'), { amount: -199 })).toBe(false);
  });

  // models/categoryRule accepts match_field='amount' + match_op='regex', and
  // ruleMatches has a 'regex' branch for amounts, but it first does
  // Number(match_value) and returns false when that is not finite — so any real
  // pattern ('^19\d$', '\.99$') is rejected before the regex branch is reached.
  test.skip('bug: amount rules with op "regex" never match a non-numeric pattern', () => {
    expect(rules.ruleMatches(rule('amount', 'regex', '^19\\d$'), { amount: -199 })).toBe(true);
    expect(rules.ruleMatches(rule('amount', 'regex', '\\.99$'), { amount: -12.99 })).toBe(true);
  });

  test('non-numeric value, invalid regex or unknown op never match', () => {
    expect(rules.ruleMatches(rule('amount', 'gt', 'abc'), { amount: 5 })).toBe(false);
    expect(rules.ruleMatches(rule('amount', 'gt', '1'), { amount: 'x' })).toBe(false);
    expect(rules.ruleMatches(rule('amount', 'regex', '('), { amount: 5 })).toBe(false);
    expect(rules.ruleMatches(rule('amount', 'between', '1'), { amount: 5 })).toBe(false);
  });
});

describe('rulesEngine.ruleMatches — text fields', () => {
  test('contains and equals are case-insensitive (including Cyrillic)', () => {
    expect(rules.ruleMatches(rule('description', 'contains', 'netflix'), { description: 'NETFLIX.COM 866' })).toBe(true);
    expect(rules.ruleMatches(rule('description', 'equals', 'Netflix'), { description: 'NETFLIX' })).toBe(true);
    expect(rules.ruleMatches(rule('description', 'equals', 'Netflix'), { description: 'NETFLIX.COM' })).toBe(false);
    expect(rules.ruleMatches(rule('description', 'contains', 'сільпо'), { description: 'СІЛЬПО Київ' })).toBe(true);
  });

  test('empty "contains" needle does not match everything', () => {
    expect(rules.ruleMatches(rule('description', 'contains', ''), { description: 'anything' })).toBe(false);
    expect(rules.ruleMatches(rule('description', 'contains', null), { description: 'anything' })).toBe(false);
  });

  test('regex is case-insensitive, invalid patterns are safe', () => {
    expect(rules.ruleMatches(rule('description', 'regex', '^uber\\s'), { description: 'UBER TRIP' })).toBe(true);
    expect(rules.ruleMatches(rule('description', 'regex', '[unclosed'), { description: '[unclosed' })).toBe(false);
  });

  test('missing field value is treated as empty string', () => {
    expect(rules.ruleMatches(rule('category', 'equals', ''), { category: null })).toBe(true);
    expect(rules.ruleMatches(rule('category', 'contains', 'x'), {})).toBe(false);
  });
});

describe('rulesEngine.firstMatch / previewRules', () => {
  const R = [
    { id: 1, priority: 10, is_active: 1, set_category: 'Streaming', ...rule('description', 'contains', 'netflix') },
    { id: 2, priority: 1, is_active: 1, set_category: 'Big', ...rule('amount', 'gt', '100') },
    { id: 3, priority: 1, is_active: 0, set_category: 'Disabled', ...rule('description', 'contains', 'net') },
    { id: 4, priority: 1, set_category: 'Tie', ...rule('description', 'contains', 'flix') },
  ];

  test('firstMatch respects the given order', () => {
    expect(rules.firstMatch(R, { description: 'Netflix', amount: -200 }).id).toBe(1);
    expect(rules.firstMatch([], { description: 'x' })).toBeNull();
  });

  test('previewRules: priority ascending, then id; inactive rules ignored; unmatched txs omitted', () => {
    const out = rules.previewRules(R, [
      { id: 10, description: 'Netflix', amount: -15 }, // rule 4 (prio 1, id 4) before rule 1
      { id: 11, description: 'Rent', amount: -1500 },  // rule 2 (prio 1, id 2)
      { id: 12, description: 'Coffee', amount: -4 },   // none
    ]);
    expect(out).toEqual([
      { transactionId: 10, to: 'Tie', ruleId: 4 },
      { transactionId: 11, to: 'Big', ruleId: 2 },
    ]);
    // input array not reordered
    expect(R.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('rulesEngine.applyToUncategorized (mocked DB)', () => {
  const db = require('../db/database');
  const CategoryRule = require('../models/categoryRule');

  beforeEach(() => {
    db.query.mockReset();
    db.run.mockReset();
    CategoryRule.findByUserId.mockReset();
  });

  test('only placeholder-category expenses are candidates; dryRun writes nothing', async () => {
    CategoryRule.findByUserId.mockResolvedValue([
      { id: 5, set_category: 'Coffee', ...rule('description', 'contains', 'starbucks') },
    ]);
    db.query.mockResolvedValue([
      { id: 1, description: 'Starbucks 1', category: null, amount: -5 },
      { id: 2, description: 'Starbucks 2', category: 'Прочее', amount: -5 },
      { id: 3, description: 'Starbucks 3', category: 'Dining', amount: -5 }, // already categorized
    ]);
    const res = await rules.applyToUncategorized(42, { dryRun: true });
    expect(res.updated).toBe(0);
    expect(res.suggestions.map((s) => s.transactionId)).toEqual([1, 2]);
    expect(res.suggestions[1]).toMatchObject({ from: 'Прочее', to: 'Coffee', ruleId: 5 });
    expect(db.run).not.toHaveBeenCalled();
  });

  test('writes are scoped by user id and count only changed rows', async () => {
    CategoryRule.findByUserId.mockResolvedValue([
      { id: 5, set_category: 'Coffee', ...rule('description', 'contains', 'starbucks') },
    ]);
    db.query.mockResolvedValue([
      { id: 1, description: 'Starbucks', category: null, amount: -5 },
      { id: 2, description: 'Starbucks', category: '', amount: -5 },
    ]);
    db.run.mockResolvedValueOnce({ changes: 1 }).mockResolvedValueOnce({ changes: 0 });
    const res = await rules.applyToUncategorized(42);
    expect(res.updated).toBe(1);
    expect(db.run).toHaveBeenCalledTimes(2);
    for (const call of db.run.mock.calls) {
      expect(call[0]).toMatch(/WHERE id = \? AND user_id = \?/);
      expect(call[1][2]).toBe(42);
    }
  });

  test('limit caps the uncategorized set after filtering', async () => {
    db.query.mockResolvedValue([
      { id: 1, category: 'Food' },
      { id: 2, category: null },
      { id: 3, category: 'other' },
      { id: 4, category: null },
    ]);
    const out = await rules.getUncategorizedExpenses(1, 2);
    expect(out.map((r) => r.id)).toEqual([2, 3]);
  });
});

describe('ledgerExport helpers (Beancount)', () => {
  const L = ledger._internal;

  test('accountComponent produces valid Beancount components', () => {
    expect(L.accountComponent('my card #1')).toBe('My-card-1');
    expect(L.accountComponent('  Visa  Gold ')).toBe('Visa-Gold');
    expect(L.accountComponent('-abc-')).toBe('Abc');
    expect(L.accountComponent('_x')).toBe('X');
    expect(L.accountComponent('', 'Account7')).toBe('Account7');
    expect(L.accountComponent(null)).toBe('Unknown');
    for (const s of ['my card', '123', 'été', 'Моя карта']) {
      expect(L.accountComponent(s, 'Fallback')).toMatch(/^[A-Z0-9][A-Za-z0-9-]*$/);
    }
  });

  test('all-non-ASCII names stay distinct and stable via a hash suffix', () => {
    const a = L.accountComponent('Моя карта', 'Account');
    const b = L.accountComponent('Другая карта', 'Account');
    expect(a).not.toBe(b);
    expect(a).toBe(L.accountComponent('Моя карта', 'Account'));
    expect(a.startsWith('Account-')).toBe(true);
  });

  test('normalizeCurrency uppercases valid codes, falls back to default otherwise', () => {
    const def = require('../config/config').defaultCurrency;
    expect(L.normalizeCurrency(' uah ')).toBe('UAH');
    expect(L.normalizeCurrency('₴')).toBe(def);
    expect(L.normalizeCurrency('1BTC')).toBe(def);
    expect(L.normalizeCurrency(null)).toBe(def);
    expect(L.normalizeCurrency('A'.repeat(25))).toBe(def);
  });

  test('bcString escapes backslashes and quotes and flattens newlines', () => {
    expect(L.bcString('say "hi" \\ there\r\nnext')).toBe('say \\"hi\\" \\\\ there next');
    expect(L.bcString(null)).toBe('');
  });

  test('amountStr always has two decimals and is float-safe', () => {
    expect(L.amountStr(0.1 + 0.2, 'CAD')).toBe('0.30 CAD');
    expect(L.amountStr(-5, 'UAH')).toBe('-5.00 UAH');
    expect(L.amountStr('12.345', 'USD')).toBe('12.35 USD');
  });

  test('normalizeDate: ISO prefix kept verbatim, garbage -> epoch', () => {
    expect(L.normalizeDate('2026-03-05')).toBe('2026-03-05');
    expect(L.normalizeDate('2026-03-05T23:59:59-08:00')).toBe('2026-03-05');
    expect(L.normalizeDate('garbage')).toBe('1970-01-01');
    expect(L.normalizeDate(null)).toBe('1970-01-01');
  });

  // Non-ISO dates go through `new Date(s).toISOString()`: the string is parsed
  // as LOCAL midnight and then printed in UTC, so east of UTC (Kyiv, the app's
  // main audience) every such date moves one day back.
  // (TZ must be set before the process starts, so this runs in a child node.)
  const normalizeDateIn = (tz, input) => {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const os = require('os');
    const script =
      `const L = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'ledgerExport'))})._internal;` +
      `process.stdout.write(L.normalizeDate(${JSON.stringify(input)}));`;
    return execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: tz, DATABASE_PATH: path.join(os.tmpdir(), `ledger-tz-${process.pid}.db`) },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  };

  afterAll(() => {
    const fs = require('fs');
    const base = require('path').join(require('os').tmpdir(), `ledger-tz-${process.pid}.db`);
    for (const f of [base, `${base}-wal`, `${base}-shm`]) fs.rmSync(f, { force: true });
  });

  test('normalizeDate of a non-ISO date is correct in UTC', () => {
    expect(normalizeDateIn('UTC', 'March 5, 2026')).toBe('2026-03-05');
  });

  test.skip('bug: normalizeDate shifts non-ISO dates one day back in timezones east of UTC', () => {
    expect(normalizeDateIn('Europe/Kyiv', 'March 5, 2026')).toBe('2026-03-05'); // actual: 2026-03-04
  });

  test('categoryAccount: opening -> Equity, income/expense roots, empty category -> Uncategorized', () => {
    expect(L.categoryAccount('opening', 'whatever')).toBe('Equity:Opening-Balances');
    expect(L.categoryAccount('income', 'Salary')).toBe('Income:Salary');
    expect(L.categoryAccount('expense', 'Food & Dining')).toBe('Expenses:Food-Dining');
    expect(L.categoryAccount('expense', null)).toBe('Expenses:Uncategorized');
    expect(L.categoryAccount('transfer', 'x')).toBe('Expenses:X');
  });

  test('assetAccount prefers name, then bank_name, then Account<id>', () => {
    expect(L.assetAccount({ id: 3, name: 'Visa Gold' })).toBe('Assets:Visa-Gold');
    expect(L.assetAccount({ id: 3, name: null, bank_name: 'TD' })).toBe('Assets:TD');
    expect(L.assetAccount({ id: 3 })).toBe('Assets:Account3');
  });
});
