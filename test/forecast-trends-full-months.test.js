// test/forecast-trends-full-months.test.js — /api/forecast/trends compares FULL months only.
// A history that starts mid-month made the first month look tiny ("expenses ↑999%");
// the current month is unfinished. With fewer than 2 full months there is no trend.
const jwt = require('jsonwebtoken');
const { makeApp } = require('./helpers/app');
const dates = require('../lib/dates');

let ctx, db, config;

async function userWith(rows) {
  const u = await db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [`tr${Date.now()}${Math.random()}`.slice(0, 30), `tr${Math.random()}@example.com`, 'x']);
  const a = await db.run("INSERT INTO accounts (user_id, name, account_type, balance, currency) VALUES (?, 'Chequing', 'checking', 0, 'CAD')", [u.id]);
  for (const [date, amount, type] of rows) {
    await db.run('INSERT INTO transactions (account_id, user_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [a.id, u.id, date, type === 'income' ? 'PAYROLL' : 'GROCERY', type === 'income' ? 'Salary' : 'Groceries', type === 'income' ? amount : -amount, type]);
  }
  return jwt.sign({ id: u.id, tv: 0 }, config.jwtSecret, { expiresIn: '1h' });
}
const get = (token) => ctx.request.get('/api/forecast/trends').set('Authorization', 'Bearer ' + token);

beforeAll(async () => {
  ctx = await makeApp();
  db = require('../db/database');
  config = require('../config/config');
});
afterAll(async () => { await ctx.close(); });

const today = dates.todayISO('America/Toronto');
const monthStart = (k) => dates.addMonthsISO(dates.startOfMonthISO(today), -k, 1);
const day = (k, d) => monthStart(k).slice(0, 8) + String(d).padStart(2, '0');

test('a history that starts mid-month: the partial first month is not compared', async () => {
  // 3 months ago from the 20th (partial), then two full months with equal spending.
  const token = await userWith([
    [day(3, 20), 100, 'expense'],
    [day(2, 2), 1000, 'expense'], [day(2, 15), 3000, 'income'],
    [day(1, 2), 1000, 'expense'], [day(1, 15), 3000, 'income'],
    [day(0, 1), 50, 'expense'],
  ]);
  const r = await get(token);
  expect(r.status).toBe(200);
  expect(r.body.fullMonths).toBe(2);
  expect(r.body.trends.expense.percent).toBe('0');
  expect(r.body.trends.income.percent).toBe('0');
});

test('one full month only: no trend, said honestly', async () => {
  const token = await userWith([[day(1, 1), 500, 'expense'], [day(0, 1), 20, 'expense']]);
  const r = await get(token);
  expect(r.body.fullMonths).toBe(1);
  expect(r.body.trends.expense.percent).toBeNull();
  expect(r.body.prediction.nextMonthExpense).toBe(500);
});
