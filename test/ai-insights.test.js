// test/ai-insights.test.js — PORT_PLAN A8: financialInsights digest/alerts, the four
// /api/ai endpoints (digest, alerts, insights/monthly with ai_insights cache, insights/weekly),
// and the digest grounding prepended to the CFO system prompt.
// Provider mocked (jest.mock) — no network. Seed dates are relative to "now".

const { makeApp } = require('./helpers/app');

const mockProvider = {
  _configured: true,
  _reply: 'Mocked story',
  isConfigured: jest.fn(() => mockProvider._configured),
  chat: jest.fn(async (args) => ({
    text: typeof mockProvider._reply === 'function' ? mockProvider._reply(args) : mockProvider._reply,
    provider: 'google',
    model: 'gemini-2.5-flash',
  })),
};
jest.mock('../lib/ai/provider', () => mockProvider);

const insights = require('../services/financialInsights');

// --- raw sqlite helpers ----------------------------------------------------
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// --- date helpers (local time, same convention as the service) ------------
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date();
const THIS = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}`;
const lastMonthDate = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1);
const LAST = `${lastMonthDate.getFullYear()}-${pad(lastMonthDate.getMonth() + 1)}`;
const TODAY = iso(NOW);

async function seedAccount(db, userId) {
  const acc = await dbRun(
    db,
    `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active) VALUES (?, ?, 'UAH', 5000, 'card', 1)`,
    [userId, 'Main Card']
  );
  return acc.id;
}

async function tx(db, userId, accountId, date, category, amount, type, description = '') {
  await dbRun(
    db,
    `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [accountId, userId, date, description || `${category} ${date}`, category, amount, type]
  );
}

// Seeds a known picture:
//   last month: income 10000, Groceries 3 x 100 (priors), Transport 500
//   this month: income 12000, Groceries 900 (anomaly: 9x the 100 norm), Transport 200, Fun 300
//   budget Groceries 1000 (90% used), recurring Rent 100 due today
async function seedFinance(db, userId) {
  const accountId = await seedAccount(db, userId);
  await tx(db, userId, accountId, `${LAST}-02`, 'Income', 10000, 'income', 'Salary');
  await tx(db, userId, accountId, `${LAST}-03`, 'Groceries', -100, 'expense');
  await tx(db, userId, accountId, `${LAST}-10`, 'Groceries', -100, 'expense');
  await tx(db, userId, accountId, `${LAST}-17`, 'Groceries', -100, 'expense');
  await tx(db, userId, accountId, `${LAST}-20`, 'Transport', -500, 'expense');

  await tx(db, userId, accountId, `${THIS}-01`, 'Income', 12000, 'income', 'Salary');
  await tx(db, userId, accountId, `${THIS}-01`, 'Groceries', -900, 'expense', 'Big shop');
  await tx(db, userId, accountId, `${THIS}-01`, 'Transport', -200, 'expense');
  await tx(db, userId, accountId, `${THIS}-01`, 'Fun', -300, 'expense');

  await dbRun(
    db,
    `INSERT INTO budgets (user_id, name, category, amount, spent, period, start_date, is_active)
     VALUES (?, 'Groceries Budget', 'Groceries', 1000, 0, 'monthly', ?, 1)`,
    [userId, `${LAST}-01`]
  );
  await dbRun(
    db,
    `INSERT INTO recurring_payments (user_id, account_id, name, amount, type, frequency, start_date, next_payment_date, is_active)
     VALUES (?, ?, 'Rent', 100, 'expense', 'monthly', ?, ?, 1)`,
    [userId, accountId, `${LAST}-01`, TODAY]
  );
  return accountId;
}

async function seedOtherUser(db) {
  const u = await dbRun(
    db,
    `INSERT INTO users (username, email, password, full_name) VALUES ('other', 'other@example.com', 'x', 'Other')`
  );
  const accountId = await seedAccount(db, u.id);
  await tx(db, u.id, accountId, `${THIS}-01`, 'Yachts', -999999, 'expense', 'Not yours');
  return u.id;
}

function resetMock() {
  mockProvider._configured = true;
  mockProvider._reply = 'Mocked story';
  mockProvider.isConfigured.mockClear();
  mockProvider.chat.mockClear();
}

