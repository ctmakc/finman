// test/regression-money-rounding.test.js — lib/money.round half-cent rounding.
//
// Bug 1: negative half cents rounded toward +infinity (Math.round(-100.5) is
//        -100), so -1.005 became -1.00 while 1.005 became 1.01.
// Bug 2: the Number.EPSILON nudge only works for values near 1; a larger
//        product such as 2592.315 (amount x FX rate) lost its half cent.

const money = require('../lib/money');

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

describe('money.round — half a cent rounds away from zero for both signs', () => {
  test.each([
    [1.005, 1.01],
    [-1.005, -1.01],
    [0.125, 0.13],
    [-0.125, -0.13],
    [2.675, 2.68],
    [-2.675, -2.68],
    [-10.235, -10.24],
    [2592.315, 2592.32],
    [-2592.315, -2592.32],
  ])('round(%p) = %p', (input, expected) => {
    expect(money.round(input)).toBe(expected);
  });

  test('round(-x) === -round(x) for random half-cent values', () => {
    const r = rng(1);
    for (let i = 0; i < 5000; i++) {
      const x = (Math.floor(r() * 1e8) + 0.5) / 100; // xxx.xx5
      expect(money.round(-x)).toBe(-money.round(x));
    }
  });

  test('tiny negatives become 0, not -0', () => {
    expect(Object.is(money.round(-0.001), 0)).toBe(true);
    expect(Object.is(money.sub(0.1, 0.1), 0)).toBe(true);
  });

  test('mul(amount, rate) equals the exact product rounded half away from zero', () => {
    const r = rng(99);
    for (let i = 0; i < 3000; i++) {
      const cents = Math.floor(r() * 1e7) + 1;
      const rate4 = Math.round(r() * 1e4); // rate with 4 decimals, as an integer
      const exact = cents * rate4; // product in 1/1e6 units, exact
      const expectedCents = Math.floor((exact + 5000) / 1e4);
      expect(Math.round(money.mul(cents / 100, rate4 / 1e4) * 100)).toBe(expectedCents);
      expect(Math.round(money.mul(-cents / 100, rate4 / 1e4) * 100)).toBe(-expectedCents || 0);
    }
  });
});
