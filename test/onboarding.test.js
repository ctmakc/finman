// test/onboarding.test.js — WAVE-2 stream "onboarding".
//
// Покрывает:
//   1) GET /status отражает состояние БД (нет данных -> ничего не сделано);
//   2) POST /quickstart сеет дефолтный счёт + категории (и идемпотентен);
//   3) после quickstart шаг account становится done в статусе;
//   4) POST /complete-step продвигает явно отмеченный/пропущенный шаг;
//   5) наличие транзакции/бюджета/цели в БД отражается в статусе;
//   6) валидация шага (невалидный step -> 400);
//   7) изоляция пользователей (статус не утекает между юзерами).
//
// Тест самодостаточен и оффлайн: переиспользует makeApp() для временной БД +
// сидового пользователя + JWT, и монтирует onboarding-роутер на минимальном
// express-приложении ТОЧНО так, как это сделает Интегратор:
//   app.use('/api/onboarding', apiAuth, onboardingRoutes)
// (passport-jwt уже зарегистрирован authService через server.js при makeApp()).

const express = require('express');
const passport = require('passport');
const supertest = require('supertest');
const { makeApp } = require('./helpers/app');

function getDb() {
  return require('../db/database');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

// Строим изолированное мини-приложение поверх инициализированной временной БД.
// ctx (из makeApp) уже: создал схему+миграции, засеял юзера, зарегистрировал
// passport-jwt стратегию (через require server.js), выдал token.
function buildOnboardingApp() {
  // ВАЖНО: require ПОСЛЕ makeApp — чтобы роутер забиндился к актуальной (свежей) БД.
  const onboardingRoutes = require('../routes/onboarding');

  const apiAuth = (req, res, next) => {
    passport.authenticate('jwt', { session: false }, (err, user) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ message: 'Unauthorized' });
      req.user = user;
      next();
    })(req, res, next);
  };

  const app = express();
  app.use(express.json());
  app.use('/api/onboarding', apiAuth, onboardingRoutes);

  // Минимальный обработчик ошибок (как в проде: errorHandler форматирует AppError).
  const { errorHandler, notFound } = require('../middleware/error');
  app.use(notFound);
  app.use(errorHandler);

  return supertest(app);
}

describe('onboarding: status reflects DB state', () => {
  let ctx;
  let request;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request; // онбординг смонтирован в server.js -> используем реальное app (как все остальные suite-ы)
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /status: свежий пользователь — ничего не сделано', async () => {
    const res = await request.get('/api/onboarding/status').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data.total).toBe(4);
    expect(data.completed).toBe(0);
    expect(data.complete).toBe(false);
    expect(data.showWizard).toBe(true);

    const keys = data.steps.map((s) => s.key);
    expect(keys).toEqual(['account', 'transaction', 'budget', 'goal']);
    expect(data.steps.every((s) => s.done === false)).toBe(true);
  });

  test('GET /status без токена -> 401', async () => {
    const res = await request.get('/api/onboarding/status');
    expect(res.status).toBe(401);
  });
});

describe('onboarding: quickstart seeds starter data', () => {
  let ctx;
  let request;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    request = ctx.request; // онбординг смонтирован в server.js -> используем реальное app (как все остальные suite-ы)
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('POST /quickstart создаёт дефолтный счёт + категории', async () => {
    const res = await request
      .post('/api/onboarding/quickstart')
      .set(AUTH(ctx.token))
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data.accountCreated).toBe(true);
    expect(data.accountId).toBeDefined();
    expect(data.categoriesCreated).toBeGreaterThan(0);

    // Счёт реально в БД и принадлежит юзеру.
    const acc = await db.get('SELECT * FROM accounts WHERE id = ?', [data.accountId]);
    expect(acc).toBeTruthy();
    expect(acc.user_id).toBe(ctx.userId);
    expect(acc.is_active).toBe(1);

    // Категории реально в БД.
    const cats = await db.query('SELECT * FROM categories WHERE user_id = ?', [ctx.userId]);
    expect(cats.length).toBeGreaterThan(0);

    // Статус теперь показывает account=done.
    const accStep = data.status.steps.find((s) => s.key === 'account');
    expect(accStep.done).toBe(true);
    expect(accStep.fromData).toBe(true);
    expect(data.status.completed).toBeGreaterThanOrEqual(1);
  });

  test('POST /quickstart идемпотентен (повтор не плодит счета/категории)', async () => {
    const before = await db.get(
      'SELECT COUNT(*) AS c FROM accounts WHERE user_id = ?',
      [ctx.userId]
    );
    const beforeCats = await db.get(
      'SELECT COUNT(*) AS c FROM categories WHERE user_id = ?',
      [ctx.userId]
    );

    const res = await request
      .post('/api/onboarding/quickstart')
      .set(AUTH(ctx.token))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.data.accountCreated).toBe(false);
    expect(res.body.data.categoriesCreated).toBe(0);

    const after = await db.get(
      'SELECT COUNT(*) AS c FROM accounts WHERE user_id = ?',
      [ctx.userId]
    );
    const afterCats = await db.get(
      'SELECT COUNT(*) AS c FROM categories WHERE user_id = ?',
      [ctx.userId]
    );
    expect(after.c).toBe(before.c);
    expect(afterCats.c).toBe(beforeCats.c);
  });

  test('GET /status после quickstart отражает наличие счёта', async () => {
    const res = await request.get('/api/onboarding/status').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const accStep = res.body.data.steps.find((s) => s.key === 'account');
    expect(accStep.done).toBe(true);
  });
});

