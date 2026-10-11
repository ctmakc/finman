// test/bank-import-fixes.test.js — regressions from the bank import & sync review.
//
// Each describe block pins one finding so a revert shows up by name.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'bank-import');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const csv = require(path.join(PROJECT_ROOT, 'services', 'csvImportService.js'));

const ms = (fn) => {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

describe('ReDoS: number detection on hostile cells', () => {
  test('a 100k-char "1   …   !" cell is classified in under 50 ms', () => {
    const cell = '1' + ' '.repeat(100000) + '!';
    // detectHeader runs looksLikeNumber/looksLikeDate on every cell of the first two rows.
    expect(ms(() => csv.detectHeader([[cell, 'x'], ['2026-10-01', '1.00']]))).toBeLessThan(50);
    expect(ms(() => csv.detectHeader([['Date', 'Amount'], ['2026-10-01', cell]]))).toBeLessThan(50);
  });

  test('a whole preview with such a cell stays linear', () => {
    const cell = '1' + ' '.repeat(100000) + '!';
    const text = `Date,Description,Amount\n2026-10-01,"${cell}",-1.00\n`;
    expect(ms(() => csv.previewCsv(text))).toBeLessThan(1000);
  });

  test('ordinary amounts still count as numbers', () => {
    const p = csv.previewCsv('Date;Description;Amount\n2026-10-01;Coffee;1 234,56 UAH\n2026-10-02;Tea;-$45.00\n');
    expect(p.mapping.amount).toBe(2);
    expect(p.rows.map((r) => r.amount)).toEqual([1234.56, -45]);
  });
});
