// test/credits-import-mapping.test.js — CSV/OFX import internals that only had
// end-to-end coverage: autoMapping, resolveMapping, normalizeRow, markDuplicates,
// summarize, detectPreset/listPresets, parseOfxTree, and the MCC categorizer.
// Pure functions: no DB, no network.
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const csv = require(path.join(ROOT, 'services', 'csvImportService'));
const ofx = require(path.join(ROOT, 'services', 'ofxImportService'));
const { categorizeByMcc, categorizeByDescription, CATEGORY } = require(path.join(ROOT, 'services', 'importCategorizer'));

describe('csvImportService.autoMapping', () => {
  test('header row with separate Debit/Credit money columns', () => {
    const headers = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
    const rows = [
      ['2026-01-05', 'Coffee', '4.50', '', '100.00'],
      ['2026-01-06', 'Salary', '', '2000.00', '2100.00'],
    ];
    const m = csv.autoMapping(headers, rows, true);
    expect(m).toMatchObject({ date: 0, description: [1], debit: 2, credit: 3, balance: 4, amount: null, sign: 'signed' });
  });

  test('"Fee amount" is not taken as the amount and "Name" yields to "Description"', () => {
    const m = csv.autoMapping(['Date', 'Fee amount', 'Amount', 'Name', 'Description'], [['2026-01-01', '1', '10', 'n', 'd']], true);
    expect(m.amount).toBe(2);
    expect(m.description).toEqual([4]);
  });

  test('a Debit/Credit column holding words becomes the type column', () => {
    const m = csv.autoMapping(
      ['Date', 'Details', 'Amount', 'Debit/Credit'],
      [['2026-01-01', 'x', '10', 'Debit'], ['2026-01-02', 'y', '5', 'Credit']],
      true
    );
    expect(m.typeColumn).toBe(3);
    expect(m.debit).toBeNull();
    expect(m.credit).toBeNull();
    expect(m.amount).toBe(2);
  });

  test('headerless: signed amount + running balance found from content', () => {
    const m = csv.autoMapping([], [
      ['01/05/2026', 'STARBUCKS', '-4.50', '95.50'],
      ['01/06/2026', 'PAYROLL', '2000', '2095.50'],
    ], false);
    expect(m).toMatchObject({ date: 0, description: [1], amount: 2, balance: 3 });
  });

  test('headerless: two mutually exclusive numeric columns are debit/credit', () => {
    const m = csv.autoMapping([], [
      ['01/05/2026', 'STARBUCKS', '4.50', '', '95.50'],
      ['01/06/2026', 'PAYROLL', '', '2000', '2095.50'],
    ], false);
    expect(m).toMatchObject({ date: 0, description: [1], debit: 2, credit: 3, balance: 4 });
  });
});

describe('csvImportService.resolveMapping', () => {
  test('names -> indices, description keeps every existing column, currency from header', () => {
    const idx = csv.resolveMapping(
      { date: 'date', description: ['Description', 'Memo', 'Nope'], amount: 'Сума в валюті картки (UAH)', currencyFromHeader: true },
      ['Date', 'Description', 'Memo', 'Сума в валюті картки (UAH)'],
      4
    );
    expect(idx).toEqual({ date: 0, description: [1, 2], amount: 3, fixedCurrency: 'UAH', sign: 'signed' });
  });

  test('numeric refs out of range become null; scalar description is wrapped; sign/fixedCurrency pass through', () => {
    const idx = csv.resolveMapping({ date: 9, amount: 1, description: 2, fixedCurrency: 'EUR', sign: 'debit-positive' }, ['a', 'b', 'c'], 3);
    expect(idx).toEqual({ date: null, description: [2], amount: 1, fixedCurrency: 'EUR', sign: 'debit-positive' });
  });

  test('substring match and "first that exists" for array refs', () => {
    const idx = csv.resolveMapping({ date: 'posted', amount: ['Missing', 'Amount'] }, ['Date Posted', 'Amount'], 2);
    expect(idx).toEqual({ date: 0, amount: 1, sign: 'signed' });
  });
});

