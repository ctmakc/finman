// test/split.test.js — Сплит расходов: регрессия краша getExpenses,
// корректность сеттлмент-математики (сходимость к нулю) и равного деления
// с округлением (10.00 / 3). Jest + Supertest через test/helpers/app.js.

const { makeApp } = require('./helpers/app');
const Split = require('../models/split');
const money = require('../lib/money');

let ctx;
let authHeader;

beforeAll(async () => {
  ctx = await makeApp();
  authHeader = 'Bearer ' + ctx.token;
});

afterAll(async () => {
  if (ctx) await ctx.close();
});

// Утилита: создать группу с N доп-участниками (creator уже в группе как член).
async function setupGroup(memberNames) {
  const groupRes = await ctx.request
    .post('/api/split/groups')
    .set('Authorization', authHeader)
    .send({ name: 'Trip', description: 'test', creator_name: 'Alice' });

  expect(groupRes.status).toBe(201);
  const groupId = groupRes.body.id;

  for (const name of memberNames) {
    const mRes = await ctx.request
      .post(`/api/split/groups/${groupId}/members`)
      .set('Authorization', authHeader)
      .send({ name });
    expect(mRes.status).toBe(201);
  }

  const membersRes = await ctx.request
    .get(`/api/split/groups/${groupId}/members`)
    .set('Authorization', authHeader);
  expect(membersRes.status).toBe(200);

  return { groupId, members: membersRes.body };
}

describe('Split — getExpenses (регрессия краша routes/split.js:141)', () => {
  test('GET /groups/:id/expenses возвращает расходы, а не падает 500', async () => {
    const { groupId, members } = await setupGroup(['Bob', 'Carol']);
    const payer = members[0];

    // Добавляем расход
    const addRes = await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({
        paid_by: payer.id,
        description: 'Dinner',
        amount: 90,
        split_type: 'equal',
        date: '2026-06-19',
        category: 'Food'
      });
    expect(addRes.status).toBe(201);

    // ЭТОТ вызов раньше падал: модель не имела getExpenses.
    const listRes = await ctx.request
      .get(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].description).toBe('Dinner');
    expect(listRes.body[0].amount).toBe(90);
    expect(Array.isArray(listRes.body[0].shares)).toBe(true);
    expect(listRes.body[0].shares.length).toBe(3);
  });

  test('Split.getExpenses является алиасом getGroupExpenses (модель)', () => {
    expect(typeof Split.getExpenses).toBe('function');
    expect(typeof Split.getGroupExpenses).toBe('function');
  });
});

describe('Split — равное деление с округлением', () => {
  test('10.00 / 3 делится как 3.34 + 3.33 + 3.33 и в сумме = 10.00', () => {
    const shares = Split._splitEqually(10, 3);
    expect(shares.length).toBe(3);
    expect(money.sum(shares)).toBe(10);
    // Остаток (1 цент) уходит в первую долю.
    expect(shares[0]).toBe(3.34);
    expect(shares[1]).toBe(3.33);
    expect(shares[2]).toBe(3.33);
  });

  test('доли расхода в БД суммируются ровно в сумму расхода', async () => {
    const { groupId, members } = await setupGroup(['Bob', 'Carol']);
    const payer = members[0];

    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({
        paid_by: payer.id,
        description: 'Taxi',
        amount: 10,
        split_type: 'equal',
        date: '2026-06-19'
      });

    const listRes = await ctx.request
      .get(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader);

    const expense = listRes.body[0];
    const shareSum = money.sum(expense.shares.map(s => s.amount));
    expect(shareSum).toBe(10);
  });
});

