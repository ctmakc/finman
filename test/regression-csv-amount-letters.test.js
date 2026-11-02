// test/regression-csv-amount-letters.test.js — parseAmount used to strip every
// non-digit character, so letters BETWEEN digits vanished: "1e5" imported as
// 15, "12a34" as 1234, "0x10" as 10. Such cells are not amounts.

const csv = require('../services/csvImportService');

describe('parseAmount — letters inside the number', () => {
  test.each([['1e5'], ['1E5'], ['12a34'], ['0x10'], ['12.5e3'], ['4O.00']])('%s -> null', (input) => {
    expect(csv.parseAmount(input)).toBeNull();
  });

  test.each([
    ['CAD12.50', 12.5],
    ['12.50CAD', 12.5],
    ['USD 1,234.56', 1234.56],
    ['1,234.56 USD', 1234.56],
    ['45.00CR', 45],
    ['45.00DR', -45],
    ['100USD-', -100],
    ['12.50 USD CR', 12.5],
  ])('currency codes and CR/DR around the number still parse: %s -> %p', (input, expected) => {
    expect(csv.parseAmount(input)).toBe(expected);
  });

  test('a row with such a cell is reported as an error, not imported with a wrong amount', () => {
    const p = csv.previewCsv('Date,Description,Amount\n2026-11-01,Coffee,-4.35\n2026-11-01,Typo,1e5\n');
    expect(p.rows[0].amount).toBe(-4.35);
    expect(p.rows[1].error).toBeTruthy();
    expect(p.rows[1].amount == null || p.rows[1].amount === 0).toBe(true);
  });
});