describe('csvImportService.normalizeRow', () => {
  const H = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
  const dc = csv.resolveMapping({ date: 0, description: [1], debit: 2, credit: 3, balance: 4 }, H, 5);

  test('debit column -> negative expense with category guess, balance and fingerprint', () => {
    const r = csv.normalizeRow(['2026-01-05', 'Coffee', '4.50', '', '100.00'], dc, { dateOrder: 'auto' }, 2);
    expect(r).toMatchObject({
      index: 2, error: null, skipped: null, date: '2026-01-05', description: 'Coffee',
      amount: -4.5, type: 'expense', category: 'Food & Dining', currency: null, externalId: null, balance: 100,
    });
    expect(r.fingerprint).toBe(csv.fingerprintOf('2026-01-05', -4.5, 'coffee'));
  });

  test('credit column -> positive income', () => {
    const r = csv.normalizeRow(['2026-01-06', 'Payroll ACME', '', '2,000.00', ''], dc, {}, 3);
    expect(r.amount).toBe(2000);
    expect(r.type).toBe('income');
    expect(r.category).toBe('Salary');
  });

  test('blank row is skipped, bad date / missing amount are row errors', () => {
    expect(csv.normalizeRow(['', '', '', '', ''], dc, {}, 3).skipped).toBe('blank');
    expect(csv.normalizeRow(['31/02/2026', 'x', '1', '', ''], dc, { dateOrder: 'DMY' }, 4).error).toBe('Unrecognised date "31/02/2026"');
    expect(csv.normalizeRow(['', 'x', '1', '', ''], dc, {}, 4).error).toBe('Missing date');
    expect(csv.normalizeRow(['2026-01-01', 'x', '', '', ''], dc, {}, 5).error).toBe('Missing amount');
  });

  test('unparseable amount is reported with the raw cell', () => {
    const idx = csv.resolveMapping({ date: 0, description: [1], amount: 2 }, ['d', 'x', 'a'], 3);
    expect(csv.normalizeRow(['2026-01-01', 'x', 'n/a'], idx, {}, 2).error).toBe('Unrecognised amount "n/a"');
  });

  test('skipRow hook wins before anything else', () => {
    const r = csv.normalizeRow(['garbage'], dc, { skipRow: () => 'state pending' }, 2);
    expect(r.skipped).toBe('state pending');
    expect(r.date).toBeUndefined();
  });

  test('amountAlt is used when the main amount cell is empty', () => {
    const idx = csv.resolveMapping({ date: 0, description: [1], amount: 2, amountAlt: 3 }, ['d', 'x', 'CAD$', 'USD$'], 4);
    expect(csv.normalizeRow(['2026-01-01', 'Amazon US', '', '-12.34'], idx, {}, 2).amount).toBe(-12.34);
  });

  test('type column sets the sign of an unsigned amount; decimal comma honoured', () => {
    const idx = csv.resolveMapping({ date: 0, description: [1], amount: 2, typeColumn: 3 }, ['d', 'x', 'a', 't'], 4);
    expect(csv.normalizeRow(['2026-01-01', 'x', '10', 'DEBIT'], idx, {}, 2).amount).toBe(-10);
    expect(csv.normalizeRow(['2026-01-01', 'x', '-10', 'Credit'], idx, {}, 2).amount).toBe(10);
    expect(csv.normalizeRow(['2026-01-01', 'x', '-10', 'OTHER'], idx, {}, 2).amount).toBe(-10);
    expect(csv.normalizeRow(['2026-01-01', 'x', '1,5', ''], idx, { decimalComma: true }, 2).amount).toBe(1.5);
  });

  test('fee on a signed amount (Revolut layout) is subtracted', () => {
    const idx = csv.resolveMapping({ date: 0, description: [1], amount: 2, fee: 3 }, ['d', 'x', 'a', 'f'], 4);
    expect(csv.normalizeRow(['2026-01-01', 'x', '-10', '0.50'], idx, {}, 2).amount).toBe(-10.5);
    expect(csv.normalizeRow(['2026-01-01', 'Top-up', '100', '1'], idx, {}, 2).amount).toBe(99);
  });

  test('debit-positive sign flips a signed amount column', () => {
    const idx = csv.resolveMapping({ date: 0, description: [1], amount: 2, sign: 'debit-positive' }, ['d', 'x', 'a'], 3);
    expect(csv.normalizeRow(['2026-01-01', 'x', '25'], idx, {}, 2).amount).toBe(-25);
  });

  test('description parts are whitespace-collapsed and de-duplicated case-insensitively; MCC beats keywords; currency upper-cased', () => {
    const idx = csv.resolveMapping(
      { date: 0, description: [1, 2], amount: 3, mcc: 4, currency: 5, externalId: 6 },
      ['d', 'a', 'b', 'amt', 'mcc', 'cur', 'id'],
      7
    );
    const r = csv.normalizeRow(['2026-01-01', '  Silpo   Kyiv ', 'silpo kyiv', '-100', '5812', 'uah', ''], idx, {}, 8);
    expect(r.description).toBe('Silpo Kyiv');
    expect(r.category).toBe('Food & Dining'); // MCC 5812, not "Сільпо"/groceries keyword
    expect(r.currency).toBe('UAH');
    expect(r.externalId).toBeNull();
  });

  test('an explicit category column wins; empty description falls back to "Transaction"', () => {
    const idx = csv.resolveMapping({ date: 0, description: [1], amount: 2, category: 3 }, ['d', 'x', 'a', 'c'], 4);
    const r = csv.normalizeRow(['2026-01-01', '', '-3', 'Pets'], idx, {}, 2);
    expect(r.description).toBe('Transaction');
    expect(r.category).toBe('Pets');
  });

  // normalizeRow subtracts the fee BEFORE the direction from the type column (or
  // sign: 'debit-positive') is applied. With an unsigned amount 10, fee 1 and type
  // DEBIT the result is -(10-1) = -9 instead of -11; a CREDIT of 10 with fee 1
  // becomes +11 instead of +9. No built-in preset combines fee with a type column
  // today, so this is latent (reachable through a manual/combined mapping).
  test.skip('bug: fee is applied before the type-column sign (DEBIT 10 + fee 1 -> -9, expected -11)', () => {
    const idx = csv.resolveMapping({ date: 0, description: [1], amount: 2, fee: 3, typeColumn: 4 }, ['d', 'x', 'a', 'f', 't'], 5);
    expect(csv.normalizeRow(['2026-01-01', 'x', '10', '1', 'Debit'], idx, {}, 2).amount).toBe(-11);
    expect(csv.normalizeRow(['2026-01-01', 'x', '10', '1', 'Credit'], idx, {}, 2).amount).toBe(9);
  });
});

