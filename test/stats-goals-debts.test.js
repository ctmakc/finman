// test/stats-goals-debts.test.js — wave3/stats: /api/goals/stats и /api/debts/stats
// раньше падали 500 («getUserStats is not a function»), а списки не отдавали
// remaining/progress — карточки показывали «Достигнута!» при 0 %.
const { makeApp } = require('./helpers/app');
const dates = require('../lib/dates');

const AUTH = (t) => ({ Authorization: `Bearer ${t}` });

describe('goals: stats + progress fields', () => {
  let ctx;
  let db;
  const today = dates.todayISO();

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    // Активная цель 21 %: 3200 / 15000, дедлайн через 40 дней.
    await db.run(
      `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, target_date) VALUES (?, ?, ?, ?, ?)`,
      [ctx.userId, 'Vacation', 15000, 3200, dates.addDaysISO(today, 40)]
    );
    // Активная цель 0 %, дедлайн через 10 дней (ближайший).
    await db.run(
      `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, target_date) VALUES (?, ?, ?, ?, ?)`,
      [ctx.userId, 'Laptop', 5000, 0, dates.addDaysISO(today, 10)]
    );
    // Выполненная цель — в активные не входит.
    await db.run(
      `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, is_completed) VALUES (?, ?, ?, ?, 1)`,
      [ctx.userId, 'Done', 1000, 1000]
    );
    // Удалённая (is_active=0) — не учитывается вовсе.
    await db.run(
      `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, is_active) VALUES (?, ?, ?, ?, 0)`,
      [ctx.userId, 'Deleted', 99999, 0]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/goals/stats -> 200 с полями, которые читает фронт', async () => {
    const res = await ctx.request.get('/api/goals/stats').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.activeGoals).toBe(2);
    expect(res.body.completedGoals).toBe(1);
    expect(res.body.totalGoals).toBe(3);
    expect(res.body.totalTarget).toBe(20000);
    expect(res.body.totalSaved).toBe(3200);
    expect(res.body.totalRemaining).toBe(16800);
    expect(res.body.overallProgress).toBe(16);
    expect(res.body.nextDeadline).toMatchObject({ name: 'Laptop', daysLeft: 10, remaining: 5000 });
  });

  test('GET /api/goals -> remaining/progress; 21 % не «достигнута»', async () => {
    const res = await ctx.request.get('/api/goals').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const vacation = res.body.find((g) => g.name === 'Vacation');
    expect(vacation.remaining).toBe(11800);
    expect(vacation.progress).toBeCloseTo(21.33, 1);
    expect(vacation.isReached).toBe(false);
    expect(vacation.daysLeft).toBe(40);
    expect(vacation.monthlyRequired).toBeGreaterThan(0);
    const laptop = res.body.find((g) => g.name === 'Laptop');
    expect(laptop.progress).toBe(0);
    expect(laptop.remaining).toBe(5000);
  });

  test('GET /api/goals/:id -> те же вычисляемые поля', async () => {
    const list = await ctx.request.get('/api/goals').set(AUTH(ctx.token));
    const id = list.body.find((g) => g.name === 'Vacation').id;
    const res = await ctx.request.get(`/api/goals/${id}`).set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(11800);
  });

  test('stats без целей -> нули, nextDeadline null', async () => {
    const SavingsGoal = require('../models/savingsGoal');
    const s = await SavingsGoal.getUserStats(999999);
    expect(s).toMatchObject({ activeGoals: 0, totalSaved: 0, overallProgress: 0, nextDeadline: null });
  });
});

describe('debts: stats + remaining/progress/isOverdue', () => {
  let ctx;
  let db;
  const today = dates.todayISO();

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
    // Кредит 18 500, выплачено 0, срок через 20 дней (в окне 30 дней).
    await db.run(
      `INSERT INTO debts (user_id, name, type, amount, paid_amount, start_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ctx.userId, 'Car loan', 'credit', 18500, 0, '2026-01-01', dates.addDaysISO(today, 20)]
    );
    // Я должен другу 1000, выплачено 400, просрочен (срок вчера).
    await db.run(
      `INSERT INTO debts (user_id, name, type, amount, paid_amount, start_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ctx.userId, 'Friend', 'i_owe', 1000, 400, '2026-01-01', dates.addDaysISO(today, -1)]
    );
    // Мне должны 3000, выплачено 500, срок через 90 дней (вне окна 30 дней).
    await db.run(
      `INSERT INTO debts (user_id, name, type, amount, paid_amount, start_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ctx.userId, 'Client', 'owe_me', 3000, 500, '2026-01-01', dates.addDaysISO(today, 90)]
    );
    // Погашенный — только в paidDebts.
    await db.run(
      `INSERT INTO debts (user_id, name, type, amount, paid_amount, start_date, is_paid) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [ctx.userId, 'Old', 'loan', 500, 500, '2025-01-01']
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/debts/stats -> 200 и поля фронта + агрегаты', async () => {
    const res = await ctx.request.get('/api/debts/stats').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const s = res.body;
    expect(s.activeDebts).toBe(3);
    expect(s.paidDebts).toBe(1);
    expect(s.totalIOwe).toBe(19100); // 18500 + 600
    expect(s.totalOwedToMe).toBe(2500);
    expect(s.netBalance).toBe(-16600);
    expect(s.totalOwed).toBe(22500);
    expect(s.totalPaid).toBe(900);
    expect(s.totalRemaining).toBe(21600);
    expect(s.monthlyPaymentsDue).toBe(18500); // только Car loan в окне 30 дней
    expect(s.overdueCount).toBe(1);
    expect(s.nextDue).toMatchObject({ name: 'Car loan', daysUntilDue: 20, remaining: 18500 });
    // совместимость со старым getStats
    expect(s.iOwe).toBe(19100);
    expect(s.balance).toBe(-16600);
  });

  test('GET /api/debts -> remaining/progress/isOverdue; невыплаченный кредит не «Выплачено!»', async () => {
    const res = await ctx.request.get('/api/debts').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const loan = res.body.find((d) => d.name === 'Car loan');
    expect(loan.remaining).toBe(18500);
    expect(loan.progress).toBe(0);
    expect(loan.isOverdue).toBe(false);
    expect(loan.isPaid).toBe(false);
    const friend = res.body.find((d) => d.name === 'Friend');
    expect(friend.remaining).toBe(600);
    expect(friend.progress).toBe(40);
    expect(friend.isOverdue).toBe(true);
    expect(friend.daysUntilDue).toBe(-1);
  });

  test('GET /api/debts/upcoming -> 200 (раньше getUpcomingPayments не существовал)', async () => {
    const res = await ctx.request.get('/api/debts/upcoming?days=30').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.name)).toEqual(['Car loan']);
    expect(res.body[0].remaining).toBe(18500);
  });
});
