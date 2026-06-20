// test/subscription-detect.test.js — детектор регулярных списаний.
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

describe('Subscription detector', () => {
  let ctx;
  let request;
  const base = new Date();
  const day = (off) => new Date(base.getTime() - off * 86400000).toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    const uid = ctx.userId;
    await dbRun(ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [uid, 'Main', 'UAH', 10000, 'card']);
    const tx = (date, amount, desc, cat) => dbRun(ctx.db,
      `INSERT INTO transactions (account_id,user_id,date,amount,type,category,description) VALUES (1,?,?,?, 'expense', ?, ?)`,
      [uid, date, -Math.abs(amount), cat, desc]);
    // Netflix: 3 списания ~30 дней -> ежемесячный кандидат
    await tx(day(62), 199, 'Netflix UA 12345', 'Entertainment');
    await tx(day(31), 199, 'Netflix UA 67890', 'Entertainment');
    await tx(day(1), 199, 'Netflix UA 00001', 'Entertainment');
    // Spotify: 2 списания ~30 дней — но УЖЕ есть как подписка -> исключить
    await tx(day(31), 99, 'Spotify Premium', 'Entertainment');
    await tx(day(1), 99, 'Spotify Premium', 'Entertainment');
    // АТБ: нерегулярные продукты разной суммы -> НЕ подписка
    await tx(day(40), 850, 'ATB market 11', 'Groceries');
    await tx(day(33), 1320, 'ATB market 22', 'Groceries');
    await tx(day(5), 470, 'ATB market 33', 'Groceries');
    // Аренда: одно списание -> не повтор
    await tx(day(10), 18000, 'Rent landlord', 'Housing');
    // существующая подписка Spotify (для исключения)
    await dbRun(ctx.db,
      `INSERT INTO subscriptions (user_id,name,amount,currency,billing_cycle,start_date,is_active) VALUES (?,?,?,?,?,?,1)`,
      [uid, 'Spotify Premium', 99, 'UAH', 'monthly', day(60)]);
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('detects the recurring Netflix charge, excludes existing + irregular + single', async () => {
    const detector = require('../services/subscriptionDetector');
    const { candidates } = await detector.detectRecurring(ctx.userId, { now: base });
    const keys = candidates.map((c) => c.normalizedKey);
    const netflix = candidates.find((c) => c.normalizedKey.includes('netflix'));
    expect(netflix).toBeTruthy();
    expect(netflix.amount).toBe(199);
    expect(netflix.occurrences).toBe(3);
    expect(netflix.billingCycle).toBe('monthly');
    expect(netflix.monthlyCost).toBe(199);
    // Spotify исключён (уже подписка)
    expect(keys.some((k) => k.includes('spotify'))).toBe(false);
    // нерегулярные продукты и разовая аренда не попадают
    expect(keys.some((k) => k.includes('atb') || k.includes('market'))).toBe(false);
    expect(keys.some((k) => k.includes('rent') || k.includes('landlord'))).toBe(false);
  });

  test('GET /api/subscriptions/detect returns candidates', async () => {
    const res = await request.get('/api/subscriptions/detect').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.candidates)).toBe(true);
    expect(typeof res.body.monthlyTotal).toBe('number');
    expect(res.body.candidates.some((c) => c.normalizedKey.includes('netflix'))).toBe(true);
  });

  test('normalize strips numbers/punctuation', () => {
    const { normalize } = require('../services/subscriptionDetector');
    expect(normalize('Netflix UA 12345')).toBe('netflix ua');
    expect(normalize('SPOTIFY-Premium #99')).toBe('spotify premium');
  });
});
