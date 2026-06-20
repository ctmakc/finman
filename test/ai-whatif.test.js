// test/ai-whatif.test.js — AI What-if симулятор сценариев.
const { makeApp } = require('./helpers/app');

const mockProvider = {
  _configured: true,
  _reply: 'Cutting Dining frees 3000/mo — you would hit your goal ~2 months sooner. Worth it.',
  isConfigured: jest.fn(() => mockProvider._configured),
  chat: jest.fn(async () => ({ text: mockProvider._reply })),
};
jest.mock('../lib/ai/provider', () => mockProvider);

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}
async function setTier(db, userId, tier) {
  await dbRun(db, 'UPDATE users SET subscription_tier = ? WHERE id = ?', [tier, userId]);
}

describe('AI What-if simulator', () => {
  let ctx;
  let request;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    const uid = ctx.userId;
    await dbRun(ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [uid, 'Main', 'UAH', 10000, 'card']);
    await dbRun(ctx.db,
      `INSERT INTO transactions (account_id,user_id,date,amount,type,category) VALUES (1,?,?,?,?,?)`,
      [uid, today, 50000, 'income', 'Salary']);
    for (const [amt, cat] of [[25000, 'Rent'], [15000, 'Dining']]) {
      await dbRun(ctx.db,
        `INSERT INTO transactions (account_id,user_id,date,amount,type,category) VALUES (1,?,?,?,?,?)`,
        [uid, today, amt, 'expense', cat]);
    }
    await dbRun(ctx.db,
      `INSERT INTO savings_goals (user_id,name,target_amount,current_amount,currency,target_date,is_active) VALUES (?,?,?,?,?,?,1)`,
      [uid, 'Trip', 30000, 0, 'UAH', '2027-06-01']);
    await setTier(ctx.db, uid, 'pro');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('free tier -> 402', async () => {
    await setTier(ctx.db, ctx.userId, 'free');
    const res = await request.post('/api/ai/whatif')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ cuts: [{ category: 'Dining', percent: 20 }] });
    expect(res.status).toBe(402);
    await setTier(ctx.db, ctx.userId, 'pro');
  });

  test('cut category + extra saving -> deterministic impact + AI narrative', async () => {
    const res = await request.post('/api/ai/whatif')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ cuts: [{ category: 'Dining', percent: 20 }], extraMonthlySaving: 1000 });
    expect(res.status).toBe(200);
    const { result, narrative, aiConfigured } = res.body.data;
    expect(aiConfigured).toBe(true);
    // 20% of Dining(15000) = 3000 saved
    expect(result.cuts[0].category).toBe('Dining');
    expect(result.cuts[0].monthlySaved).toBe(3000);
    // freed = 3000 + 1000 extra
    expect(result.scenario.monthlyFreed).toBe(4000);
    // scenario net = baseline net + freed
    expect(result.scenario.monthlyNet).toBe(result.baseline.monthlyNet + 4000);
    expect(result.scenario.savingsRate).toBeGreaterThan(result.baseline.savingsRate);
    // goal reached sooner with more savings
    const g = result.goals[0];
    expect(g.monthsScenario).toBeLessThanOrEqual(g.monthsBaseline);
    expect(typeof narrative).toBe('string');
    expect(narrative.length).toBeGreaterThan(0);
  });

  test('no changes -> narrative null', async () => {
    const res = await request.post('/api/ai/whatif')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ cuts: [], extraMonthlySaving: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.narrative).toBeNull();
    expect(res.body.data.result.scenario.monthlyFreed).toBe(0);
  });
});