describe('csvImportService.markDuplicates', () => {
  const row = (fp, ext) => ({ fingerprint: fp, externalId: ext || null });

  test('existing multiset is consumed one row per stored copy, the rest are in-file dups', () => {
    const rows = [row('a'), row('a'), row('a'), row(null)];
    csv.markDuplicates(rows, new Map([['a', 1]]));
    expect(rows.map((r) => r.duplicate)).toEqual(['existing', 'file', 'file', null]);
  });

  test('rows with bank ids are file duplicates only when the id repeats', () => {
    const rows = [row('b', '1'), row('b', '2'), row('b', '1')];
    csv.markDuplicates(rows);
    expect(rows.map((r) => r.duplicate)).toEqual([null, null, 'file']);
  });

  test('accepts Set / array and never mutates the caller\'s collection', () => {
    const set = new Set(['a']);
    const rows = [row('a'), row('a')];
    csv.markDuplicates(rows, set);
    expect(rows.map((r) => r.duplicate)).toEqual(['existing', 'file']);
    expect(set.size).toBe(1);

    const counts = new Map([['a', 2]]);
    csv.markDuplicates([row('a'), row('a'), row('a')], counts);
    expect(counts.get('a')).toBe(2);

    const arr = ['x', 'x'];
    const r2 = [row('x'), row('x'), row('x')];
    csv.markDuplicates(r2, arr);
    expect(r2.map((r) => r.duplicate)).toEqual(['existing', 'existing', 'file']);
  });

  test('fingerprintCounts counts repeats', () => {
    expect(Array.from(csv.fingerprintCounts(['a', 'b', 'a']).entries())).toEqual([['a', 2], ['b', 1]]);
    expect(csv.fingerprintCounts(null).size).toBe(0);
  });
});

