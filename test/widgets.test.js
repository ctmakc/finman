// test/widgets.test.js — Wave-2 "widgets-dashboard" stream.
//
// Покрывает:
//   1) дефолтный набор виджетов сеется при первом GET /api/widgets;
//   2) reorder персистит позиции (новый контракт: упорядоченный список id,
//      и обратно-совместимый формат [{id, position}]);
//   3) CRUD скоупится по пользователю (паттерн requireOwnership):
//      чужой/несуществующий виджет -> 404, изоляция между пользователями;
//   4) валидация (неизвестный тип, плохой размер);
//   5) данные новых виджетов (cashflow, top_categories) + корректная колонка
//      next_payment_date в upcoming.
//
// Все запросы офлайн/детерминированы (никаких сетевых/LLM-вызовов).

const path = require('path');
const { makeApp } = require('./helpers/app');

function getDb() {
  return require('../db/database');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

// Создаёт второго пользователя в текущей temp-БД и валидный JWT для него.
async function makeSecondUser(db) {
  const bcrypt = require('bcrypt');
  const jwt = require('jsonwebtoken');
  const config = require(path.join(__dirname, '..', 'config', 'config.js'));
  const hash = await bcrypt.hash('password123', 10);
  const ins = await db.run(
    `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
    ['otheruser', 'other@example.com', hash, 'Other User']
  );
  const token = jwt.sign({ id: ins.id }, config.jwtSecret, {
    expiresIn: config.jwtExpiration || '24h'
  });
  return { id: ins.id, token };
}

describe('widgets: default set + list', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /available -> каталог виджетов с метаданными', async () => {
    const res = await ctx.request.get('/api/widgets/available').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const types = res.body.map((w) => w.type);
    expect(types).toContain('cashflow');
    expect(types).toContain('top_categories');
    expect(types).toContain('networth');
  });

  test('первый GET / сеет дефолтный набор виджетов', async () => {
    const res = await ctx.request.get('/api/widgets').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // позиции уникальны и идут по возрастанию (0..n)
    const positions = res.body.map((w) => w.position);
    expect(positions[0]).toBe(0);
    // settings распарсены в объект
    expect(typeof res.body[0].settings).toBe('object');

    // дефолтный набор включает ключевые виджеты wave-2
    const types = res.body.map((w) => w.widget_type);
    expect(types).toContain('networth');
    expect(types).toContain('cashflow');
    expect(types).toContain('top_categories');
  });

  test('повторный GET / не плодит дубликаты (сид идемпотентен)', async () => {
    const first = await ctx.request.get('/api/widgets').set(AUTH(ctx.token));
    const second = await ctx.request.get('/api/widgets').set(AUTH(ctx.token));
    expect(second.body.length).toBe(first.body.length);
  });
});

describe('widgets: reorder персистит позиции', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('reorder упорядоченным списком id сохраняет position по индексу', async () => {
    // засеять дефолты
    const list = (await ctx.request.get('/api/widgets').set(AUTH(ctx.token))).body;
    const ids = list.map((w) => w.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);

    // развернём порядок
    const reversed = ids.slice().reverse();
    const res = await ctx.request
      .post('/api/widgets/reorder')
      .set(AUTH(ctx.token))
      .send({ order: reversed });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // перечитываем — порядок должен соответствовать reversed
    const after = (await ctx.request.get('/api/widgets').set(AUTH(ctx.token))).body;
    expect(after.map((w) => w.id)).toEqual(reversed);
    // position = индекс в новом порядке
    after.forEach((w, i) => expect(w.position).toBe(i));
  });

  test('reorder поддерживает legacy-формат [{id, position}]', async () => {
    const list = (await ctx.request.get('/api/widgets').set(AUTH(ctx.token))).body;
    const ids = list.map((w) => w.id);
    // первый виджет уводим в конец вручную через пары
    const pairs = ids.map((id, i) => ({ id, position: i }));
    pairs[0].position = ids.length - 1;
    pairs[ids.length - 1].position = 0;

    const res = await ctx.request
      .post('/api/widgets/reorder')
      .set(AUTH(ctx.token))
      .send({ order: pairs });
    expect(res.status).toBe(200);

    const first = (await ctx.request.get('/api/widgets').set(AUTH(ctx.token))).body[0];
    // на позиции 0 теперь бывший последний id
    expect(first.id).toBe(ids[ids.length - 1]);
  });

  test('reorder с не-массивом -> 400', async () => {
    const res = await ctx.request
      .post('/api/widgets/reorder')
      .set(AUTH(ctx.token))
      .send({ order: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('widgets: CRUD + ownership scoping', () => {
  let ctx;
  let other;

  beforeAll(async () => {
    ctx = await makeApp();
    other = await makeSecondUser(getDb());
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('POST / создаёт виджет (success + serialized)', async () => {
    const res = await ctx.request
      .post('/api/widgets')
      .set(AUTH(ctx.token))
      .send({ widget_type: 'cashflow', title: 'Мой кэшфлоу', size: 'large' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.widget_type).toBe('cashflow');
    expect(res.body.data.size).toBe('large');
    expect(typeof res.body.data.settings).toBe('object');
  });

  test('POST / с неизвестным типом -> 400', async () => {
    const res = await ctx.request
      .post('/api/widgets')
      .set(AUTH(ctx.token))
      .send({ widget_type: 'definitely_not_a_widget' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('POST / с плохим размером -> 400', async () => {
    const res = await ctx.request
      .post('/api/widgets')
      .set(AUTH(ctx.token))
      .send({ widget_type: 'balance', size: 'gigantic' });
    expect(res.status).toBe(400);
  });

  test('PUT обновляет свой виджет', async () => {
    const created = (
      await ctx.request
        .post('/api/widgets')
        .set(AUTH(ctx.token))
        .send({ widget_type: 'goals', title: 'Цели', size: 'medium' })
    ).body.data;

    const res = await ctx.request
      .put(`/api/widgets/${created.id}`)
      .set(AUTH(ctx.token))
      .send({ title: 'Обновлено', size: 'small', is_visible: false });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Обновлено');
    expect(res.body.data.size).toBe('small');
    expect(res.body.data.is_visible).toBe(0);
  });

  test('PUT чужого виджета -> 404 (ownership scoping)', async () => {
    const mine = (
      await ctx.request
        .post('/api/widgets')
        .set(AUTH(ctx.token))
        .send({ widget_type: 'balance', title: 'Баланс' })
    ).body.data;

    // другой пользователь не видит и не может править
    const res = await ctx.request
      .put(`/api/widgets/${mine.id}`)
      .set(AUTH(other.token))
      .send({ title: 'hacked' });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);

    // виджет не изменился
    const check = await getDb().get('SELECT title FROM dashboard_widgets WHERE id = ?', [mine.id]);
    expect(check.title).toBe('Баланс');
  });

  test('DELETE чужого виджета -> 404, ресурс на месте', async () => {
    const mine = (
      await ctx.request
        .post('/api/widgets')
        .set(AUTH(ctx.token))
        .send({ widget_type: 'income', title: 'Доход' })
    ).body.data;

    const res = await ctx.request
      .delete(`/api/widgets/${mine.id}`)
      .set(AUTH(other.token));
    expect(res.status).toBe(404);

    const still = await getDb().get('SELECT id FROM dashboard_widgets WHERE id = ?', [mine.id]);
    expect(still).toBeTruthy();
  });

  test('DELETE своего виджета -> 200 и он удалён', async () => {
    const mine = (
      await ctx.request
        .post('/api/widgets')
        .set(AUTH(ctx.token))
        .send({ widget_type: 'debts', title: 'Долги' })
    ).body.data;

    const res = await ctx.request.delete(`/api/widgets/${mine.id}`).set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    const gone = await getDb().get('SELECT id FROM dashboard_widgets WHERE id = ?', [mine.id]);
    expect(gone).toBeFalsy();
  });

  test('reorder с чужим id -> 404 (нельзя двигать чужие виджеты)', async () => {
    // у другого пользователя засеять дефолты
    const otherList = (
      await ctx.request.get('/api/widgets').set(AUTH(other.token))
    ).body;
    const otherId = otherList[0].id;

    // текущий пользователь пытается включить чужой id в свой reorder
    const res = await ctx.request
      .post('/api/widgets/reorder')
      .set(AUTH(ctx.token))
      .send({ order: [otherId] });
    expect(res.status).toBe(404);
  });
});

describe('widgets: данные виджетов (cashflow / top_categories / upcoming)', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();

    const today = new Date().toISOString().split('T')[0];

    // счёт + транзакции текущего месяца
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active) VALUES (?, 'acc', 'UAH', 1000, 1)`,
      [ctx.userId]
    );
    const accId = acc.id;

    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, 'salary', 'Зарплата', 5000, 'income')`,
      [accId, ctx.userId, today]
    );
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, 'food', 'Еда', 1200, 'expense')`,
      [accId, ctx.userId, today]
    );
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, 'rent', 'Аренда', 800, 'expense')`,
      [accId, ctx.userId, today]
    );

    // регулярный платёж на завтра -> должен попасть в upcoming
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db.run(
      `INSERT INTO recurring_payments
         (user_id, account_id, name, amount, type, frequency, start_date, next_payment_date, is_active)
       VALUES (?, ?, 'Netflix', 300, 'expense', 'monthly', ?, ?, 1)`,
      [ctx.userId, accId, today, tomorrow]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /cashflow/data -> income/expense/net', async () => {
    const res = await ctx.request
      .get('/api/widgets/cashflow/data')
      .set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.income).toBe(5000);
    expect(res.body.expense).toBe(2000);
    expect(res.body.net).toBe(3000);
  });

  test('GET /top_categories/data -> отсортировано по сумме с процентами', async () => {
    const res = await ctx.request
      .get('/api/widgets/top_categories/data')
      .set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBe(2);
    // крупнейшая категория — Еда (1200) перед Арендой (800)
    expect(res.body.categories[0].category).toBe('Еда');
    expect(res.body.categories[0].total).toBe(1200);
    expect(res.body.total).toBe(2000);
    expect(res.body.categories[0].percent).toBe(60);
  });

  test('GET /upcoming/data -> использует next_payment_date (без SQL-ошибки)', async () => {
    const res = await ctx.request
      .get('/api/widgets/upcoming/data')
      .set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const titles = res.body.items.map((i) => i.title);
    expect(titles).toContain('Netflix');
  });

  test('GET /unknown_type/data -> 400', async () => {
    const res = await ctx.request
      .get('/api/widgets/no_such_widget/data')
      .set(AUTH(ctx.token));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('виджеты требуют аутентификацию (401 без токена)', async () => {
    const res = await ctx.request.get('/api/widgets');
    expect(res.status).toBe(401);
  });
});
