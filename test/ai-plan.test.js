// test/ai-plan.test.js — AI Money Plan (проактивный CFO-коучинг).
// Провайдер lib/ai/provider замокан. Проверяем:
//   - GET /api/ai/plan за тарифом 'pro' (free -> 402)
//   - детерминированный каркас плана из реальных данных (цели/долги/сбережения)
//   - planText из ИИ (мок) при настроенном провайдере; null если не настроен
const { makeApp } = require('./helpers/app');

const mockProvider = {
  _configured: true,
  _reply: 'PLAN:\n1) Save 20%/mo.\n2) Cut Dining by 2000.\n3) Fund Macbook 10000/mo.',
  isConfigured: jest.fn(() => mockProvider._configured),
  chat: jest.fn(async (args) => ({
    text: typeof mockProvider._reply === 'function' ? mockProvider._reply(args) : mockProvider._reply,
  })),
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

describe('AI Money Plan', () => {
  let ctx;
  let request;
  const today = new Date().toISOString().slice(0, 10); // tx всегда «свежие»

  beforeAll(async () => {
    ctx = await makeApp();
    request = ctx.request;
    const uid = ctx.userId;
    await dbRun(ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [uid, 'Main', 'UAH', 10000, 'card']);
    // доход + расходы (для recentIncome/expense/net)
    await dbRun(ctx.db,
      `INSERT INTO transactions (account_id,user_id,date,amount,type,category) VALUES (1,?,?,?,?,?)`,
      [uid, today, 50000, 'income', 'Salary']);
    for (const [amt, cat] of [[25000, 'Rent'], [15000, 'Dining']]) {
      await dbRun(ctx.db,
        `INSERT INTO transactions (account_id,user_id,date,amount,type,category) VALUES (1,?,?,?,?,?)`,
        [uid, today, amt, 'expense', cat]);
    }
    // цель с конкретной датой; долг с частичной оплатой
    await dbRun(ctx.db,
      `INSERT INTO savings_goals (user_id,name,target_amount,current_amount,currency,target_date,is_active) VALUES (?,?,?,?,?,?,1)`,
      [uid, 'Macbook', 60000, 0, 'UAH', '2026-12-15']);
    await dbRun(ctx.db,
      `INSERT INTO debts (user_id,name,type,amount,paid_amount,currency,start_date,is_active) VALUES (?,?,?,?,?,?,?,1)`,
      [uid, 'Card debt', 'credit', 20000, 5000, 'UAH', today]);
    await setTier(ctx.db, uid, 'pro');
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('free tier -> 402 PAYMENT_REQUIRED', async () => {
    await setTier(ctx.db, ctx.userId, 'free');
    const res = await request.get('/api/ai/plan').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(402);
    await setTier(ctx.db, ctx.userId, 'pro');
  });

  test('pro -> structured plan from real data + AI planText', async () => {
    const res = await request.get('/api/ai/plan').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    const { plan, planText, aiConfigured } = res.body.data;
    expect(aiConfigured).toBe(true);
    expect(plan.monthlyIncome).toBeGreaterThan(0);
    expect(plan.targetSavingsRate).toBeGreaterThanOrEqual(20);
    // долги: остаток = amount - paid_amount
    expect(plan.debts).toHaveLength(1);
    expect(plan.debts[0].remaining).toBe(15000);
    expect(plan.totalDebt).toBe(15000);
    // цель присутствует
    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0].name).toBe('Macbook');
    expect(plan.goals[0].remaining).toBe(60000);
    // ИИ-текст из мока
    expect(typeof planText).toBe('string');
    expect(planText.length).toBeGreaterThan(0);
    expect(mockProvider.chat).toHaveBeenCalled();
  });

  test('goal funding math is deterministic (fixed now)', async () => {
    const aiService = require('../services/aiService');
    const result = await aiService.buildFinancialPlan(ctx.userId, { now: new Date('2026-06-15') });
    // 60000 remaining, 6 месяцев до 2026-12-15 -> 10000/мес
    expect(result.plan.goals[0].monthsLeft).toBe(6);
    expect(result.plan.goals[0].monthlyNeeded).toBe(10000);
  });

  test('provider not configured -> scaffold still returned, planText null', async () => {
    mockProvider._configured = false;
    const res = await request.get('/api/ai/plan').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.aiConfigured).toBe(false);
    expect(res.body.data.planText).toBeNull();
    expect(res.body.data.plan.monthlyIncome).toBeGreaterThan(0);
    mockProvider._configured = true;
  });
});