describe('Split — балансы и сеттлменты сходятся к нулю', () => {
  test('сумма всех балансов группы = 0', async () => {
    const { groupId, members } = await setupGroup(['Bob', 'Carol']);
    const [alice, bob, carol] = members;

    // Alice платит 90 (делится на троих по 30)
    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({ paid_by: alice.id, description: 'Hotel', amount: 90,
              split_type: 'equal', date: '2026-06-19' });

    // Bob платит 30 (делится на троих по 10)
    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({ paid_by: bob.id, description: 'Lunch', amount: 30,
              split_type: 'equal', date: '2026-06-19' });

    const balRes = await ctx.request
      .get(`/api/split/groups/${groupId}/balances`)
      .set('Authorization', authHeader);
    expect(balRes.status).toBe(200);

    const balances = Object.values(balRes.body);
    const total = money.sum(balances.map(b => b.balance));
    expect(total).toBe(0);

    // Проверяем конкретику: Alice заплатила 90, доля 40 -> +50; Bob 30-40 -> -10; Carol 0-40 -> -40
    const byId = {};
    balances.forEach(b => { byId[b.member.id] = b.balance; });
    expect(byId[alice.id]).toBe(50);
    expect(byId[bob.id]).toBe(-10);
    expect(byId[carol.id]).toBe(-40);
  });

  test('рекомендуемые переводы балансируют долги: сумма переводов к кредитору = его кредиту', async () => {
    const { groupId, members } = await setupGroup(['Bob', 'Carol']);
    const [alice, bob, carol] = members;

    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({ paid_by: alice.id, description: 'Hotel', amount: 90,
              split_type: 'equal', date: '2026-06-19' });
    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({ paid_by: bob.id, description: 'Lunch', amount: 30,
              split_type: 'equal', date: '2026-06-19' });

    const sugRes = await ctx.request
      .get(`/api/split/groups/${groupId}/settlements/suggested`)
      .set('Authorization', authHeader);
    expect(sugRes.status).toBe(200);

    const settlements = sugRes.body;
    expect(settlements.length).toBeGreaterThan(0);

    // Считаем чистое движение по каждому участнику от предложенных переводов.
    const net = {}; // memberId -> сколько он отдаёт(-)/получает(+)
    settlements.forEach(s => {
      net[s.from.id] = money.sub(net[s.from.id] || 0, s.amount);
      net[s.to.id] = money.add(net[s.to.id] || 0, s.amount);
    });

    // Сумма всех переводов нетит в ноль.
    expect(money.sum(Object.values(net))).toBe(0);

    // После применения переводов каждый баланс становится нулём.
    // net[] определён как +получает / -отдаёт. Положительный баланс (кредитор)
    // гасится ПОЛУЧЕНИЕМ денег, поэтому остаток = balance - net(перевод).
    const balRes = await ctx.request
      .get(`/api/split/groups/${groupId}/balances`)
      .set('Authorization', authHeader);
    const balances = Object.values(balRes.body);
    balances.forEach(b => {
      const after = money.sub(b.balance, net[b.member.id] || 0);
      expect(after).toBe(0);
    });

    // Кредитор (Alice, +50) суммарно получает ровно 50.
    expect(net[alice.id]).toBe(50);
    // Должники Bob(-10) и Carol(-40) суммарно отдают ровно свои долги.
    expect(net[bob.id]).toBe(-10);
    expect(net[carol.id]).toBe(-40);
  });

  test('неровное деление (10/3) всё равно даёт балансы, сходящиеся к нулю', async () => {
    const { groupId, members } = await setupGroup(['Bob', 'Carol']);
    const [alice] = members;

    // Alice платит 10, делится на троих: 3.34 / 3.33 / 3.33
    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({ paid_by: alice.id, description: 'Coffee', amount: 10,
              split_type: 'equal', date: '2026-06-19' });

    const balRes = await ctx.request
      .get(`/api/split/groups/${groupId}/balances`)
      .set('Authorization', authHeader);
    const balances = Object.values(balRes.body);
    expect(money.sum(balances.map(b => b.balance))).toBe(0);

    const sugRes = await ctx.request
      .get(`/api/split/groups/${groupId}/settlements/suggested`)
      .set('Authorization', authHeader);
    const settlements = sugRes.body;
    const net = {};
    settlements.forEach(s => {
      net[s.from.id] = money.sub(net[s.from.id] || 0, s.amount);
      net[s.to.id] = money.add(net[s.to.id] || 0, s.amount);
    });
    expect(money.sum(Object.values(net))).toBe(0);
  });
});

describe('Split — settlement запись и применение к балансам', () => {
  test('addSettlement записывает перевод и обнуляет баланс должника', async () => {
    const { groupId, members } = await setupGroup(['Bob']);
    const [alice, bob] = members;

    // Alice платит 100, делится пополам -> Bob должен 50.
    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({ paid_by: alice.id, description: 'Rent', amount: 100,
              split_type: 'equal', date: '2026-06-19' });

    // Bob отдаёт Alice 50.
    const setRes = await ctx.request
      .post(`/api/split/groups/${groupId}/settlements`)
      .set('Authorization', authHeader)
      .send({ from_member: bob.id, to_member: alice.id, amount: 50,
              date: '2026-06-19', note: 'paid back' });
    expect(setRes.status).toBe(201);
    expect(setRes.body.amount).toBe(50);

    // После расчёта все балансы = 0.
    const balRes = await ctx.request
      .get(`/api/split/groups/${groupId}/balances`)
      .set('Authorization', authHeader);
    const balances = Object.values(balRes.body);
    balances.forEach(b => expect(b.balance).toBe(0));

    // История содержит запись.
    const histRes = await ctx.request
      .get(`/api/split/groups/${groupId}/settlements`)
      .set('Authorization', authHeader);
    expect(histRes.status).toBe(200);
    expect(histRes.body.length).toBe(1);
    expect(histRes.body[0].amount).toBe(50);
  });
});

describe('Split — статистика', () => {
  test('GET /stats отдаёт сводку пользователя без падения', async () => {
    const res = await ctx.request
      .get('/api/split/stats')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalOwed');
    expect(res.body).toHaveProperty('totalOwes');
    expect(res.body).toHaveProperty('netBalance');
  });

  test('GET /groups/:id/stats содержит поля для фронтенда', async () => {
    const { groupId, members } = await setupGroup(['Bob']);
    const [alice] = members;
    await ctx.request
      .post(`/api/split/groups/${groupId}/expenses`)
      .set('Authorization', authHeader)
      .send({ paid_by: alice.id, description: 'X', amount: 50,
              split_type: 'equal', date: '2026-06-19' });

    const res = await ctx.request
      .get(`/api/split/groups/${groupId}/stats`)
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('group');
    expect(res.body.memberCount).toBe(2);
    expect(res.body.totalSpent).toBe(50);
    expect(res.body.averagePerPerson).toBe(25);
  });
});
