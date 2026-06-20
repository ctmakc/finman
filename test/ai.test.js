// test/ai.test.js — F4 AI Financial CFO.
// Провайдер lib/ai/provider замокан (jest.mock), сети нет. Проверяем:
//   - buildFinancialContext включает реальные засеянные транзакции/бюджеты/цели
//   - POST /api/ai/chat сохраняет user+assistant сообщения в БД (через мок)
//   - GET /api/ai/insights возвращает анализ трат
//   - ненастроенный провайдер -> 503 AI_NOT_CONFIGURED
//   - тариф ниже 'pro' -> 402 (гейт Foundation), pro -> доступ
//
// ВАЖНО: harness сбрасывает require-кэш lib/* на каждый makeApp(), но jest.mock
// перехватывает модуль в реестре jest независимо от кэша, поэтому и route, и
// service получают именно мок.

const { makeApp } = require('./helpers/app');

// Управляемый мок провайдера. Тесты переключают isConfigured/ответ.
const mockProvider = {
  _configured: true,
  _reply: 'Mocked CFO reply',
  isConfigured: jest.fn(() => mockProvider._configured),
  chat: jest.fn(async () => ({ text: mockProvider._reply })),
};

jest.mock('../lib/ai/provider', () => mockProvider);

// --- helpers ---------------------------------------------------------------

// Промис-обёртки над raw sqlite3 handle из harness.
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

async function setTier(db, userId, tier) {
  await dbRun(db, 'UPDATE users SET subscription_tier = ? WHERE id = ?', [tier, userId]);
}

