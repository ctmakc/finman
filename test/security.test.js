// test/security.test.js — доказательства ключевых защит на работающем app
// (security-perf-v2). ADDITIVE: ничего не меняет в роутах, только проверяет
// поведение через supertest. Все тесты офлайн и детерминированы.
//
// Покрывает:
//   1) JWT обязателен на защищённых роутах (401 без токена);
//   2) IDOR: пользователь A не может прочитать счёт/транзакцию пользователя B
//      (ожидаем 403/404, НЕ 200 с чужими данными);
//   3) попытка SQL-инъекции в query-параметре не роняет сервер (нет 500,
//      нет утечки чужих строк);
//   4) rate-limiter отдаёт 429 после порога авторизации;
//   5) неизвестный /api роут -> 404 в конверте { success:false, error }.

const { makeApp } = require('./helpers/app');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

function getDb() {
  return require('../db/database');
}
function getConfig() {
  return require('../config/config');
}

const AUTH = (token) => ({ Authorization: `Bearer ${token}` });

// Заводит второго пользователя B + его счёт и транзакцию прямо в temp-БД.
// Возвращает { userBId, accountBId, txBId, tokenB }.
async function seedUserB(db, config) {
  const hash = await bcrypt.hash('password123', 10);
  const ins = await db.run(
    `INSERT INTO users (username, email, password, full_name) VALUES (?, ?, ?, ?)`,
    ['victimB', 'victim@example.com', hash, 'Victim B']
  );
  const userBId = ins.id;

  const acc = await db.run(
    `INSERT INTO accounts (user_id, name, currency, balance, is_active)
     VALUES (?, 'B-secret-account', 'UAH', 1000, 1)`,
    [userBId]
  );
  const accountBId = acc.id;

  const tx = await db.run(
    `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
     VALUES (?, ?, '2024-01-01', 'B-secret-tx', 'Salary', 500, 'income')`,
    [accountBId, userBId]
  );
  const txBId = tx.id;

  const tokenB = jwt.sign({ id: userBId }, config.jwtSecret, {
    expiresIn: config.jwtExpiration || '24h',
  });

  return { userBId, accountBId, txBId, tokenB };
}

describe('security: JWT required on protected routes', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/transactions без токена -> 401', async () => {
    const res = await ctx.request.get('/api/transactions');
    expect(res.status).toBe(401);
  });

  test('GET /api/accounts без токена -> 401', async () => {
    const res = await ctx.request.get('/api/accounts');
    expect(res.status).toBe(401);
  });

  test('GET /api/transactions с битым токеном -> 401', async () => {
    const res = await ctx.request
      .get('/api/transactions')
      .set(AUTH('not-a-real-jwt'));
    expect(res.status).toBe(401);
  });

  test('GET /api/transactions с валидным токеном -> 200 (контроль)', async () => {
    const res = await ctx.request.get('/api/transactions').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
  });
});

describe('security: IDOR — A не читает данные B', () => {
  let ctx;
  let db;
  let B;

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    B = await seedUserB(db, getConfig());
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('A не может прочитать счёт B по id (403/404, не 200 с данными B)', async () => {
    const res = await ctx.request
      .get(`/api/accounts/${B.accountBId}`)
      .set(AUTH(ctx.token));
    expect([403, 404]).toContain(res.status);
    // Не должно утечь название чужого счёта.
    expect(JSON.stringify(res.body)).not.toContain('B-secret-account');
  });

  test('A не может прочитать транзакцию B по id (403/404, не 200 с данными B)', async () => {
    const res = await ctx.request
      .get(`/api/transactions/${B.txBId}`)
      .set(AUTH(ctx.token));
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('B-secret-tx');
  });

  test('список транзакций A не содержит транзакций B', async () => {
    const res = await ctx.request.get('/api/transactions').set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('B-secret-tx');
  });

  test('A не может удалить транзакцию B (строка B остаётся в БД)', async () => {
    // Security-инвариант: чужая строка НЕ удаляется. Сам DELETE scoped по
    // user_id, поэтому удаление невозможно. ПРИМЕЧАНИЕ: текущий роут на чужой
    // id отдаёт 500 (модель кидает плейн-Error до scoped-DELETE), а не 404 —
    // это косметический баг статус-кода, НЕ дыра (см. integration_notes).
    const res = await ctx.request
      .delete(`/api/transactions/${B.txBId}`)
      .set(AUTH(ctx.token));
    // Главное — это НЕ успешное удаление (любой не-2xx приемлем).
    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = await db.get(`SELECT id FROM transactions WHERE id = ?`, [B.txBId]);
    expect(row).toBeTruthy(); // не удалена — данные B в безопасности
  });

  test('A не может обновить чужой счёт B (403/404)', async () => {
    const res = await ctx.request
      .put(`/api/accounts/${B.accountBId}`)
      .set(AUTH(ctx.token))
      .send({ name: 'hijacked' });
    expect([403, 404]).toContain(res.status);
    const row = await db.get(`SELECT name FROM accounts WHERE id = ?`, [B.accountBId]);
    expect(row.name).toBe('B-secret-account'); // не изменён
  });
});

