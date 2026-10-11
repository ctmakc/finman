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
  // rollForward закрывает ПРЕДЫДУЩИЙ период относительно today и считает его
  // расходы по транзакциям (раньше брался сохранённый spent текущего периода,
  // а повторный вызов добавлял перенос ещё раз). Поэтому здесь не сырой spent,
  // а расходы сентября при today = 2026-10-15 (детерминированно).
  const TODAY = '2026-10-15';
  let ctx, db, Budget, accountId;

  // Бюджет, начатый задолго до закрываемого периода.
  async function seedRolloverBudget(fields) {
    const res = await db.run(
      `INSERT INTO budgets
         (user_id, name, category, amount, spent, period, start_date, currency, notify_at_percent, rollover, carryover, is_active)
       VALUES (?, ?, ?, ?, 0, ?, '2026-01-01', 'UAH', 80, ?, ?, 1)`,
      [ctx.userId, fields.name, fields.category, fields.amount, fields.period || 'monthly',
        fields.rollover === 0 ? 0 : 1, fields.carryover || 0]
    );
    return res.id;
  }

  async function spend(category, amount, date) {
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, 'x', ?, ?, 'expense')`,
      [accountId, ctx.userId, date, category, -amount]
    );
  }

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    Budget = getBudget();
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active) VALUES (?, 'UAH card', 'UAH', 0, 1)`,
      [ctx.userId]
    );
    accountId = acc.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('остаток прошлого периода переносится в carryover, spent = текущий период', async () => {
    // amount 1000, carryover 0, сентябрь потрачено 700 -> leftover 300.
    const id = await seedRolloverBudget({ name: 'Продукты', category: 'Rf-food', amount: 1000 });
    await spend('Rf-food', 700, '2026-09-10');

    const rolled = await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    expect(rolled.some((r) => r.id === id && r.carryover === 300 && r.period === '2026-09-01')).toBe(true);

    const budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(300);
    expect(budget.spent).toBe(0);
    expect(budget.effectiveLimit).toBe(1300); // 1000 + 300
    expect(budget.lastRolledPeriod).toBe('2026-09-01');
  });

  test('перерасход переносится ОТРИЦАТЕЛЬНЫМ carryover', async () => {
    // amount 500, carryover 0, сентябрь потрачено 650 -> leftover -150.
    const id = await seedRolloverBudget({ name: 'Перерасход', category: 'Rf-over', amount: 500 });
    await spend('Rf-over', 650, '2026-09-20');

    await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });

    const budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(-150);
    expect(budget.spent).toBe(0);
    expect(budget.effectiveLimit).toBe(350); // 500 - 150
  });

  test('накопленный перенос аккумулируется за два периода', async () => {
    // amount 1000, начинаем с carryover 200, сентябрь 500.
    // leftover = 1000 + 200 - 500 = 700 после закрытия сентября.
    const id = await seedRolloverBudget({ name: 'Накопление', category: 'Rf-acc', amount: 1000, carryover: 200 });
    await spend('Rf-acc', 500, '2026-09-05');

    await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    let budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(700);
    expect(budget.spent).toBe(0);

    // Октябрь: тратим 300; 3 ноября закрывается октябрь -> 1000 + 700 - 300 = 1400.
    await spend('Rf-acc', 300, '2026-10-20');
    await Budget.rollForward(ctx.userId, 'monthly', { today: '2026-11-03' });
    budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(1400);
    expect(budget.spent).toBe(0);
  });

  test('повторный вызов в том же периоде ничего не меняет (300 не становится 600)', async () => {
    const id = await seedRolloverBudget({ name: 'Идемпотентность', category: 'Rf-idem', amount: 500 });
    await spend('Rf-idem', 200, '2026-09-12');
    await spend('Rf-idem', 40, '2026-10-02'); // текущий период

    const first = await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    expect(first.find((r) => r.id === id).carryover).toBe(300);
    const second = await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    expect(second.some((r) => r.id === id)).toBe(false);

    const budget = await Budget.findById(id, ctx.userId);
    expect(budget.carryover).toBe(300);
    expect(budget.spent).toBe(40); // расходы октября, а не 0 и не сентябрь
  });

  test('1-го числа закрывается прошлый месяц, а не только что начавшийся', async () => {
    const id = await seedRolloverBudget({ name: 'Первое число', category: 'Rf-first', amount: 1000 });
    await spend('Rf-first', 900, '2026-10-30');

    await Budget.rollForward(ctx.userId, 'monthly', { today: '2026-11-01' });
    const budget = await Budget.findById(id, ctx.userId);
    // Октябрь: 1000 - 900 = 100 (раньше ноябрь с нулём трат давал 1000).
    expect(budget.carryover).toBe(100);
    expect(budget.lastRolledPeriod).toBe('2026-10-01');
  });

  test('пропущенные периоды закрываются по очереди', async () => {
    const id = await seedRolloverBudget({ name: 'Пропуски', category: 'Rf-gap', amount: 100 });
    await db.run(`UPDATE budgets SET last_rolled_period = '2026-07-01' WHERE id = ?`, [id]);
    await spend('Rf-gap', 30, '2026-08-15');
    await spend('Rf-gap', 120, '2026-09-15');

    await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    const budget = await Budget.findById(id, ctx.userId);
    // август: 100 + 0 - 30 = 70; сентябрь: 100 + 70 - 120 = 50.
    expect(budget.carryover).toBe(50);
    expect(budget.lastRolledPeriod).toBe('2026-09-01');
  });

  test('бюджет, начатый в текущем периоде, не переносится', async () => {
    const res = await db.run(
      `INSERT INTO budgets (user_id, name, category, amount, period, start_date, currency, rollover, carryover, is_active)
       VALUES (?, 'Новый', 'Rf-new', 100, 'monthly', '2026-10-03', 'UAH', 1, 0, 1)`,
      [ctx.userId]
    );
    const rolled = await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    expect(rolled.some((r) => r.id === res.id)).toBe(false);
  });

  test('расходы в другой валюте считаются в валюте бюджета', async () => {
    const id = await seedRolloverBudget({ name: 'FX', category: 'Rf-fx', amount: 5000 });
    const cad = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active) VALUES (?, 'CAD chq', 'CAD', 0, 1)`,
      [ctx.userId]
    );
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-09-10', 'x', 'Rf-fx', -100, 'expense')`,
      [cad.id, ctx.userId]
    );
    await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    const budget = await Budget.findById(id, ctx.userId);
    // 100 CAD — это не 100 UAH: в гривнах трата намного больше 100.
    expect(budget.carryover).toBeLessThan(5000 - 1000);
  });

  test('не-rollover бюджет НЕ затрагивается rollForward', async () => {
    const id = await seedRolloverBudget({ name: 'Не переносить', category: 'Rf-no', amount: 600, rollover: 0 });
    await db.run(`UPDATE budgets SET spent = 400 WHERE id = ?`, [id]);

    const rolled = await Budget.rollForward(ctx.userId, 'monthly', { today: TODAY });
    expect(rolled.some((r) => r.id === id)).toBe(false);

    const budget = await Budget.findById(id, ctx.userId);
    // spent и carryover не тронуты (сброс spent делает resetForNewPeriod).
    expect(budget.spent).toBe(400);
    expect(budget.carryover).toBe(0);
  });

  test('rollForward переносит только бюджеты выбранного периода', async () => {
    const monthlyId = await seedRolloverBudget({ name: 'Месячный конверт', category: 'Rf-m', amount: 1000 });
    const weeklyId = await seedRolloverBudget({ name: 'Недельный конверт', category: 'Rf-w', amount: 200, period: 'weekly' });
    await spend('Rf-m', 600, '2026-09-08');
    // 2026-10-15 — четверг; прошлая неделя — пн 10-05 .. вс 10-11.
    await spend('Rf-w', 50, '2026-10-07');

    await Budget.rollForward(ctx.userId, 'weekly', { today: TODAY });

    const monthly = await Budget.findById(monthlyId, ctx.userId);
    const weekly = await Budget.findById(weeklyId, ctx.userId);

    // Месячный не тронут (мы переносили только weekly).
    expect(monthly.carryover).toBe(0);
    expect(monthly.lastRolledPeriod).toBe(null);
    // Недельный перенесён: leftover = 200 - 50 = 150.
    expect(weekly.spent).toBe(0);
    expect(weekly.carryover).toBe(150);
    expect(weekly.lastRolledPeriod).toBe('2026-10-05');
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

  test('POST /api/budgets/roll-forward переносит остаток прошлого месяца по транзакциям', async () => {
    // Счёт + категория «Кафе»; бюджет 1000 rollover с прошлого месяца, трат на
    // 400 в прошлом месяце. Перенос закрывает прошлый месяц (день пользователя).
    const dates = require('../lib/dates');
    const today = dates.todayISO(dates.DEFAULT_TZ);
    const prevMonthStart = dates.addMonthsISO(dates.startOfMonthISO(today), -1, 1);
    const acct = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'Тест-счёт', 'CAD', 0, 1)`,
      [ctx.userId]
    );
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, 'кофе', 'Кафе', 400, 'expense')`,
      [acct.id, ctx.userId, dates.addDaysISO(prevMonthStart, 4)]
    );

    const budgetRes = await ctx.request
      .post('/api/budgets')
      .set(AUTH(ctx.token))
      .send({ name: 'Кафе-конверт', amount: 1000, period: 'monthly', category: 'Кафе', rollover: true, startDate: prevMonthStart, currency: 'CAD' });
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
    // leftover = 1000 - 400 = 600 переносится; трат в текущем месяце нет.
    expect(after.carryover).toBe(600);
    expect(after.spent).toBe(0);
    expect(after.effectiveLimit).toBe(1600);

    // Повторное нажатие кнопки — ничего не переносит.
    const again = await ctx.request
      .post('/api/budgets/roll-forward')
      .set(AUTH(ctx.token))
      .send({ period: 'monthly' });
    expect(again.status).toBe(200);
    expect(again.body.rolled.some((r) => r.id === budgetId)).toBe(false);
    expect(again.body.budgets.find((b) => b.id === budgetId).carryover).toBe(600);
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