describe('csvImportService.summarize', () => {
  test('buckets rows and sums only valid ones', () => {
    const s = csv.summarize([
      { error: 'x' },
      { skipped: 'blank' },
      { duplicate: 'file', amount: 5, date: '2026-01-01' },
      { amount: -4.5, date: '2026-02-01' },
      { amount: 100.1, date: '2026-01-15' },
      { amount: 0.2, date: '2026-03-01' },
    ]);
    expect(s).toEqual({
      total: 6, valid: 3, duplicates: 1, skipped: 1, errors: 1,
      sum: 95.8, income: 100.3, expense: -4.5, minDate: '2026-01-15', maxDate: '2026-03-01',
    });
  });

  test('empty input', () => {
    expect(csv.summarize([])).toMatchObject({ total: 0, valid: 0, sum: 0, minDate: null, maxDate: null });
  });
});

describe('csvImportService presets', () => {
  test('listPresets exposes metadata in detection order', () => {
    const list = csv.listPresets();
    expect(list.map((p) => p.id)).toEqual(['revolut', 'wise', 'monobank', 'rbc', 'bmo', 'tangerine', 'wealthsimple', 'eqbank', 'td', 'cibc', 'scotiabank']);
    for (const p of list) {
      expect(Object.keys(p).sort()).toEqual(['bankId', 'dateOrder', 'hasHeader', 'id', 'name', 'notes', 'verified']);
      expect(typeof p.verified).toBe('boolean');
    }
  });

  const ctxFor = (headers) => ({ hasHeader: true, headers, columnCount: headers.length, colStats: [], dataRows: [] });

  test('Wealthsimple vs EQ Bank: "transaction" column decides', () => {
    expect(csv.detectPreset(ctxFor(['date', 'transaction', 'description', 'amount', 'balance'])).id).toBe('wealthsimple');
    expect(csv.detectPreset(ctxFor(['Date', 'Description', 'Amount', 'Balance'])).id).toBe('eqbank');
  });

  test('Revolut and Wise headers', () => {
    expect(csv.detectPreset(ctxFor(['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'])).id).toBe('revolut');
    expect(csv.detectPreset(ctxFor(['TransferWise ID', 'Date', 'Amount', 'Currency', 'Description'])).id).toBe('wise');
  });

  test('unknown header -> no preset; a throwing signature does not break detection', () => {
    expect(csv.detectPreset(ctxFor(['foo', 'bar']))).toBeNull();
    // headerless ctx without stats: headerless signatures may throw internally
    expect(() => csv.detectPreset({ hasHeader: false, headers: [], columnCount: 3, colStats: [], dataRows: [] })).not.toThrow();
  });
});