// ---------------------------------------------------------------------------
describe('financialInsights.buildDigest (deterministic)', () => {
  let ctx;
  let svc; // loaded AFTER makeApp(): the harness resets db/database per app
  beforeAll(async () => {
    ctx = await makeApp();
    svc = require('../services/financialInsights');
    await seedFinance(ctx.db, ctx.userId);
    await seedOtherUser(ctx.db);
  });
  afterAll(async () => ctx && ctx.close());
  beforeEach(resetMock);

  test('income/spend deltas, categories, top movers, savings rate, projections', async () => {
    const d = await svc.buildDigest(ctx.userId, { now: NOW });
    expect(d.period).toBe(THIS);
    expect(d.income).toEqual({ thisMonth: 12000, lastMonth: 10000, deltaPct: 20 });
    expect(d.spend.thisMonth).toBe(1400);
    expect(d.spend.lastMonth).toBe(800);
    expect(d.spend.deltaPct).toBe(75);

    const groceries = d.byCategory.find((c) => c.category === 'Groceries');
    expect(groceries).toEqual({ category: 'Groceries', thisMonth: 900, lastMonth: 300, deltaPct: 200 });
    const transport = d.byCategory.find((c) => c.category === 'Transport');
    expect(transport.deltaPct).toBe(-60);

    expect(d.topMovers.map((m) => m.category)).toEqual(['Groceries', 'Fun']);
    expect(d.savingsRate).toBeCloseTo((12000 - 1400) / 12000, 6);
    expect(d.recurringUpcoming).toBe(100);
    expect(typeof d.cashFlow.projectedNet).toBe('number');
    // Other user's "Yachts" never leaks in.
    expect(d.byCategory.find((c) => c.category === 'Yachts')).toBeUndefined();
  });

  test('anomaly: a charge 2.5x above the category norm (>=2 priors) is flagged', async () => {
    const d = await svc.buildDigest(ctx.userId, { now: NOW });
    expect(d.anomalies).toHaveLength(1);
    expect(d.anomalies[0]).toMatchObject({ category: 'Groceries', amount: 900, date: `${THIS}-01` });
    expect(d.anomalies[0].reason).toMatch(/9\.0x the Groceries norm/);
  });

  test('budgets: spend recomputed from transactions, pctUsed + projectedBreach', async () => {
    const d = await svc.buildDigest(ctx.userId, { now: NOW });
    expect(d.budgets).toHaveLength(1);
    expect(d.budgets[0]).toMatchObject({ name: 'Groceries Budget', category: 'Groceries', limit: 1000, spent: 900, pctUsed: 90 });
    expect(typeof d.budgets[0].projectedBreach).toBe('boolean');
  });

  test('deriveAlerts: budget + anomaly present, high before medium', () => {
    const digest = {
      budgets: [
        { name: 'Low', limit: 100, spent: 10, pctUsed: 10, projectedBreach: false },
        { name: 'Hot', limit: 100, spent: 85, pctUsed: 85, projectedBreach: false },
        { name: 'Blown', limit: 100, spent: 120, pctUsed: 120, projectedBreach: true },
      ],
      anomalies: [{ category: 'Fun', amount: 500, reason: '5.0x the Fun norm (~100)' }],
      cashFlow: { projectedNet: -250 },
      savingsRate: -0.1,
    };
    const alerts = insights.deriveAlerts(digest);
    expect(alerts.map((a) => a.type)).toEqual(expect.arrayContaining(['budget', 'anomaly', 'cashflow', 'savings']));
    expect(alerts.find((a) => a.message.includes('"Low"'))).toBeUndefined();
    expect(alerts.find((a) => a.message.includes('"Hot"')).severity).toBe('medium');
    expect(alerts.find((a) => a.message.includes('"Blown"')).severity).toBe('high');
    const sev = alerts.map((a) => a.severity);
    expect(sev.indexOf('medium')).toBeGreaterThan(sev.lastIndexOf('high'));
    expect(alerts.find((a) => a.type === 'cashflow').message).toContain('250');
  });

  test('digestToPrompt renders the FINANCIAL DIGEST block with real numbers', async () => {
    const d = await svc.buildDigest(ctx.userId, { now: NOW });
    const text = insights.digestToPrompt(d);
    expect(text).toContain(`FINANCIAL DIGEST (${THIS})`);
    expect(text).toContain('Income this month: 12000 (last 10000)');
    expect(text).toContain('Spend this month: 1400 (last 800)');
    expect(text).toContain('- Groceries: 900 (was 300, +200%)');
    expect(text).toContain('Anomalies: Groceries 900');
    expect(text).toContain('Upcoming recurring (7d): 100');
  });

  test('empty user -> zeroed digest, no alerts, no crash', async () => {
    const u = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password, full_name) VALUES ('empty', 'empty@example.com', 'x', 'Empty')`
    );
    const d = await svc.buildDigest(u.id, { now: NOW });
    expect(d.income.thisMonth).toBe(0);
    expect(d.spend.thisMonth).toBe(0);
    expect(d.anomalies).toEqual([]);
    expect(d.savingsRate).toBe(0);
    expect(insights.deriveAlerts(d)).toEqual([]);
    expect(insights.digestToPrompt(d)).toContain('(no spending yet)');
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/ai/digest and /api/ai/alerts', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
  });
  afterAll(async () => ctx && ctx.close());
  beforeEach(resetMock);

  test('digest: envelope {success,data:{digest,alerts}}, works without AI provider', async () => {
    mockProvider._configured = false;
    const res = await ctx.request.get('/api/ai/digest').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.digest.period).toBe(THIS);
    expect(res.body.data.digest.income.thisMonth).toBe(12000);
    expect(Array.isArray(res.body.data.alerts)).toBe(true);
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  test('alerts: budget at 90% and the Groceries anomaly show up', async () => {
    const res = await ctx.request.get('/api/ai/alerts').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    const types = res.body.data.alerts.map((a) => a.type);
    expect(types).toContain('budget');
    expect(types).toContain('anomaly');
    expect(res.body.data.period).toBe(THIS);
  });

  test('unauthenticated -> 401', async () => {
    const res = await ctx.request.get('/api/ai/digest');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/ai/insights/monthly (cached in ai_insights)', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
  });
  afterAll(async () => ctx && ctx.close());
  beforeEach(resetMock);

  test('migration 017b created ai_insights with the per-user unique key', async () => {
    const cols = await dbAll(ctx.db, `PRAGMA table_info(ai_insights)`);
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['user_id', 'period', 'type', 'content', 'model', 'generated_at']));
    expect(names).not.toContain('org_id');
    const applied = await dbAll(ctx.db, `SELECT name FROM schema_migrations WHERE name = '017b_ai_insights'`);
    expect(applied).toHaveLength(1);
  });

  test('first call generates (grounded prompt), second call is served from cache', async () => {
    mockProvider._reply = (args) => {
      // The LLM is grounded: system prompt carries the digest numbers and the guardrail.
      expect(args.system).toContain('FINANCIAL DIGEST');
      expect(args.system).toContain('Income this month: 12000');
      expect(args.system).toContain(insights.GROUNDING_SYSTEM);
      return 'You earned 12000 and spent 1400. Groceries jumped. Tip: cap Groceries.';
    };
    const first = await ctx.request.get('/api/ai/insights/monthly').set('Authorization', `Bearer ${ctx.token}`);
    expect(first.status).toBe(200);
    expect(first.body.data.cached).toBe(false);
    expect(first.body.data.aiUsed).toBe(true);
    expect(first.body.data.insight.month).toBe(THIS);
    expect(first.body.data.insight.text).toContain('12000');
    expect(first.body.data.insight.totalIncome).toBe(12000);
    expect(first.body.data.insight.totalSpent).toBe(1400);
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);

    const rows = await dbAll(ctx.db, `SELECT * FROM ai_insights WHERE user_id = ? AND type = 'monthly'`, [ctx.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].period).toBe(THIS);
    expect(rows[0].model).toBe('gemini-2.5-flash');

    const second = await ctx.request.get('/api/ai/insights/monthly').set('Authorization', `Bearer ${ctx.token}`);
    expect(second.status).toBe(200);
    expect(second.body.data.cached).toBe(true);
    expect(second.body.data.insight.text).toBe(first.body.data.insight.text);
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });

  test('refresh=1 regenerates and replaces the cached row', async () => {
    mockProvider._reply = 'Fresh story';
    const res = await ctx.request
      .get('/api/ai/insights/monthly?refresh=1')
      .set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.cached).toBe(false);
    expect(res.body.data.insight.text).toBe('Fresh story');
    const rows = await dbAll(ctx.db, `SELECT content FROM ai_insights WHERE user_id = ? AND type = 'monthly' AND period = ?`, [
      ctx.userId,
      THIS,
    ]);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Fresh story');
  });

  test('explicit past month is computed for that month and cached under its own period', async () => {
    mockProvider._reply = 'Last month story';
    const res = await ctx.request
      .get(`/api/ai/insights/monthly?month=${LAST}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.insight.month).toBe(LAST);
    expect(res.body.data.insight.totalIncome).toBe(10000);
    expect(res.body.data.insight.totalSpent).toBe(800);
    const rows = await dbAll(ctx.db, `SELECT period FROM ai_insights WHERE user_id = ? AND type = 'monthly' ORDER BY period`, [ctx.userId]);
    expect(rows.map((r) => r.period)).toEqual([LAST, THIS].sort());
  });

  test('invalid month -> 400 INVALID_MONTH', async () => {
    const res = await ctx.request
      .get('/api/ai/insights/monthly?month=2026-13-01')
      .set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MONTH');
  });

  test('no provider -> deterministic story from digest numbers, aiUsed:false, nothing cached', async () => {
    mockProvider._configured = false;
    const u = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password, full_name) VALUES ('nop', 'nop@example.com', 'x', 'No Provider')`
    );
    await seedFinance(ctx.db, u.id);
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const token = jwt.sign({ id: u.id }, config.jwtSecret, { expiresIn: '1h' });

    const res = await ctx.request.get('/api/ai/insights/monthly').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.aiUsed).toBe(false);
    expect(res.body.data.aiConfigured).toBe(false);
    expect(res.body.data.insight.text).toContain('earned 12000 and spent 1400');
    expect(mockProvider.chat).not.toHaveBeenCalled();
    const rows = await dbAll(ctx.db, `SELECT id FROM ai_insights WHERE user_id = ?`, [u.id]);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/ai/insights/weekly', () => {
  let ctx;
  let accountId;
  beforeAll(async () => {
    ctx = await makeApp();
    accountId = await seedAccount(ctx.db, ctx.userId);
    const yesterday = iso(new Date(NOW.getTime() - 864e5));
    const tenDaysAgo = iso(new Date(NOW.getTime() - 10 * 864e5));
    await tx(ctx.db, ctx.userId, accountId, TODAY, 'Groceries', -250, 'expense', 'Market');
    await tx(ctx.db, ctx.userId, accountId, yesterday, 'Fun', -50, 'expense', 'Cinema');
    await tx(ctx.db, ctx.userId, accountId, yesterday, 'Income', 1000, 'income', 'Freelance');
    await tx(ctx.db, ctx.userId, accountId, tenDaysAgo, 'Fun', -5000, 'expense', 'Too old for the week');
  });
  afterAll(async () => ctx && ctx.close());
  beforeEach(resetMock);

  test('with provider: brief grounded on digest + week data, totals exclude older transactions', async () => {
    mockProvider._reply = (args) => {
      expect(args.system).toContain('FINANCIAL DIGEST');
      expect(args.messages[0].content).toContain('"totalSpent":300');
      expect(args.messages[0].content).toContain('"totalEarned":1000');
      return 'Easy week: 300 out, 1000 in.';
    };
    const res = await ctx.request.get('/api/ai/insights/weekly').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ brief: 'Easy week: 300 out, 1000 in.', totalSpent: 300, totalEarned: 1000, transactionCount: 3, aiUsed: true });
    expect(res.body.data.topCategory).toEqual({ category: 'Groceries', total: 250 });
    expect(Array.isArray(res.body.data.dailyTotals)).toBe(true);
  });

  test('without provider: deterministic brief with the same totals', async () => {
    mockProvider._configured = false;
    const res = await ctx.request.get('/api/ai/insights/weekly').set('Authorization', `Bearer ${ctx.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.aiUsed).toBe(false);
    expect(res.body.data.brief).toContain('3 transactions, spent 300, earned 1000');
    expect(res.body.data.brief).toContain('Groceries (250)');
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('aiService system prompt is grounded on the digest', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
  });
  afterAll(async () => ctx && ctx.close());
  beforeEach(resetMock);

  test('buildFinancialContext.text starts with the FINANCIAL DIGEST, snapshot follows', async () => {
    const aiService = require('../services/aiService');
    const context = await aiService.buildFinancialContext(ctx.userId);
    expect(context.text.startsWith(`FINANCIAL DIGEST (${THIS})`)).toBe(true);
    expect(context.text).toContain('=== USER FINANCIAL SNAPSHOT (real data) ===');
    expect(context.digest.income.thisMonth).toBe(12000);
    const system = aiService.buildSystemPrompt(context.text);
    expect(system.startsWith(insights.GROUNDING_SYSTEM)).toBe(true);
    expect(system.indexOf('FINANCIAL DIGEST')).toBeLessThan(system.indexOf('USER FINANCIAL SNAPSHOT'));
  });

  test('POST /api/ai/chat sends the digest numbers in the system prompt', async () => {
    let seenSystem = '';
    mockProvider._reply = (args) => {
      seenSystem = args.system;
      return 'ok';
    };
    const res = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ message: 'How am I doing?' });
    expect(res.status).toBe(200);
    expect(seenSystem).toContain('Income this month: 12000 (last 10000)');
    expect(seenSystem).toContain('Anomalies: Groceries 900');
  });
});
