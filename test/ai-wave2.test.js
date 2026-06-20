// test/ai-wave2.test.js — Wave-2 AI CFO: streaming chat, auto-categorize, monthly summary.
// Провайдер lib/ai/provider замокан (jest.mock), сети нет. Проверяем:
//   - POST /api/ai/chat/stream отдаёт SSE-поток с событиями start/chunk/done и
//     эмулирует токен-за-токеном (несколько chunk-событий для длинного ответа)
//   - GET  /api/ai/categorize мапит ТОЛЬКО на существующие категории пользователя
//   - POST /api/ai/categorize применяет принятые назначения и НЕ трогает чужое/уже размеченное
//   - GET  /api/ai/summary строит статистику из реальных засеянных транзакций месяца
//   - тариф ниже 'pro' -> 402; ненастроенный провайдер -> 503 на стрим/категоризацию
//
// Те же конвенции, что в test/ai.test.js: управляемый мок, raw-sqlite хелперы.

const { makeApp } = require('./helpers/app');

// Управляемый мок провайдера. _reply может быть строкой или функцией от call-args.
const mockProvider = {
  _configured: true,
  _reply: 'Mocked CFO reply',
  isConfigured: jest.fn(() => mockProvider._configured),
  chat: jest.fn(async (args) => {
    const r = typeof mockProvider._reply === 'function' ? mockProvider._reply(args) : mockProvider._reply;
    return { text: r };
  }),
};

jest.mock('../lib/ai/provider', () => mockProvider);

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
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function setTier(db, userId, tier) {
  await dbRun(db, 'UPDATE users SET subscription_tier = ? WHERE id = ?', [tier, userId]);
}

function resetMock() {
  mockProvider._configured = true;
  mockProvider._reply = 'Mocked CFO reply';
  mockProvider.isConfigured.mockClear();
  mockProvider.chat.mockClear();
}

// Создаёт аккаунт и возвращает его id.
async function seedAccount(db, userId) {
  const acc = await dbRun(
    db,
    `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [userId, 'Main Card', 'UAH', 5000, 'card']
  );
  return acc.id;
}

// Парсер SSE-текста: -> [{ event, data }]
function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    let data = {};
    try {
      data = JSON.parse(dataLines.join('\n') || '{}');
    } catch (e) {
      data = {};
    }
    events.push({ event, data });
  }
  return events;
}

// ===========================================================================
// 1) STREAMING
// ===========================================================================

describe('AI Wave-2 — streaming chat (SSE)', () => {
  let ctx;
  beforeEach(resetMock);
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  test('POST /api/ai/chat/stream emits start, multiple chunks, done; persists messages', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    const accountId = await seedAccount(ctx.db, ctx.userId);
    await dbRun(
      ctx.db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-06-01', 'Salary', 'Income', 40000, 'income')`,
      [accountId, ctx.userId]
    );

    // Длинный ответ -> должен порезаться на несколько чанков (CHUNK_SIZE=60).
    const longReply = 'X'.repeat(200);
    mockProvider._reply = longReply;

    const res = await ctx.request
      .post('/api/ai/chat/stream')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'How am I doing?' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.text);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('start');
    expect(types).toContain('done');

    const chunks = events.filter((e) => e.event === 'chunk');
    // 200 символов / 60 -> 4 чанка (эмуляция токен-за-токеном)
    expect(chunks.length).toBeGreaterThan(1);
    const reconstructed = chunks.map((c) => c.data.text).join('');
    expect(reconstructed).toBe(longReply);

    const startEv = events.find((e) => e.event === 'start');
    const doneEv = events.find((e) => e.event === 'done');
    expect(startEv.data.conversationId).toBeTruthy();
    expect(doneEv.data.conversationId).toBe(startEv.data.conversationId);
    expect(doneEv.data.reply).toBe(longReply);

    // Сообщения сохранены в БД (user + assistant).
    const rows = await dbAll(
      ctx.db,
      'SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC',
      [startEv.data.conversationId]
    );
    expect(rows.length).toBe(2);
    expect(rows[0].role).toBe('user');
    expect(rows[0].content).toBe('How am I doing?');
    expect(rows[1].role).toBe('assistant');
    expect(rows[1].content).toBe(longReply);
  });

  test('stream reuses provided conversationId on follow-up', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');

    const first = await ctx.request
      .post('/api/ai/chat/stream')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'First' });
    const cid = parseSse(first.text).find((e) => e.event === 'start').data.conversationId;

    const second = await ctx.request
      .post('/api/ai/chat/stream')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ conversationId: cid, message: 'Second' });
    const startCid = parseSse(second.text).find((e) => e.event === 'start').data.conversationId;
    expect(startCid).toBe(cid);

    const rows = await dbAll(
      ctx.db,
      'SELECT role FROM ai_messages WHERE conversation_id = ?',
      [cid]
    );
    expect(rows.length).toBe(4);
  });

  test('stream: empty message -> 400 (before opening SSE)', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');

    const res = await ctx.request
      .post('/api/ai/chat/stream')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('EMPTY_MESSAGE');
  });

  test('stream: unconfigured provider -> 503', async () => {
    mockProvider._configured = false;
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');

    const res = await ctx.request
      .post('/api/ai/chat/stream')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'hi' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
  });

  test('stream: free tier -> 402', async () => {
    ctx = await makeApp();
    const res = await ctx.request
      .post('/api/ai/chat/stream')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ message: 'hi' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
  });
});

