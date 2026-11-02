// test/unit-csv-parse.test.js — services/csvImportService low-level parsing:
// amounts in every format banks export, dates with ambiguous day/month order,
// RFC-4180 quoting, and a full preview (sign, totals, duplicate detection).
// Pure functions: no database, no network.

const csv = require('../services/csvImportService');

describe('parseAmount — formats and signs', () => {
  test.each([
    ['1,234.56', 1234.56],
    ['1 234,56', 1234.56],
    ['1.234,56', 1234.56],
    ['1.234.567,89', 1234567.89],
    ['1,234,567.891', 1234567.89],
    ['12,5', 12.5],
    ['.5', 0.5],
    ['€1.234,56', 1234.56],
    ['₴1 000,50', 1000.5],
    ['USD 12.50', 12.5],
    ['12.50 CAD', 12.5],
    ['1 000,00', 1000],
  ])('%s -> %p', (input, expected) => {
    expect(csv.parseAmount(input)).toBe(expected);
  });

  test.each([
    ['(45.00)', -45],
    ['-$45.00', -45],
    ['$-5.00', -5],
    ['45.00-', -45],
    ['45.00 DR', -45],
    ['45.00 CR', 45],
    ['−45.00', -45], // U+2212 minus sign
    ['–45.00', -45], // en dash
    ['+12.00', 12],
  ])('sign: %s -> %p', (input, expected) => {
    expect(csv.parseAmount(input)).toBe(expected);
  });

  test('half cents are rounded, never truncated', () => {
    expect(csv.parseAmount('1.005')).toBe(1.01);
    expect(csv.parseAmount('0.005')).toBe(0.01);
  });

  test('"2.500" is 2.5 by default but 2500 in a decimal-comma column', () => {
    expect(csv.parseAmount('2.500')).toBe(2.5);
    expect(csv.parseAmount('2.500', { decimalComma: true })).toBe(2500);
    expect(csv.inferDecimalComma(['-23,45', '1.234,56', '2.500'])).toBe(true);
    expect(csv.inferDecimalComma(['4.50', '1,234.56'])).toBe(false);
  });

  test.each([[''], ['   '], ['-'], ['CR'], ['USD'], ['abc'], ['+-5'], ['Infinity'], [null], [undefined]])(
    'not an amount: %p -> null',
    (input) => {
      expect(csv.parseAmount(input)).toBeNull();
    }
  );
});

describe('parseDate — formats, order and calendar validity', () => {
  test.each([
    ['2026-10-09', 'auto', '2026-10-09'],
    ['2026/1/5', 'auto', '2026-01-05'],
    ['20261009', 'auto', '2026-10-09'],
    ['09.10.2026', 'auto', '2026-10-09'],
    ['09.10.2026 14:22', 'auto', '2026-10-09'],
    ['2026-10-09T23:30:00Z', 'auto', '2026-10-09'],
    ['2026-10-09T23:30:00.000+05:00', 'auto', '2026-10-09'],
    ['Jan 5, 2026', 'auto', '2026-01-05'],
    ['5 Jan 2026', 'auto', '2026-01-05'],
    ['05-Jan-2026', 'auto', '2026-01-05'],
    ['Sept 5 2026', 'auto', '2026-09-05'],
    ['05/06/2026', 'MDY', '2026-05-06'],
    ['05/06/2026', 'DMY', '2026-06-05'],
    ['13/01/2026', 'auto', '2026-01-13'], // day > 12 forces DMY
    ['01/13/2026', 'auto', '2026-01-13'], // month position > 12 forces MDY
    ['1/5/26', 'MDY', '2026-01-05'],
    ['2028-02-29', 'auto', '2028-02-29'],
  ])('%s (%s) -> %s', (input, order, expected) => {
    expect(csv.parseDate(input, order)).toBe(expected);
  });

  test.each([['2026-02-29'], ['31/02/2026'], ['2026-13-01'], ['00/00/2026'], ['1899-01-01'], ['not a date'], [''], [null]])(
    'invalid: %p -> null',
    (input) => {
      expect(csv.parseDate(input)).toBeNull();
    }
  );

  test('01/13/2026 read as DMY is not a date (no month 13)', () => {
    expect(csv.parseDate('01/13/2026', 'DMY')).toBeNull();
  });

  test('inferDateOrder looks at the whole column', () => {
    expect(csv.inferDateOrder(['01/02/2026', '25/02/2026'])).toBe('DMY');
    expect(csv.inferDateOrder(['01/02/2026', '02/25/2026'])).toBe('MDY');
    expect(csv.inferDateOrder(['01/02/2026', '02/03/2026'])).toBeNull();
  });
});