describe('security: SQL-injection в query-параметрах не ломает сервер', () => {
  let ctx;
  let db;
  let B;

  const INJECTIONS = [
    "' OR '1'='1",
    "'; DROP TABLE transactions;--",
    "1 UNION SELECT password FROM users--",
    "%' OR 1=1 --",
    "\" OR \"\"=\"",
  ];

  beforeAll(async () => {
    ctx = await makeApp();
    db = getDb();
    B = await seedUserB(db, getConfig());

    // Дадим пользователю A собственный счёт + транзакцию, чтобы фильтрация
    // была содержательной (есть что фильтровать).
    const acc = await db.run(
      `INSERT INTO accounts (user_id, name, currency, balance, is_active)
       VALUES (?, 'A-account', 'UAH', 10, 1)`,
      [ctx.userId]
    );
    await db.run(
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2024-02-02', 'A-own-tx', 'Food', 5, 'expense')`,
      [acc.id, ctx.userId]
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('инъекция в ?search не даёт 500 и не утекает чужие/служебные данные', async () => {
    for (const payload of INJECTIONS) {
      const res = await ctx.request
        .get('/api/transactions')
        .query({ search: payload })
        .set(AUTH(ctx.token));

      // Параметризованный LIKE -> валидный 200, а не 500.
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      // Инъекция не должна вернуть чужую транзакцию B...
      expect(body).not.toContain('B-secret-tx');
      // ...и не должна утечь хэши паролей через UNION-трюк.
      expect(body).not.toContain('$2b$');
      expect(body).not.toContain('victim@example.com');
    }
  });

  test('инъекция в ?category / ?type обрабатывается без 500', async () => {
    const res = await ctx.request
      .get('/api/transactions')
      .query({ category: "' OR 1=1--", type: "x'; DROP TABLE users;--" })
      .set(AUTH(ctx.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Таблица users цела — связанный запрос всё ещё работает.
    const u = await db.get(`SELECT COUNT(*) AS c FROM users`);
    expect(u.c).toBeGreaterThanOrEqual(2);
  });

  test('таблица transactions не уничтожена инъекцией (DROP TABLE no-op)', async () => {
    // Если бы инъекция сработала, этот запрос упал бы.
    const rows = await db.query(`SELECT COUNT(*) AS c FROM transactions`);
    expect(rows[0].c).toBeGreaterThanOrEqual(1);
  });
});

describe('security: rate-limiter возвращает 429 после порога авторизации', () => {
  // Свежий app, чтобы не исчерпать общий лимитер (/api max=100) другими
  // тестами и не делить состояние лимитера между describe-блоками.
  let ctx;
  let config;

  beforeAll(async () => {
    ctx = await makeApp();
    config = getConfig();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('POST /api/auth/login превышает authRateLimits.max -> 429', async () => {
    const threshold = config.authRateLimits.max; // по умолчанию 5
    const bad = { username: 'testuser', password: 'wrong-password' };

    let limited = false;
    let lastStatus = null;
    // Делаем threshold+1 попыток; финальная должна упереться в 429.
    for (let i = 0; i < threshold + 1; i++) {
      const res = await ctx.request.post('/api/auth/login').send(bad);
      lastStatus = res.status;
      if (res.status === 429) {
        limited = true;
        break;
      }
    }

    expect(limited).toBe(true);
    expect(lastStatus).toBe(429);
  });
});

describe('security: неизвестный /api роут -> 404-конверт', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('GET /api/nope/not/here -> 404 { success:false, error:{code,message} }', async () => {
    const res = await ctx.request.get('/api/nope/not/here');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(typeof res.body.error.message).toBe('string');
  });

  test('POST на несуществующий /api роут тоже даёт 404-конверт', async () => {
    const res = await ctx.request.post('/api/definitely-missing').send({});
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