// ===========================================================================
// 2) AUTO-CATEGORIZE
// ===========================================================================

describe('AI Wave-2 — auto-categorize', () => {
  let ctx;
  beforeEach(resetMock);
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  // Сеем категории + размеченные/неразмеченные транзакции.
  async function seedForCat(db, userId) {
    const accountId = await seedAccount(db, userId);

    // Существующие категории пользователя.
    for (const name of ['Groceries', 'Transport', 'Entertainment']) {
      await dbRun(
        db,
        `INSERT INTO categories (user_id, name, type) VALUES (?, ?, 'expense')`,
        [userId, name]
      );
    }

    // Неразмеченные транзакции (category NULL или пусто).
    const u1 = await dbRun(
      db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-06-02', 'Silpo market', NULL, -1200, 'expense')`,
      [accountId, userId]
    );
    const u2 = await dbRun(
      db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-06-03', 'Uber ride', '', -300, 'expense')`,
      [accountId, userId]
    );
    // Уже размеченная — НЕ должна попасть в кандидаты.
    await dbRun(
      db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-06-04', 'Netflix', 'Entertainment', -350, 'expense')`,
      [accountId, userId]
    );
    return { accountId, u1: u1.id, u2: u2.id };
  }

  test('GET /api/ai/categorize maps only to existing categories (drops hallucinated)', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    const { u1, u2 } = await seedForCat(ctx.db, ctx.userId);

    // Модель возвращает валидную категорию для u1, ВЫМЫШЛЕННУЮ для u2,
    // и id, которого нет в батче — всё лишнее должно отброситься.
    mockProvider._reply = JSON.stringify({
      [String(u1)]: 'Groceries',
      [String(u2)]: 'CryptoMoonbase', // не из списка -> drop
      99999: 'Transport', // чужой id -> drop
    });

    const res = await ctx.request
      .get('/api/ai/categorize')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.aiUsed).toBe(true);
    expect(data.categories).toEqual(expect.arrayContaining(['Groceries', 'Transport', 'Entertainment']));
    // Только u1 -> Groceries прошло валидацию.
    expect(data.suggestions.length).toBe(1);
    expect(data.suggestions[0].transactionId).toBe(u1);
    expect(data.suggestions[0].suggestedCategory).toBe('Groceries');
    // uncategorizedCount считает обе неразмеченные.
    expect(data.uncategorizedCount).toBe(2);
  });

  test('GET /api/ai/categorize matches category case-insensitively to canonical name', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    const { u1 } = await seedForCat(ctx.db, ctx.userId);

    mockProvider._reply = JSON.stringify({ [String(u1)]: 'groceries' }); // lowercase

    const res = await ctx.request
      .get('/api/ai/categorize')
      .set('Authorization', 'Bearer ' + ctx.token);

    const sug = res.body.data.suggestions.find((s) => s.transactionId === u1);
    expect(sug).toBeTruthy();
    expect(sug.suggestedCategory).toBe('Groceries'); // канон. написание из справочника
  });

  test('GET /api/ai/categorize: no categories -> empty suggestions, no LLM call', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    const accountId = await seedAccount(ctx.db, ctx.userId);
    await dbRun(
      ctx.db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-06-02', 'Mystery', NULL, -100, 'expense')`,
      [accountId, ctx.userId]
    );

    const res = await ctx.request
      .get('/api/ai/categorize')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([]);
    expect(res.body.data.categories).toEqual([]);
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  test('POST /api/ai/categorize applies accepted suggestions and persists', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    const { u1, u2 } = await seedForCat(ctx.db, ctx.userId);

    const res = await ctx.request
      .post('/api/ai/categorize')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({
        accepted: [
          { transactionId: u1, category: 'Groceries' },
          { transactionId: u2, category: 'Transport' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(2);
    expect(res.body.data.appliedIds).toEqual(expect.arrayContaining([u1, u2]));

    const row1 = await dbGet(ctx.db, 'SELECT category FROM transactions WHERE id = ?', [u1]);
    const row2 = await dbGet(ctx.db, 'SELECT category FROM transactions WHERE id = ?', [u2]);
    expect(row1.category).toBe('Groceries');
    expect(row2.category).toBe('Transport');
  });

  test('POST /api/ai/categorize does NOT overwrite already-categorized or other-user tx', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    const accountId = await seedAccount(ctx.db, ctx.userId);

    // Уже размеченная транзакция нашего пользователя.
    const mine = await dbRun(
      ctx.db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-06-05', 'Already set', 'Entertainment', -100, 'expense')`,
      [accountId, ctx.userId]
    );

    // Транзакция другого пользователя (неразмеченная).
    const other = await dbRun(
      ctx.db,
      `INSERT INTO users (username, email, password) VALUES ('other','o@e.com','x')`
    );
    const otherAcc = await dbRun(
      ctx.db,
      `INSERT INTO accounts (user_id, name, balance, is_active) VALUES (?, 'Acc', 0, 1)`,
      [other.id]
    );
    const otherTx = await dbRun(
      ctx.db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, '2026-06-05', 'Theirs', NULL, -50, 'expense')`,
      [otherAcc.id, other.id]
    );

    const res = await ctx.request
      .post('/api/ai/categorize')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({
        accepted: [
          { transactionId: mine.id, category: 'Groceries' }, // уже размечена -> игнор
          { transactionId: otherTx.id, category: 'Groceries' }, // чужая -> игнор
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(0);

    const mineRow = await dbGet(ctx.db, 'SELECT category FROM transactions WHERE id = ?', [mine.id]);
    const otherRow = await dbGet(ctx.db, 'SELECT category FROM transactions WHERE id = ?', [otherTx.id]);
    expect(mineRow.category).toBe('Entertainment'); // не перетёрто
    expect(otherRow.category).toBeNull(); // чужое не тронуто
  });

  test('GET /api/ai/categorize: unconfigured provider -> 503 (when there is work to do)', async () => {
    mockProvider._configured = false;
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    await seedForCat(ctx.db, ctx.userId);

    const res = await ctx.request
      .get('/api/ai/categorize')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
  });

  test('POST /api/ai/categorize: free tier -> 402', async () => {
    ctx = await makeApp();
    const res = await ctx.request
      .post('/api/ai/categorize')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ accepted: [] });
    expect(res.status).toBe(402);
  });
});

// ===========================================================================
// 3) MONTHLY SUMMARY
// ===========================================================================

describe('AI Wave-2 — monthly summary', () => {
  let ctx;
  beforeEach(resetMock);
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  async function seedMonth(db, userId) {
    const accountId = await seedAccount(db, userId);
    const rows = [
      ['2026-05-01', 'Salary May', 'Income', 30000, 'income'],
      ['2026-05-05', 'Groceries A', 'Groceries', -1000, 'expense'],
      ['2026-05-06', 'Groceries B', 'Groceries', -500, 'expense'],
      ['2026-05-07', 'Big TV', 'Electronics', -8000, 'expense'],
      // Другой месяц — не должен попасть в выборку 2026-05.
      ['2026-04-30', 'Old expense', 'Misc', -999, 'expense'],
    ];
    for (const [date, description, category, amount, type] of rows) {
      await dbRun(
        db,
        `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [accountId, userId, date, description, category, amount, type]
      );
    }
  }

  test('GET /api/ai/summary builds stats from real seeded month data', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    await seedMonth(ctx.db, ctx.userId);

    mockProvider._reply = 'You had a solid month with a healthy surplus.';

    const res = await ctx.request
      .get('/api/ai/summary?month=2026-05')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.month).toBe('2026-05');

    const s = data.stats;
    // 30000 income; expenses 1000+500+8000 = 9500 (апрельская не учтена).
    expect(s.totalIncome).toBe(30000);
    expect(s.totalExpense).toBe(9500);
    expect(s.netFlow).toBe(20500);
    expect(s.transactionsCount).toBe(4); // только майские

    // Топ-категория расходов — Electronics (8000).
    expect(s.topCategories[0].category).toBe('Electronics');
    expect(s.topCategories[0].total).toBe(8000);
    const groceries = s.topCategories.find((c) => c.category === 'Groceries');
    expect(groceries.total).toBe(1500);

    // Крупнейшая трата.
    expect(s.largestExpense.amount).toBe(8000);
    expect(s.largestExpense.description).toBe('Big TV');

    // Нарратив из мока.
    expect(data.aiUsed).toBe(true);
    expect(data.narrative).toBe('You had a solid month with a healthy surplus.');

    // Провайдер был заземлён на факты (system содержит числа).
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    const callArg = mockProvider.chat.mock.calls[0][0];
    expect(callArg.system).toContain('9500');
    expect(callArg.system).toContain('Electronics');
  });

  test('GET /api/ai/summary: empty month -> deterministic fallback, no LLM call', async () => {
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    // Никаких транзакций в этом месяце.

    const res = await ctx.request
      .get('/api/ai/summary?month=2099-01')
      .set('Authorization', 'Bearer ' + ctx.token);

    expect(res.status).toBe(200);
    expect(res.body.data.stats.transactionsCount).toBe(0);
    expect(res.body.data.aiUsed).toBe(false);
    expect(res.body.data.narrative).toContain('2099-01');
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  test('GET /api/ai/summary: unconfigured provider still returns deterministic narrative', async () => {
    mockProvider._configured = false;
    ctx = await makeApp();
    await setTier(ctx.db, ctx.userId, 'pro');
    await seedMonth(ctx.db, ctx.userId);

    const res = await ctx.request
      .get('/api/ai/summary?month=2026-05')
      .set('Authorization', 'Bearer ' + ctx.token);

    // Сводка строится из данных без сети; нарратив — детерминированный фолбэк.
    expect(res.status).toBe(200);
    expect(res.body.data.stats.totalExpense).toBe(9500);
    expect(res.body.data.aiUsed).toBe(false);
    expect(res.body.data.narrative).toContain('2026-05');
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  test('GET /api/ai/summary: free tier -> 402', async () => {
    ctx = await makeApp();
    const res = await ctx.request
      .get('/api/ai/summary')
      .set('Authorization', 'Bearer ' + ctx.token);
    expect(res.status).toBe(402);
  });
});
