// test/envelope.test.js — envelope / rollover budgeting (envelope-budgets stream).
//
// Покрывает:
//   1) формат бюджета отдаёт carryover + effectiveLimit (= amount + carryover);
//   2) rollForward переносит остаток (amount + carryover - spent) в carryover
//      следующего периода для rollover-бюджетов и сбрасывает spent;
//   3) НЕ-rollover бюджеты не получают перенос (spent НЕ трогаем здесь —
//      их сбрасывает существующий resetForNewPeriod, отдельный от rollForward);
//   4) перерасход переносится отрицательным carryover;
//   5) повторный rollForward аккумулирует перенос корректно (через lib/money);
//   6) HTTP: GET /api/budgets отдаёт carryover/effectiveLimit/rollover,
//      POST /api/budgets/roll-forward переносит остаток исходя из транзакций.
//
// Budget-роутер УЖЕ смонтирован в server.js -> можно ctx.request, но базовую
// арифметику переноса тестируем на модели напрямую (детерминированно: пишем
// spent сырым SQL, без зависимости от транзакций).

const { makeApp } = require('./helpers/app');

// db-хелперы и модель требуем ПОСЛЕ makeApp (require-кэш привязан к temp-БД).
function getDb() {
  return require('../db/database');
}
function getBudget() {
  return require('../models/budget');
}
function getMoney() {
  return require('../lib/money');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

// Хелпер: создать бюджет напрямую и проставить spent сырым SQL.
async function seedBudget(db, userId, { name, amount, spent = 0, rollover = 0, carryover = 0, period = 'monthly', category = null }) {
  const today = new Date().toISOString().split('T')[0];
  const res = await db.run(
    `INSERT INTO budgets
       (user_id, name, category, amount, spent, period, start_date, currency, notify_at_percent, rollover, carryover, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UAH', 80, ?, ?, 1)`,
    [userId, name, category, amount, spent, period, today, rollover ? 1 : 0, carryover]
  );
  return res.id;
}

describe('envelope/rollover: формат бюджета', () => {
  let ctx, db, Budget, money;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    Budget = getBudget();
    money = getMoney();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('effectiveLimit = amount + carryover; remaining/over считаются от него', async () => {
    // amount 1000, carryover 200, spent 1100 -> effectiveLimit 1200, remaining 100, НЕ over.
    const id = await seedBudget(db, ctx.userId, {
      name: 'Конверт', amount: 1000, spent: 1100, rollover: 1, carryover: 200,
    });
    const budget = await Budget.findById(id, ctx.userId);

    expect(budget.rollover).toBe(true);
    expect(budget.carryover).toBe(200);
    expect(budget.effectiveLimit).toBe(1200);
    expect(budget.remaining).toBe(100);
    expect(budget.isOverBudget).toBe(false);
  });

  test('отрицательный carryover уменьшает effectiveLimit и даёт over-budget', async () => {
    // amount 500, carryover -100, spent 450 -> limit 400, remaining -50, over.
    const id = await seedBudget(db, ctx.userId, {
      name: 'Долг по конверту', amount: 500, spent: 450, rollover: 1, carryover: -100,
    });
    const budget = await Budget.findById(id, ctx.userId);

    expect(budget.effectiveLimit).toBe(400);
    expect(budget.remaining).toBe(-50);
    expect(budget.isOverBudget).toBe(true);
  });

  test('не-rollover бюджет: carryover 0, effectiveLimit = amount (обратная совместимость)', async () => {
    const id = await seedBudget(db, ctx.userId, {
      name: 'Обычный', amount: 800, spent: 300, rollover: 0, carryover: 0,
    });
    const budget = await Budget.findById(id, ctx.userId);

    expect(budget.rollover).toBe(false);
    expect(budget.carryover).toBe(0);
    expect(budget.effectiveLimit).toBe(800);
    expect(budget.remaining).toBe(500);
  });
});

describe('envelope/rollover: Budget.rollForward', () => {
  let ctx, db, Budget;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    Budget = getBudget();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('остаток переносится в carryover следующего периода, spent сбрасывается', async () => {
    // amount 1000, carryover 0, spent 700 -> leftover 300 переносится.
    const id = await seedBudget(db, ctx.userId, {
      name: 'Продукты', amount: 1000, spent: 700, rollover: 1, carryover: 0,
    });

    const rolled = await Budget.rollForward(ctx.userId, 'monthly');
    expect(rolled.some((r) => r.id === id && r.carryover === 300)).toBe(true);

    const budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(300);
    expect(budget.spent).toBe(0);
    expect(budget.effectiveLimit).toBe(1300); // 1000 + 300
  });

  test('перерасход переносится ОТРИЦАТЕЛЬНЫМ carryover', async () => {
    // amount 500, carryover 0, spent 650 -> leftover -150.
    const id = await seedBudget(db, ctx.userId, {
      name: 'Перерасход', amount: 500, spent: 650, rollover: 1, carryover: 0,
    });

    await Budget.rollForward(ctx.userId, 'monthly');

    const budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(-150);
    expect(budget.spent).toBe(0);
    expect(budget.effectiveLimit).toBe(350); // 500 - 150
  });

  test('накопленный перенос аккумулируется за два периода', async () => {
    // amount 1000, начинаем с carryover 200, spent 500.
    // leftover = 1000 + 200 - 500 = 700 после первого rollForward.
    const id = await seedBudget(db, ctx.userId, {
      name: 'Накопление', amount: 1000, spent: 500, rollover: 1, carryover: 200,
    });

    await Budget.rollForward(ctx.userId, 'monthly');
    let budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(700);
    expect(budget.spent).toBe(0);

    // Второй период: тратим 300 -> leftover = 1000 + 700 - 300 = 1400.
    await db.run(`UPDATE budgets SET spent = 300 WHERE id = ?`, [id]);
    await Budget.rollForward(ctx.userId, 'monthly');
    budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(1400);
    expect(budget.spent).toBe(0);
  });

  test('не-rollover бюджет НЕ затрагивается rollForward', async () => {
    const id = await seedBudget(db, ctx.userId, {
      name: 'Не переносить', amount: 600, spent: 400, rollover: 0, carryover: 0,
    });

    const rolled = await Budget.rollForward(ctx.userId, 'monthly');
    expect(rolled.some((r) => r.id === id)).toBe(false);

    const budget = await Budget.findById(id, ctx.userId);
    // spent и carryover не тронуты (сброс spent делает resetForNewPeriod).
    expect(budget.spent).toBe(400);
    expect(budget.carryover).toBe(0);
  });

  test('rollForward переносит только бюджеты выбранного периода', async () => {
    const monthlyId = await seedBudget(db, ctx.userId, {
      name: 'Месячный конверт', amount: 1000, spent: 600, rollover: 1, period: 'monthly',
    });
    const weeklyId = await seedBudget(db, ctx.userId, {
      name: 'Недельный конверт', amount: 200, spent: 50, rollover: 1, period: 'weekly',
    });

    await Budget.rollForward(ctx.userId, 'weekly');

    const monthly = await Budget.findById(monthlyId, ctx.userId);
    const weekly = await Budget.findById(weeklyId, ctx.userId);

    // Месячный не тронут (мы переносили только weekly).
    expect(monthly.spent).toBe(600);
    expect(monthly.carryover).toBe(0);
    // Недельный перенесён: leftover = 200 - 50 = 150.
    expect(weekly.spent).toBe(0);
    expect(weekly.carryover).toBe(150);
  });
});

describe('envelope/rollover: HTTP /api/budgets', () => {
  let ctx, db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('POST /api/budgets с rollover -> GET отдаёт rollover/carryover/effectiveLimit', async () => {
    const createRes = await ctx.request
      .post('/api/budgets')
      .set(AUTH(ctx.token))
      .send({ name: 'HTTP конверт', amount: 1000, period: 'monthly', rollover: true });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.budget.rollover).toBe(true);
    expect(createRes.body.budget.carryover).toBe(0);
    expect(createRes.body.budget.effectiveLimit).toBe(1000);

    const listRes = await ctx.request.get('/api/budgets').set(AUTH(ctx.token));
    expect(listRes.status).toBe(200);
    const created = listRes.body.find((b) => b.name === 'HTTP конверт');
    expect(created).toBeTruthy();
    expect(created.rollover).toBe(true);
    expect(created).toHaveProperty('carryover', 0);
    expect(created).toHaveProperty('effectiveLimit', 1000);
  });

  test('POST /api/budgets/roll-forward переносит остаток по транзакциям', async () => {
    // Счёт + категория «Кафе»; бюджет 1000 rollover, трат на 400 в этом месяце.
    const acct = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'Тест-счёт', 'UAH', 0, 1)`,
      [ctx.userId]
    );
    const today = new Date().toISOString().split('T')[0];
    const monthStart = `${today.slice(0, 7)}-05`; // 5-е число текущего месяца
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, 'кофе', 'Кафе', 400, 'expense')`,
      [acct.id, ctx.userId, monthStart]
    );

    const budgetRes = await ctx.request
      .post('/api/budgets')
      .set(AUTH(ctx.token))
      .send({ name: 'Кафе-конверт', amount: 1000, period: 'monthly', category: 'Кафе', rollover: true });
    const budgetId = budgetRes.body.budget.id;

    const rollRes = await ctx.request
      .post('/api/budgets/roll-forward')
      .set(AUTH(ctx.token))
      .send({ period: 'monthly' });

    expect(rollRes.status).toBe(200);
    expect(rollRes.body.success).toBe(true);
    expect(rollRes.body.rolledCount).toBeGreaterThanOrEqual(1);

    const after = rollRes.body.budgets.find((b) => b.id === budgetId);
    expect(after).toBeTruthy();
    // leftover = 1000 - 400 = 600 переносится, spent сброшен в 0.
    expect(after.carryover).toBe(600);
    expect(after.spent).toBe(0);
    expect(after.effectiveLimit).toBe(1600);
  });

  test('POST /api/budgets/roll-forward с невалидным периодом -> 400', async () => {
    const res = await ctx.request
      .post('/api/budgets/roll-forward')
      .set(AUTH(ctx.token))
      .send({ period: 'bogus' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(true);
  });
});