describe('onboarding: complete-step advances steps', () => {
  let ctx;
  let request;

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request; // онбординг смонтирован в server.js -> используем реальное app (как все остальные suite-ы)
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('POST /complete-step помечает шаг done даже без данных в БД', async () => {
    const res = await request
      .post('/api/onboarding/complete-step')
      .set(AUTH(ctx.token))
      .send({ step: 'budget' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const budgetStep = res.body.data.steps.find((s) => s.key === 'budget');
    expect(budgetStep.done).toBe(true);
    expect(budgetStep.explicit).toBe(true);
    // fromData остаётся false: бюджета в БД нет, шаг отмечен явно.
    expect(budgetStep.fromData).toBe(false);
    expect(res.body.data.completed).toBe(1);
  });

  test('POST /complete-step идемпотентен (повтор не ломает и не дублирует)', async () => {
    await request
      .post('/api/onboarding/complete-step')
      .set(AUTH(ctx.token))
      .send({ step: 'budget' });

    const res = await request.get('/api/onboarding/status').set(AUTH(ctx.token));
    const budgetSteps = res.body.data.steps.filter((s) => s.key === 'budget');
    expect(budgetSteps.length).toBe(1);
    expect(budgetSteps[0].done).toBe(true);
  });

  test('POST /complete-step с невалидным step -> 400', async () => {
    const res = await request
      .post('/api/onboarding/complete-step')
      .set(AUTH(ctx.token))
      .send({ step: 'not-a-step' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('POST /complete-step без step -> 400', async () => {
    const res = await request
      .post('/api/onboarding/complete-step')
      .set(AUTH(ctx.token))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('onboarding: DB data drives step completion', () => {
  let ctx;
  let request;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    request = ctx.request; // онбординг смонтирован в server.js -> используем реальное app (как все остальные suite-ы)

    const today = new Date().toISOString().split('T')[0];

    // Счёт.
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'acc', 'UAH', 0, 1)`,
      [ctx.userId]
    );
    // Транзакция.
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, amount, type)
       VALUES (?, ?, ?, 'first tx', 100, 'income')`,
      [acc.id, ctx.userId, today]
    );
    // Бюджет.
    await db.run(
      `INSERT INTO budgets (user_id, name, amount, period, start_date)
       VALUES (?, 'food', 500, 'monthly', ?)`,
      [ctx.userId, today]
    );
    // Цель накопления.
    await db.run(
      `INSERT INTO savings_goals (user_id, name, target_amount)
       VALUES (?, 'vacation', 1000)`,
      [ctx.userId]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /status: все 4 шага done из данных БД -> complete', async () => {
    const res = await request.get('/api/onboarding/status').set(AUTH(ctx.token));
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(data.completed).toBe(4);
    expect(data.complete).toBe(true);
    expect(data.showWizard).toBe(false);
    expect(data.steps.every((s) => s.done === true)).toBe(true);
    expect(data.steps.every((s) => s.fromData === true)).toBe(true);
  });
});

describe('onboarding: user isolation', () => {
  let ctx;
  let request;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    request = ctx.request; // онбординг смонтирован в server.js -> используем реальное app (как все остальные suite-ы)
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test("данные другого пользователя не влияют на статус", async () => {
    // Создаём второго пользователя с полным набором данных.
    const other = await db.run(
      `INSERT INTO users (username, email, password, full_name)
       VALUES ('other', 'other@example.com', 'x', 'Other')`
    );
    const otherId = other.id;
    const today = new Date().toISOString().split('T')[0];
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'acc', 'UAH', 0, 1)`,
      [otherId]
    );
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, amount, type)
       VALUES (?, ?, ?, 50, 'income')`,
      [acc.id, otherId, today]
    );

    // Статус сид-юзера должен оставаться пустым.
    const res = await request.get('/api/onboarding/status').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(0);
    expect(res.body.data.steps.every((s) => s.done === false)).toBe(true);
  });
});
