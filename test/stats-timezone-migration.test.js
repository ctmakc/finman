// test/stats-timezone-migration.test.js — миграция 017c (users.timezone) идемпотентна,
// новые пользователи получают дефолт, req.user.timezone доходит до роутов.
const { makeApp } = require('./helpers/app');

describe('migration 017c_user_timezone', () => {
  let ctx;
  let db;

  beforeAll(async () => {
    ctx = await makeApp();
    db = require('../db/database');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('колонка есть, записана в schema_migrations, у сеяного пользователя дефолт', async () => {
    const cols = await db.query(`PRAGMA table_info(users)`);
    expect(cols.map((c) => c.name)).toContain('timezone');
    const applied = await db.get(`SELECT name FROM schema_migrations WHERE name = '017c_user_timezone'`);
    expect(applied).toBeTruthy();
    const u = await db.get(`SELECT timezone FROM users WHERE id = ?`, [ctx.userId]);
    expect(u.timezone).toBe('America/Toronto');
  });

  test('повторный up() на БД с колонкой не падает и добивает NULL значением DEFAULT_TZ', async () => {
    const migration = require('../migrations/017c_user_timezone');
    const { columnExists } = require('../lib/migrate');
    await db.run(`UPDATE users SET timezone = NULL WHERE id = ?`, [ctx.userId]);
    const prev = process.env.DEFAULT_TZ;
    process.env.DEFAULT_TZ = 'Europe/Kyiv';
    try {
      await migration.up({ run: db.run, get: db.get, query: db.query }, { columnExists });
      await migration.up({ run: db.run, get: db.get, query: db.query }, { columnExists });
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_TZ; else process.env.DEFAULT_TZ = prev;
    }
    const u = await db.get(`SELECT timezone FROM users WHERE id = ?`, [ctx.userId]);
    expect(u.timezone).toBe('Europe/Kyiv');
    const cols = await db.query(`PRAGMA table_info(users)`);
    expect(cols.filter((c) => c.name === 'timezone')).toHaveLength(1);
  });

  test('часовой пояс пользователя влияет на «сегодня» в роутах (calendar default range)', async () => {
    // Пользователь в Киеве: диапазон по умолчанию = текущий месяц в его зоне.
    await db.run(`UPDATE users SET timezone = 'Europe/Kyiv' WHERE id = ?`, [ctx.userId]);
    const res = await ctx.request.get('/api/calendar/events').set({ Authorization: `Bearer ${ctx.token}` });
    expect(res.status).toBe(200);
    // Невалидная зона не ломает запрос — дефолт.
    await db.run(`UPDATE users SET timezone = 'Mars/Olympus' WHERE id = ?`, [ctx.userId]);
    const res2 = await ctx.request.get('/api/analytics/compare').set({ Authorization: `Bearer ${ctx.token}` });
    expect(res2.status).toBe(200);
    expect(res2.body.period.thisMonth.start).toMatch(/^\d{4}-\d{2}-01$/);
  });
});
