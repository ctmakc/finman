// test/progress-helpers.test.js — pure progress helpers exported by
// public/js/goals.js and public/js/debts.js (CRITIQUE #5: inverted
// "reached / paid" logic, progress bar at 0% for 3 200 / 15 000).

const path = require('path');
const { goalProgress, goalsSummary } = require(path.join('..', 'public', 'js', 'goals.js'));
const { debtProgress, debtsSummary } = require(path.join('..', 'public', 'js', 'debts.js'));

describe('goalProgress', () => {
  test('3 200 of 15 000 is 21% and NOT reached (API without remaining)', () => {
    const p = goalProgress({ target_amount: 15000, current_amount: 3200 });
    expect(p.pct).toBe(21);
    expect(p.percent).toBeCloseTo(21.333, 2);
    expect(p.remaining).toBe(11800);
    expect(p.reached).toBe(false);
  });

  test('0 of 3 500 is 0% and not reached', () => {
    const p = goalProgress({ target_amount: 3500, current_amount: 0 });
    expect(p.pct).toBe(0);
    expect(p.reached).toBe(false);
    expect(p.remaining).toBe(3500);
  });

  test('reached when current >= target, or when API says is_completed', () => {
    expect(goalProgress({ target_amount: 100, current_amount: 100 }).reached).toBe(true);
    expect(goalProgress({ target_amount: 100, current_amount: 250 }).percent).toBe(100);
    expect(goalProgress({ target_amount: 100, current_amount: 10, is_completed: 1 }).reached).toBe(true);
  });

  test('API remaining / percent win over client math', () => {
    const p = goalProgress({ target_amount: 100, current_amount: 10, remaining: 0, percent: 100 });
    expect(p.remaining).toBe(0);
    expect(p.pct).toBe(100);
    expect(p.reached).toBe(true);
  });

  test('tolerates strings and missing fields', () => {
    const p = goalProgress({ target_amount: '200', current_amount: '50' });
    expect(p.pct).toBe(25);
    expect(goalProgress({}).reached).toBe(false);
    expect(goalProgress(null).pct).toBe(0);
  });
});

describe('goalsSummary', () => {
  test('groups saved/target per currency and counts active/completed', () => {
    const s = goalsSummary([
      { target_amount: 15000, current_amount: 3200, currency: 'CAD' },
      { target_amount: 3500, current_amount: 0, currency: 'CAD' },
      { target_amount: 1000, current_amount: 1000, currency: 'UAH' },
    ]);
    expect(s.total).toBe(3);
    expect(s.active).toBe(2);
    expect(s.completed).toBe(1);
    expect(s.byCurrency.CAD).toEqual({ saved: 3200, target: 18500, percent: 17 });
    expect(s.byCurrency.UAH).toEqual({ saved: 1000, target: 1000, percent: 100 });
    expect(Object.keys(s.byCurrency)).toHaveLength(2); // never merged into one number
  });

  test('empty input', () => {
    expect(goalsSummary([])).toEqual({ total: 0, active: 0, completed: 0, byCurrency: {} });
    expect(goalsSummary(undefined).total).toBe(0);
  });
});

describe('debtProgress', () => {
  test('18 500 loan with 450 paid is 2% and NOT paid', () => {
    const p = debtProgress({ type: 'i_owe', amount: 18500, paid_amount: 450, due_date: '2031-03-01' }, '2026-10-10');
    expect(p.pct).toBe(2);
    expect(p.remaining).toBe(18050);
    expect(p.isPaid).toBe(false);
    expect(p.isOverdue).toBe(false);
    expect(p.isIOwe).toBe(true);
  });

  test('paid when paid_amount >= amount or is_paid flag', () => {
    expect(debtProgress({ amount: 600, paid_amount: 600 }).isPaid).toBe(true);
    expect(debtProgress({ amount: 600, paid_amount: 10, is_paid: 1 }).isPaid).toBe(true);
    expect(debtProgress({ amount: 600, paid_amount: 900 }).percent).toBe(100);
  });

  test('overdue only when due date passed and debt is unpaid', () => {
    expect(debtProgress({ amount: 100, paid_amount: 0, due_date: '2026-01-01' }, '2026-10-10').isOverdue).toBe(true);
    expect(debtProgress({ amount: 100, paid_amount: 100, due_date: '2026-01-01' }, '2026-10-10').isOverdue).toBe(false);
    expect(debtProgress({ amount: 100, paid_amount: 0, due_date: '2026-12-01' }, '2026-10-10').isOverdue).toBe(false);
    expect(debtProgress({ amount: 100, paid_amount: 0, due_date: '2026-01-01', isOverdue: false }, '2026-10-10').isOverdue).toBe(false);
  });

  test('API remaining wins; owe_me is not "I owe"', () => {
    const p = debtProgress({ type: 'owe_me', amount: 600, paid_amount: 0, remaining: 100 });
    expect(p.remaining).toBe(100);
    expect(p.isIOwe).toBe(false);
  });
});

describe('debtsSummary', () => {
  test('per-currency remaining balances for I-owe / owed-to-me / net', () => {
    const s = debtsSummary([
      { type: 'i_owe', amount: 18500, paid_amount: 450, currency: 'CAD' },
      { type: 'owe_me', amount: 600, paid_amount: 0, currency: 'CAD' },
      { type: 'credit', amount: 1000, paid_amount: 1000, currency: 'UAH' }, // paid -> excluded from totals
      { type: 'owe_me', amount: 500, paid_amount: 100, currency: 'UAH' },
    ], '2026-10-10');
    expect(s.active).toBe(3);
    expect(s.paid).toBe(1);
    expect(s.byCurrency.CAD).toEqual({ iOwe: 18050, oweMe: 600, net: -17450 });
    expect(s.byCurrency.UAH).toEqual({ iOwe: 0, oweMe: 400, net: 400 });
  });

  test('counts overdue debts', () => {
    const s = debtsSummary([{ type: 'i_owe', amount: 10, paid_amount: 0, due_date: '2020-01-01' }], '2026-10-10');
    expect(s.overdue).toBe(1);
  });
});