describe('parseCsv / detectDelimiter', () => {
  test('quotes, doubled quotes, delimiter and newline inside quotes, CRLF, BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3';
    expect(csv.parseCsv(text, ',')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
  });

  test('a stray quote inside a cell does not swallow the rest of the file', () => {
    const rows = csv.parseCsv('2026-01-01,12" PIZZA,-9.99\n2026-01-02,Coffee,-3.00\n', ',');
    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBe('12" PIZZA');
  });

  test('detects ; tab and | delimiters', () => {
    expect(csv.detectDelimiter('a;b;c\n1;2,5;3\n')).toBe(';');
    expect(csv.detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
    expect(csv.detectDelimiter('a|b|c\n1|2|3\n')).toBe('|');
    expect(csv.detectDelimiter('')).toBe(',');
  });
});

describe('previewCsv — end to end on a generic debit/credit file', () => {
  const text = [
    '﻿Date,Description,Debit,Credit',
    '10/31/2026,"LOBLAWS, #123",45.10,',
    '11/01/2026,Payroll,,2500.00',
    '11/01/2026,Coffee,4.35,',
    '31/02/2026,Bad date,1.00,',
  ].join('\r\n');

  test('signs come from the debit/credit column; totals are exact to the cent', () => {
    const p = csv.previewCsv(text);
    expect(p.hasHeader).toBe(true);
    expect(p.delimiter).toBe(',');
    const valid = p.rows.filter((r) => !r.error);
    expect(valid.map((r) => [r.date, r.amount, r.type])).toEqual([
      ['2026-10-31', -45.1, 'expense'],
      ['2026-11-01', 2500, 'income'],
      ['2026-11-01', -4.35, 'expense'],
    ]);
    expect(p.stats).toMatchObject({ total: 4, valid: 3, errors: 1, income: 2500, expense: -49.45, sum: 2450.55 });
    expect(p.rows[3].error).toMatch(/date/i);
  });

  test('rows already imported are flagged as duplicates by fingerprint', () => {
    const first = csv.previewCsv(text);
    const fps = first.rows.filter((r) => !r.error).map((r) => r.fingerprint);
    expect(new Set(fps).size).toBe(3);
    const again = csv.previewCsv(text, { existingFingerprints: [fps[0]] });
    const flagged = again.rows.filter((r) => r.duplicate);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].description).toBe('LOBLAWS, #123');
  });

  test('fingerprint ignores case/spacing of the description but not the amount or date', () => {
    const a = csv.fingerprintOf('2026-11-01', -4.35, 'Coffee  Shop');
    expect(csv.fingerprintOf('2026-11-01', -4.35, 'coffee shop')).toBe(a);
    expect(csv.fingerprintOf('2026-11-01', -4.36, 'Coffee Shop')).not.toBe(a);
    expect(csv.fingerprintOf('2026-11-02', -4.35, 'Coffee Shop')).not.toBe(a);
  });

  test('an empty file and an unknown preset are rejected', () => {
    expect(() => csv.previewCsv('')).toThrow(/empty/i);
    expect(() => csv.previewCsv('a,b\n1,2', { presetId: 'nope' })).toThrow(/Unknown preset/);
  });
});