describe('ofxImportService.parseOfxTree', () => {
  const find = (node, name) => {
    if (!node.children) return null;
    for (const c of node.children) {
      if (c.name === name) return c;
      const f = find(c, name);
      if (f) return f;
    }
    return null;
  };

  test('SGML leaves without closing tags, entities decoded, empty leaf kept', () => {
    const t = ofx.parseOfxTree(
      'OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN>' +
        '<TRNAMT>-4.50<NAME>Tim &amp; Co<MEMO></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>'
    );
    const trn = find(t, 'STMTTRN');
    expect(trn.children.map((c) => [c.name, c.value])).toEqual([['TRNAMT', '-4.50'], ['NAME', 'Tim & Co'], ['MEMO', '']]);
  });

  test('XML form: unknown tags classified by lookahead (aggregate vs empty leaf)', () => {
    const t = ofx.parseOfxTree('<?xml version="1.0"?><OFX><FOO><BAR>1</BAR></FOO><EMPTY></EMPTY></OFX>');
    const root = find(t, 'OFX');
    expect(root.children.map((c) => c.name)).toEqual(['FOO', 'EMPTY']);
    expect(find(t, 'FOO').children).toEqual([{ name: 'BAR', children: null, value: '1' }]);
    expect(find(t, 'EMPTY').children).toBeNull();
  });

  test('non-OFX input throws a clear error', () => {
    expect(() => ofx.parseOfxTree('hello')).toThrow('Not an OFX file');
  });
});

describe('importCategorizer.categorizeByMcc', () => {
  test('exact codes', () => {
    expect(categorizeByMcc(5411)).toBe(CATEGORY.groceries);
    expect(categorizeByMcc('5812')).toBe(CATEGORY.dining);
    expect(categorizeByMcc(6011)).toBe(CATEGORY.cash);
    expect(categorizeByMcc(4829)).toBe(CATEGORY.transfer);
    expect(categorizeByMcc(9311)).toBe(CATEGORY.taxes);
  });

  test('ranges: airlines, car rental, hotels, apparel, misc retail, entertainment, health', () => {
    expect(categorizeByMcc(3100)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(3400)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(3600)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(5655)).toBe(CATEGORY.shopping);
    expect(categorizeByMcc(5950)).toBe(CATEGORY.shopping);
    expect(categorizeByMcc(7801)).toBe(CATEGORY.entertainment);
    expect(categorizeByMcc(8001)).toBe(CATEGORY.health);
  });

  test('unknown or garbage codes -> Other', () => {
    expect(categorizeByMcc(1234)).toBe(CATEGORY.other);
    expect(categorizeByMcc('abc')).toBe(CATEGORY.other);
    expect(categorizeByMcc(null)).toBe(CATEGORY.other);
    expect(categorizeByMcc(3300)).toBe(CATEGORY.other); // gap between airline and car rental ranges
  });
});

describe('importCategorizer.categorizeByDescription rule order', () => {
  test('more specific rules win over generic ones', () => {
    expect(categorizeByDescription('UBER EATS 1234')).toBe('Food & Dining'); // before transport "uber"
    expect(categorizeByDescription('UBER TRIP')).toBe('Transport');
    expect(categorizeByDescription('CANADIAN TIRE GAS BAR')).toBe('Fuel'); // before shopping "canadian tire"
    expect(categorizeByDescription('NETFLIX.COM')).toBe('Subscriptions');
    expect(categorizeByDescription('Seashells shop')).toBe('Other'); // not "shell"
    expect(categorizeByDescription(null)).toBe('Other');
  });

  // 'cash' (with the generic keyword 'withdrawal') is checked before 'transfer',
  // so an Interac e-Transfer line that carries the word WITHDRAWAL is filed as
  // Cash instead of Transfer.
  test.skip('bug: "INTERAC E-TRANSFER WITHDRAWAL" is categorised as Cash, expected Transfer', () => {
    expect(categorizeByDescription('INTERAC E-TRANSFER WITHDRAWAL')).toBe('Transfer');
  });

  // Cyrillic keywords are stems with any ending, so the utilities stem 'газ'
  // also matches unrelated words: 'Газета' (newspaper), 'Газон' (lawn).
  test.skip('bug: Cyrillic stem "газ" files "Газета"/"Газон" under Utilities', () => {
    expect(categorizeByDescription('Газета Вечірній Київ')).not.toBe('Utilities');
    expect(categorizeByDescription('Газон і сад')).not.toBe('Utilities');
  });
});
