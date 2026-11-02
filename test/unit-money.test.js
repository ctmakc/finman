// test/unit-money.test.js — lib/money.js, checked against exact integer
// arithmetic in minor units (cents).
//
// Amounts are stored as 2-decimal Numbers. These tests model every value as an
// integer number of cents and require the float helpers to land on exactly the
// same cent value, so drift (0.1 + 0.2), lost cents and sign errors show up.

const money = require('../lib/money');

// Deterministic PRNG (mulberry32): no flaky property tests.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toCents = (x) => Math.round(x * 100);
const fromCents = (c) => c / 100;

describe('lib/money — basic contract', () => {
  test('round: 2 decimals, classic float drift is removed', () => {
    expect(money.round(0.1 + 0.2)).toBe(0.3);
    expect(money.round(1.005)).toBe(1.01);
    expect(money.round(2.675)).toBe(2.68);
    expect(money.round(1234.565)).toBe(1234.57);
    expect(money.round(10)).toBe(10);
  });

  test('round: non-finite and junk input become 0', () => {
    for (const v of [NaN, Infinity, -Infinity, 'abc', undefined, {}]) {
      expect(money.round(v)).toBe(0);
    }
    expect(money.round(null)).toBe(0);
    expect(money.round('12.345')).toBe(12.35);
  });

  test('add/sub/mul/div/sum: falsy operands count as 0', () => {
    expect(money.add(0.1, 0.2)).toBe(0.3);
    expect(money.add(1, null, undefined, '', 2)).toBe(3);
    expect(money.sub(10, 0.01)).toBe(9.99);
    expect(money.sub(null, 5)).toBe(-5);
    expect(money.mul(19.99, 3)).toBe(59.97);
    expect(money.div(10, 3)).toBe(3.33);
    expect(money.sum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(money.sum('not an array')).toBe(0);
    expect(money.sum([])).toBe(0);
  });

  test('div by zero / junk divisor returns 0 instead of Infinity/NaN', () => {
    expect(money.div(100, 0)).toBe(0);
    expect(money.div(100, null)).toBe(0);
    expect(money.div(100, 'x')).toBe(0);
  });
});

describe('lib/money — agrees with integer cents', () => {
  test('add/sub of random cent values equals the integer result', () => {
    const r = rng(42);
    for (let i = 0; i < 5000; i++) {
      const a = Math.floor((r() - 0.5) * 2e7); // ±100 000.00
      const b = Math.floor((r() - 0.5) * 2e7);
      expect(toCents(money.add(fromCents(a), fromCents(b)))).toBe(a + b);
      expect(toCents(money.sub(fromCents(a), fromCents(b)))).toBe(a - b);
    }
  });

  test('summing many small amounts does not drift (1 000 x 0.01 = 10.00)', () => {
    const many = Array.from({ length: 1000 }, () => 0.01);
    expect(money.sum(many)).toBe(10);
    let running = 0;
    for (let i = 0; i < 1000; i++) running = money.add(running, 0.1);
    expect(running).toBe(100);
  });

  test('a month of random expenses: sum == integer sum of cents', () => {
    const r = rng(7);
    const cents = Array.from({ length: 400 }, () => Math.floor(r() * 50000) + 1);
    const expected = cents.reduce((a, c) => a + c, 0);
    expect(toCents(money.sum(cents.map(fromCents)))).toBe(expected);
  });
});
