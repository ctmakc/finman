// test/unit-import-categorizer.test.js — MCC mapping (untested before) and the
// keyword rules' ordering / word-boundary behaviour of services/importCategorizer.
'use strict';

const { CATEGORY, categorizeByMcc, categorizeByDescription } = require('../services/importCategorizer');

describe('categorizeByMcc', () => {
  test('exact codes map to their category (numbers or numeric strings)', () => {
    expect(categorizeByMcc(5411)).toBe(CATEGORY.groceries);
    expect(categorizeByMcc('5812')).toBe(CATEGORY.dining);
    expect(categorizeByMcc(5541)).toBe(CATEGORY.fuel);
    expect(categorizeByMcc(6011)).toBe(CATEGORY.cash);
    expect(categorizeByMcc(4829)).toBe(CATEGORY.transfer);
    expect(categorizeByMcc(4900)).toBe(CATEGORY.utilities);
    expect(categorizeByMcc(9311)).toBe(CATEGORY.taxes);
    expect(categorizeByMcc(6300)).toBe(CATEGORY.fees);
  });

  test('range fallbacks: airlines, car rental, hotels, apparel, misc retail, entertainment, medical', () => {
    expect(categorizeByMcc(3001)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(3299)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(3351)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(3441)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(3501)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(3999)).toBe(CATEGORY.travel);
    expect(categorizeByMcc(5655)).toBe(CATEGORY.shopping);
    expect(categorizeByMcc(5950)).toBe(CATEGORY.shopping);
    expect(categorizeByMcc(7850)).toBe(CATEGORY.entertainment);
    expect(categorizeByMcc(8075)).toBe(CATEGORY.health);
  });

  test('exact mapping beats range (5912 pharmacy is health, not misc retail)', () => {
    expect(categorizeByMcc(5912)).toBe(CATEGORY.health);
    expect(categorizeByMcc(5983)).toBe(CATEGORY.fuel);
  });

  test('gaps between ranges and junk input fall back to Other', () => {
    expect(categorizeByMcc(3300)).toBe(CATEGORY.other);
    expect(categorizeByMcc(3450)).toBe(CATEGORY.other);
    expect(categorizeByMcc(9999)).toBe(CATEGORY.other);
    expect(categorizeByMcc(7399)).toBe(CATEGORY.other);
    expect(categorizeByMcc('abc')).toBe(CATEGORY.other);
    expect(categorizeByMcc(undefined)).toBe(CATEGORY.other);
    expect(categorizeByMcc(null)).toBe(CATEGORY.other);
  });
});

describe('categorizeByDescription', () => {
  test('rule order: income-ish rules win over generic merchants', () => {
    // "refund" is checked before shopping (amazon)
    expect(categorizeByDescription('AMAZON REFUND 123')).toBe(CATEGORY.refund);
    // "payroll" beats "transfer"
    expect(categorizeByDescription('Payroll transfer ACME')).toBe(CATEGORY.salary);
    // "uber eats" (dining) beats "uber" (transport); plain uber is transport
    expect(categorizeByDescription('UBER EATS order')).toBe(CATEGORY.dining);
    expect(categorizeByDescription('UBER *TRIP')).toBe(CATEGORY.transport);
    // "canadian tire gas" (fuel) beats "canadian tire" (shopping)
    expect(categorizeByDescription('CANADIAN TIRE GAS BAR #12')).toBe(CATEGORY.fuel);
    expect(categorizeByDescription('Canadian Tire #12')).toBe(CATEGORY.shopping);
  });

  test('keywords match whole words only (no substring false positives)', () => {
    expect(categorizeByDescription('Espresso House')).toBe(CATEGORY.other); // not 'esso'
    expect(categorizeByDescription('Parent teacher fund')).toBe(CATEGORY.other); // not 'rent'
    expect(categorizeByDescription('Магазин Сонечко')).toBe(CATEGORY.other); // not 'газ'
    expect(categorizeByDescription('TAXI KYIV')).toBe(CATEGORY.transport); // not 'tax'
  });

  test('plural / possessive Latin endings and Cyrillic stems are accepted', () => {
    expect(categorizeByDescription('RESTAURANTS GROUP')).toBe(CATEGORY.dining);
    expect(categorizeByDescription("WENDY'S #555")).toBe(CATEGORY.dining);
    expect(categorizeByDescription('Аптека Доброго дня')).toBe(CATEGORY.health);
    expect(categorizeByDescription('Зарплата за жовтень')).toBe(CATEGORY.salary);
    expect(categorizeByDescription('ПОДАТКОВА СЛУЖБА')).toBe(CATEGORY.taxes);
  });

  test('case-insensitive, and regex metacharacters in keywords are literal', () => {
    expect(categorizeByDescription('netflix.com')).toBe(CATEGORY.subscriptions);
    expect(categorizeByDescription('APPLE.COM/BILL 866')).toBe(CATEGORY.subscriptions);
    expect(categorizeByDescription('A&W Restaurant')).toBe(CATEGORY.dining);
    expect(categorizeByDescription('H&M Eaton')).toBe(CATEGORY.shopping);
  });

  test('empty / missing description -> Other', () => {
    expect(categorizeByDescription('')).toBe(CATEGORY.other);
    expect(categorizeByDescription(null)).toBe(CATEGORY.other);
    expect(categorizeByDescription('zzzz qqqq')).toBe(CATEGORY.other);
  });
});
