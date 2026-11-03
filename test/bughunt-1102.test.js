// test/bughunt-1102.test.js — регрессии по ревью ветки (credits/repo-bughunt-1102-2153).
//   1) /api/notifications/unread-count и DELETE /old звали несуществующие
//      методы модели -> всегда 500.
//   2) PUT /api/recurring/:id с {accountId: свой, account_id: чужой}
//      прописывал чужой счёт (проверялся только первый ключ).
//   3) Currency.fetchRatesFromNBU: невалидный JSON от НБУ бросал исключение
//      в обработчике потока (uncaught -> падение процесса).
//   4) CSV export: formula injection и сломанная структура; импорт нашего
//      же экспорта со запятой в описании сдвигал колонки.
//   5) PUT subscriptions / calendar events обнулял неприсланные поля.
const { EventEmitter } = require('events');
const { makeApp } = require('./helpers/app');

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeUser(ctx, username) {
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcrypt');
  const config = require('../config/config');
  const db = require('../db/database');
  const hash = await bcrypt.hash('password123', 4);
  const ins = await db.run(
    'INSERT INTO users (username,email,password,full_name) VALUES (?,?,?,?)',
    [username, `${username}@example.com`, hash, username]
  );
  return { id: ins.id, token: jwt.sign({ id: ins.id }, config.jwtSecret, { expiresIn: '1h' }) };
}

let ctx, request, token, db, accA, accB, userB;

beforeAll(async () => {
  ctx = await makeApp();
  request = ctx.request;
  token = ctx.token;
  db = require('../db/database');
  userB = await makeUser(ctx, 'victim');
  accA = (await db.run(
    'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
    [ctx.userId, 'Mine', 'UAH', 1000, 'checking'])).id;
  accB = (await db.run(
    'INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)',
    [userB.id, 'Victim acc', 'UAH', 5000, 'checking'])).id;
});
afterAll(async () => { if (ctx) await ctx.close(); });