// Сеем реальные финансовые данные пользователя.
async function seedFinance(db, userId) {
  const acc = await dbRun(
    db,
    `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [userId, 'Main Card', 'UAH', 5000, 'card']
  );
  const accountId = acc.id;

  const txs = [
    ['2026-06-01', 'Salary June', 'Income', 40000, 'income'],
    ['2026-06-02', 'Silpo groceries', 'Groceries', -1200, 'expense'],
    ['2026-06-03', 'Netflix', 'Entertainment', -350, 'expense'],
    ['2026-06-04', 'More groceries', 'Groceries', -800, 'expense'],
    ['2026-06-05', 'Uber rides', 'Transport', -500, 'expense'],
  ];
  for (const [date, description, category, amount, type] of txs) {
    await dbRun(
      db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountId, userId, date, description, category, amount, type]
    );
  }

  await dbRun(
    db,
    `INSERT INTO budgets (user_id, name, category, amount, spent, period, start_date, is_active)
     VALUES (?, ?, ?, ?, ?, 'monthly', '2026-06-01', 1)`,
    [userId, 'Groceries Budget', 'Groceries', 1500, 2000]
  );

  await dbRun(
    db,
    `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, currency, is_active)
     VALUES (?, ?, ?, ?, 'UAH', 1)`,
    [userId, 'Emergency Fund', 100000, 25000]
  );

  return { accountId };
}

// --- tests -----------------------------------------------------------------

describe('AI Financial CFO — context builder', () => {
  let ctx;
  beforeEach(() => {
    mockProvider._configured = true;
    mockProvider._reply = 'Mocked CFO reply';
    mockProvider.isConfigured.mockClear();
    mockProvider.chat.mockClear();
  });
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  test('buildFinancialContext includes real seeded transactions, budgets, goals', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);

    // Сервис резолвится через require — берём свежий после makeApp().
    const aiService = require('../services/aiService');
    const context = await aiService.buildFinancialContext(ctx.userId);

    // Транзакции реальны
    expect(context.transactions.length).toBeGreaterThanOrEqual(5);
    const descriptions = context.transactions.map((t) => t.description);
    expect(descriptions).toContain('Silpo groceries');
    expect(descriptions).toContain('Salary June');

    // Топ-категории посчитаны (Groceries = 1200 + 800 = 2000)
    const groceries = context.topSpendingCategories.find((c) => c.category === 'Groceries');
    expect(groceries).toBeTruthy();
    expect(groceries.total).toBe(2000);

    // Бюджеты/цели присутствуют
    expect(context.budgets.map((b) => b.name)).toContain('Groceries Budget');
    expect(context.goals.map((g) => g.name)).toContain('Emergency Fund');

    // Текстовая сводка содержит реальные числа/имена
    expect(context.text).toContain('Salary June');
    expect(context.text).toContain('Groceries');

    // Агрегаты
    expect(context.summary.recentIncome).toBe(40000);
    expect(context.summary.recentExpense).toBe(2850); // 1200+350+800+500
  });
});

describe('AI Financial CFO — chat endpoint', () => {
  let ctx;
  beforeEach(() => {
    mockProvider._configured = true;
    mockProvider._reply = 'Mocked CFO reply';
    mockProvider.isConfigured.mockClear();
    mockProvider.chat.mockClear();
  });
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  test('POST /api/ai/chat persists user + assistant messages and returns reply', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    await seedFinance(ctx.db, ctx.userId);

    const res = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'How am I doing this month?' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reply).toBe('Mocked CFO reply');
    expect(res.body.data.conversationId).toBeTruthy();

    // Провайдер получил system-промпт и сообщения
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    const callArg = mockProvider.chat.mock.calls[0][0];
    expect(typeof callArg.system).toBe('string');
    expect(callArg.system).toContain('CFO');
    expect(Array.isArray(callArg.messages)).toBe(true);

    // Сообщения сохранены в БД (user + assistant)
    const rows = await dbAll(
      ctx.db,
      'SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC',
      [res.body.data.conversationId]
    );
    expect(rows.length).toBe(2);
    expect(rows[0].role).toBe('user');
    expect(rows[0].content).toBe('How am I doing this month?');
    expect(rows[1].role).toBe('assistant');
    expect(rows[1].content).toBe('Mocked CFO reply');
  });

  test('second message reuses the same conversation', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    await seedFinance(ctx.db, ctx.userId);

    const first = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'First question' });
    const conversationId = first.body.data.conversationId;

    const second = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ conversationId, message: 'Follow up question' });

    expect(second.status).toBe(200);
    expect(second.body.data.conversationId).toBe(conversationId);

    const rows = await dbAll(
      ctx.db,
      'SELECT role FROM ai_messages WHERE conversation_id = ?',
      [conversationId]
    );
    expect(rows.length).toBe(4); // 2 user + 2 assistant
  });

  test('empty message -> 400', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');

    const res = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('EMPTY_MESSAGE');
  });

  test('cannot chat in another user conversation -> 403', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');

    // Чужой разговор
    const otherUser = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password) VALUES ('intruder','i@e.com','x')`
    );
    const otherConv = await dbRun(
      ctx.db,
      `INSERT INTO ai_conversations (user_id, title) VALUES (?, 'theirs')`,
      [otherUser.id]
    );

    const res = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ conversationId: otherConv.id, message: 'sneaky' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('AI Financial CFO — insights endpoint', () => {
  let ctx;
  beforeEach(() => {
    mockProvider._configured = true;
    mockProvider._reply = 'Spending insight text';
    mockProvider.isConfigured.mockClear();
    mockProvider.chat.mockClear();
  });
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  test('GET /api/ai/insights returns spending analysis grounded in real data', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    await seedFinance(ctx.db, ctx.userId);

    const res = await ctx.request
      .get('/api/ai/insights')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { analysis, insight } = res.body.data;

    expect(analysis.recentIncome).toBe(40000);
    expect(analysis.recentExpense).toBe(2850);
    const groceries = analysis.topCategories.find((c) => c.category === 'Groceries');
    expect(groceries.total).toBe(2000);
    // Бюджет Groceries (1500) превышен тратами spent=2000
    expect(analysis.budgetsOverLimit).toContain('Groceries Budget');
    // ИИ-инсайт пришёл из мока
    expect(insight).toBe('Spending insight text');
  });
});

describe('AI Financial CFO — provider/tier gating', () => {
  let ctx;
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
    mockProvider._configured = true;
  });

  test('unconfigured provider -> 503 AI_NOT_CONFIGURED on chat', async () => {
    mockProvider._configured = false;
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');

    const res = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'hi' });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
  });

  test('free tier -> 402 PAYMENT_REQUIRED (Foundation gate)', async () => {
    mockProvider._configured = true;
    ctx = await makeApp();
    // Не повышаем тариф — остаётся free.

    const res = await ctx.request
      .post('/api/ai/chat')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'hi' });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
  });
});