describe('notifications', () => {
  test('GET /unread-count returns a count, not 500', async () => {
    await db.run('INSERT INTO notifications (user_id,type,title,message,is_read) VALUES (?,?,?,?,0)',
      [ctx.userId, 'system', 't', 'm']);
    const res = await request.get('/api/notifications/unread-count').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
  test('DELETE /old works, not 500', async () => {
    const res = await request.delete('/api/notifications/old?days=30').set(auth(token));
    expect(res.status).toBe(200);
  });
});

describe('recurring: account ownership checked for both key spellings', () => {
  let payId;
  beforeAll(async () => {
    const res = await request.post('/api/recurring').set(auth(token)).send({
      accountId: accA, name: 'Rent', amount: 100, type: 'expense', frequency: 'monthly', startDate: '2026-01-01',
    });
    expect([200, 201]).toContain(res.status);
    payId = (await db.get('SELECT id FROM recurring_payments WHERE user_id = ?', [ctx.userId])).id;
  });
  test("{accountId: mine, account_id: victim's} -> 404 and account unchanged", async () => {
    const res = await request.put(`/api/recurring/${payId}`).set(auth(token))
      .send({ accountId: accA, account_id: accB });
    expect(res.status).toBe(404);
    const row = await db.get('SELECT account_id FROM recurring_payments WHERE id = ?', [payId]);
    expect(row.account_id).toBe(accA);
  });
  test('own account via account_id still accepted', async () => {
    const res = await request.put(`/api/recurring/${payId}`).set(auth(token)).send({ account_id: accA, name: 'Rent2' });
    expect(res.status).toBe(200);
  });
});

describe('Currency.fetchRatesFromNBU with non-JSON body', () => {
  test('rejects into {success:false} instead of throwing from the stream handler', async () => {
    const https = require('https');
    const spy = jest.spyOn(https, 'get').mockImplementation((url, cb) => {
      const res = new EventEmitter();
      const req = new EventEmitter();
      setImmediate(() => { cb(res); res.emit('data', '<html>502 Bad Gateway</html>'); res.emit('end'); });
      return req;
    });
    const uncaught = jest.fn();
    process.on('uncaughtException', uncaught);
    try {
      const Currency = require('../models/currency');
      const result = await Currency.fetchRatesFromNBU();
      expect(result.success).toBe(false);
      await new Promise((r) => setImmediate(r));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.removeListener('uncaughtException', uncaught);
      spy.mockRestore();
    }
  });
});

describe('CSV export/import', () => {
  test('formula cells are neutralised and text cells quoted', async () => {
    await db.run(
      `INSERT INTO transactions (user_id,account_id,amount,type,category,description,date) VALUES (?,?,?,?,?,?,?)`,
      [ctx.userId, accA, -12.5, 'expense', '@SUM(1)', '=HYPERLINK("http://evil","x")', '2026-10-01']);
    await db.run('UPDATE accounts SET name = ? WHERE id = ?', ['=1+1 "acc", x', accA]);
    const tx = await request.get('/api/export/transactions/csv').set(auth(token));
    expect(tx.status).toBe(200);
    const line = tx.text.split('\n').find((l) => l.includes('HYPERLINK'));
    expect(line).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(line).toContain(`"'@SUM(1)"`);
    expect(line).toContain(',-12.5,'); // числа не трогаем
    expect(line).toContain(`"'=1+1 ""acc"", x"`);
    const acc = await request.get('/api/export/accounts/csv').set(auth(token));
    expect(acc.text).toContain(`"'=1+1 ""acc"", x"`);
  });

  test('import of our own export keeps commas in description and strips the guard', async () => {
    const csv = [
      'Date,Description,Category,Amount,Type,Account,Currency',
      '2026-10-02,"Coffee, Starbucks",Food,-4.5,Expense,"Mine",UAH',
      `2026-10-03,"'=cmd",Other,7,Income,"Mine",UAH`,
    ].join('\n');
    const res = await request.post(`/api/export/transactions/csv?accountId=${accA}`)
      .set(auth(token)).set('Content-Type', 'text/csv').send(csv);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    const rows = await db.query(
      "SELECT description, category, amount, type FROM transactions WHERE user_id = ? AND date IN ('2026-10-02','2026-10-03') ORDER BY date",
      [ctx.userId]);
    expect(rows[0]).toMatchObject({ description: 'Coffee, Starbucks', category: 'Food', amount: -4.5, type: 'expense' });
    expect(rows[1]).toMatchObject({ description: '=cmd', amount: 7, type: 'income' });
  });
});

describe('partial PUT keeps unsent fields', () => {
  test('subscriptions', async () => {
    const id = (await db.run(
      `INSERT INTO subscriptions (user_id,name,description,amount,currency,billing_cycle,start_date,next_billing_date,category,notes,url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [ctx.userId, 'Netflix', 'family plan', 15, 'USD', 'monthly', '2026-11-01', '2026-12-01', 'Entertainment', 'shared', 'https://n.example'])).id;
    const res = await request.put(`/api/subscriptions/${id}`).set(auth(token)).send({ is_active: false });
    expect(res.status).toBe(200);
    const row = await db.get('SELECT * FROM subscriptions WHERE id = ?', [id]);
    expect(row).toMatchObject({ description: 'family plan', category: 'Entertainment', notes: 'shared', url: 'https://n.example', is_active: 0 });
    await request.put(`/api/subscriptions/${id}`).set(auth(token)).send({ notes: null });
    expect((await db.get('SELECT notes FROM subscriptions WHERE id = ?', [id])).notes).toBeNull();
  });

  test('calendar events', async () => {
    const id = (await db.run(
      `INSERT INTO calendar_events (user_id,title,description,event_type,amount,event_date,is_completed,completed_at)
       VALUES (?,?,?,?,?,?,1,?)`,
      [ctx.userId, 'Tax', 'pay it', 'bill', 300, '2026-11-20', '2026-11-01T00:00:00.000Z'])).id;
    const res = await request.put(`/api/calendar/events/${id}`).set(auth(token)).send({ title: 'Taxes' });
    expect(res.status).toBe(200);
    const row = await db.get('SELECT * FROM calendar_events WHERE id = ?', [id]);
    expect(row).toMatchObject({ title: 'Taxes', description: 'pay it', amount: 300, is_completed: 1, completed_at: '2026-11-01T00:00:00.000Z' });
  });
});

describe('family: budget access revoked on leave / removal', () => {
  test('removed and leaving members lose accessible-budgets', async () => {
    const m1 = await makeUser(ctx, 'fam_m1');
    const m2 = await makeUser(ctx, 'fam_m2');
    const fam = await request.post('/api/family').set(auth(token)).send({ name: 'Home2' });
    expect([200, 201]).toContain(fam.status);
    const familyId = fam.body.family.id;
    for (const m of [m1, m2]) {
      await db.run(`INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'member')`, [familyId, m.id]);
    }
    const budgetId = (await db.run(
      `INSERT INTO budgets (user_id,name,amount,period,start_date,is_active) VALUES (?,?,?,?,?,1)`,
      [ctx.userId, 'Groceries', 500, 'monthly', '2026-11-01'])).id;
    for (const m of [m1, m2]) {
      const g = await request.post(`/api/family/budgets/${budgetId}/permissions`).set(auth(token))
        .send({ userId: m.id, canView: true });
      expect(g.status).toBe(200);
    }
    const visible = async (u) => (await request.get('/api/family/accessible-budgets').set(auth(u.token))).body
      .shared.some((b) => b.id === budgetId);
    expect(await visible(m1)).toBe(true);
    expect(await visible(m2)).toBe(true);

    const Family = require('../models/family');
    const rm = await Family.removeMember(familyId, m1.id, ctx.userId);
    expect(rm.success).toBe(true);
    const lv = await Family.leave(familyId, m2.id);
    expect(lv.success).toBe(true);

    expect(await visible(m1)).toBe(false);
    expect(await visible(m2)).toBe(false);
  });
});

describe('transactions: foreign / missing id -> 404, not 500', () => {
  test("PUT and DELETE on another user's transaction", async () => {
    const txB = (await db.run(
      `INSERT INTO transactions (user_id,account_id,amount,type,category,description,date) VALUES (?,?,?,?,?,?,?)`,
      [userB.id, accB, -10, 'expense', 'Food', 'victim tx', '2026-10-05'])).id;
    const put = await request.put(`/api/transactions/${txB}`).set(auth(token)).send({ description: 'pwn' });
    expect(put.status).toBe(404);
    const del = await request.delete(`/api/transactions/${txB}`).set(auth(token));
    expect(del.status).toBe(404);
    const row = await db.get('SELECT description FROM transactions WHERE id = ?', [txB]);
    expect(row.description).toBe('victim tx');
    expect((await request.delete('/api/transactions/999999').set(auth(token))).status).toBe(404);
  });
});
