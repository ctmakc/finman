// ==================== AI FINANCIAL CFO — SERVICE ====================
// Строит финансовый контекст пользователя ИЗ ЕГО РЕАЛЬНЫХ ДАННЫХ
// (транзакции, бюджеты, цели, чистая стоимость, топ-категории трат) и
// общается с провайдер-агностичным LLM (lib/ai/provider) под промптом CFO,
// заземлённым ТОЛЬКО на эти данные. Сообщения сохраняются в ai_conversations/
// ai_messages через models/aiConversation.
//
// Контракт провайдера: provider.chat({ system, messages, maxTokens }) -> { text }
// provider.isConfigured() -> bool. Если не настроен — бросаем AppError(503).

const { query, get, run } = require('../db/database');
const money = require('../lib/money');
const provider = require('../lib/ai/provider');
const { AppError } = require('../middleware/error');
const AiConversation = require('../models/aiConversation');

// Сколько последних транзакций и сообщений тянуть в контекст.
const RECENT_TX_LIMIT = 30;
const TOP_CATEGORIES_LIMIT = 8;
const HISTORY_MESSAGE_LIMIT = 20;

// Wave-2: авто-категоризация и месячная сводка.
const AUTOCAT_TX_LIMIT = 50; // сколько неразмеченных транзакций обрабатывать за раз
const STREAM_CHUNK_SIZE = 60; // размер чанка при эмуляции стриминга (символы)

// --------------------------------------------------------------------------
// Сбор сырых данных пользователя (всё параметризовано, фильтр по user_id).
// --------------------------------------------------------------------------

async function getRecentTransactions(userId, limit = RECENT_TX_LIMIT) {
  return query(
    `SELECT t.id, t.date, t.description, t.category, t.amount, t.type,
            a.name AS account_name, a.currency AS currency
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ?
      ORDER BY t.date DESC, t.id DESC
      LIMIT ?`,
    [userId, limit]
  );
}

async function getBudgets(userId) {
  return query(
    `SELECT id, name, category, amount, spent, period, currency
       FROM budgets
      WHERE user_id = ? AND is_active = 1
      ORDER BY amount DESC`,
    [userId]
  );
}

async function getGoals(userId) {
  return query(
    `SELECT id, name, target_amount, current_amount, currency, target_date, is_completed
       FROM savings_goals
      WHERE user_id = ? AND is_active = 1
      ORDER BY created_at DESC`,
    [userId]
  );
}

async function getDebts(userId) {
  return query(
    `SELECT id, name, type, amount, paid_amount, currency, due_date, is_paid
       FROM debts
      WHERE user_id = ? AND is_active = 1
      ORDER BY amount DESC`,
    [userId]
  );
}

async function getAccounts(userId) {
  return query(
    `SELECT id, name, currency, balance, account_type
       FROM accounts
      WHERE user_id = ? AND is_active = 1
      ORDER BY balance DESC`,
    [userId]
  );
}

// Последний снимок чистой стоимости, если есть.
async function getLatestNetWorth(userId) {
  return get(
    `SELECT total_assets, total_liabilities, net_worth, snapshot_date
       FROM networth_snapshots
      WHERE user_id = ?
      ORDER BY snapshot_date DESC, id DESC
      LIMIT 1`,
    [userId]
  );
}

// Топ-категории расходов по сумме (только type='expense').
async function getTopSpendingCategories(userId, limit = TOP_CATEGORIES_LIMIT) {
  const rows = await query(
    `SELECT COALESCE(category, 'Uncategorized') AS category,
            SUM(ABS(amount)) AS total,
            COUNT(*) AS tx_count
       FROM transactions
      WHERE user_id = ? AND type = 'expense'
      GROUP BY COALESCE(category, 'Uncategorized')
      ORDER BY total DESC
      LIMIT ?`,
    [userId, limit]
  );
  return rows.map((r) => ({
    category: r.category,
    total: money.round(r.total),
    txCount: r.tx_count,
  }));
}

// --------------------------------------------------------------------------
// buildFinancialContext — компактная сводка реальных данных пользователя.
// Возвращает структуру + готовый текст для system-промпта.
// --------------------------------------------------------------------------

async function buildFinancialContext(userId) {
  const [
    transactions,
    budgets,
    goals,
    debts,
    accounts,
    netWorth,
    topCategories,
  ] = await Promise.all([
    getRecentTransactions(userId),
    getBudgets(userId),
    getGoals(userId),
    getDebts(userId),
    getAccounts(userId),
    getLatestNetWorth(userId),
    getTopSpendingCategories(userId),
  ]);

  // Агрегаты по последним транзакциям.
  const incomeList = transactions
    .filter((t) => t.type === 'income')
    .map((t) => Math.abs(Number(t.amount) || 0));
  const expenseList = transactions
    .filter((t) => t.type === 'expense')
    .map((t) => Math.abs(Number(t.amount) || 0));

  const totalIncome = money.sum(incomeList);
  const totalExpense = money.sum(expenseList);
  const netFlow = money.sub(totalIncome, totalExpense);

  const totalBalance = money.sum(accounts.map((a) => Number(a.balance) || 0));

  const summary = {
    recentTransactionsCount: transactions.length,
    recentIncome: totalIncome,
    recentExpense: totalExpense,
    recentNetFlow: netFlow,
    totalAccountBalance: totalBalance,
    accountsCount: accounts.length,
    budgetsCount: budgets.length,
    goalsCount: goals.length,
    debtsCount: debts.length,
  };

  const context = {
    summary,
    accounts: accounts.map((a) => ({
      name: a.name,
      balance: money.round(a.balance),
      currency: a.currency,
      type: a.account_type,
    })),
    transactions: transactions.map((t) => ({
      date: t.date,
      description: t.description,
      category: t.category,
      amount: money.round(t.amount),
      type: t.type,
      account: t.account_name,
      currency: t.currency,
    })),
    topSpendingCategories: topCategories,
    budgets: budgets.map((b) => ({
      name: b.name,
      category: b.category,
      amount: money.round(b.amount),
      spent: money.round(b.spent),
      remaining: money.sub(b.amount, b.spent),
      period: b.period,
      currency: b.currency,
    })),
    goals: goals.map((g) => ({
      name: g.name,
      target: money.round(g.target_amount),
      current: money.round(g.current_amount),
      remaining: money.sub(g.target_amount, g.current_amount),
      currency: g.currency,
      targetDate: g.target_date,
      completed: Boolean(g.is_completed),
    })),
    debts: debts.map((d) => ({
      name: d.name,
      type: d.type,
      amount: money.round(d.amount),
      paid: money.round(d.paid_amount),
      remaining: money.sub(d.amount, d.paid_amount),
      currency: d.currency,
      dueDate: d.due_date,
      paid_off: Boolean(d.is_paid),
    })),
    netWorth: netWorth
      ? {
          totalAssets: money.round(netWorth.total_assets),
          totalLiabilities: money.round(netWorth.total_liabilities),
          netWorth: money.round(netWorth.net_worth),
          asOf: netWorth.snapshot_date,
        }
      : null,
  };

  context.text = renderContextText(context);
  return context;
}

// Человекочитаемая компактная сводка для system-промпта.
function renderContextText(ctx) {
  const lines = [];
  const s = ctx.summary;

  lines.push('=== USER FINANCIAL SNAPSHOT (real data) ===');
  lines.push(
    `Accounts: ${s.accountsCount}, total balance: ${s.totalAccountBalance}`
  );
  lines.push(
    `Recent activity (last ${s.recentTransactionsCount} transactions): income ${s.recentIncome}, expense ${s.recentExpense}, net ${s.recentNetFlow}`
  );

  if (ctx.netWorth) {
    lines.push(
      `Net worth (as of ${ctx.netWorth.asOf}): ${ctx.netWorth.netWorth} (assets ${ctx.netWorth.totalAssets}, liabilities ${ctx.netWorth.totalLiabilities})`
    );
  }

  if (ctx.accounts.length) {
    lines.push('\nAccounts:');
    ctx.accounts.forEach((a) => {
      lines.push(`- ${a.name}: ${a.balance} ${a.currency || ''} (${a.type || 'account'})`);
    });
  }

  if (ctx.topSpendingCategories.length) {
    lines.push('\nTop spending categories:');
    ctx.topSpendingCategories.forEach((c) => {
      lines.push(`- ${c.category}: ${c.total} (${c.txCount} tx)`);
    });
  }

  if (ctx.budgets.length) {
    lines.push('\nBudgets:');
    ctx.budgets.forEach((b) => {
      lines.push(
        `- ${b.name}${b.category ? ` [${b.category}]` : ''}: spent ${b.spent}/${b.amount} ${b.currency || ''} (remaining ${b.remaining})`
      );
    });
  }

  if (ctx.goals.length) {
    lines.push('\nSavings goals:');
    ctx.goals.forEach((g) => {
      lines.push(
        `- ${g.name}: ${g.current}/${g.target} ${g.currency || ''}${g.targetDate ? ` by ${g.targetDate}` : ''}${g.completed ? ' (DONE)' : ''}`
      );
    });
  }

  if (ctx.debts.length) {
    lines.push('\nDebts:');
    ctx.debts.forEach((d) => {
      lines.push(
        `- ${d.name} [${d.type}]: paid ${d.paid}/${d.amount} ${d.currency || ''} (remaining ${d.remaining})${d.dueDate ? ` due ${d.dueDate}` : ''}`
      );
    });
  }

  if (ctx.transactions.length) {
    lines.push('\nRecent transactions:');
    ctx.transactions.slice(0, 15).forEach((t) => {
      lines.push(
        `- ${t.date} ${t.type === 'income' ? '+' : '-'}${Math.abs(t.amount)} ${t.currency || ''} ${t.category || 'uncat'} "${t.description || ''}"`
      );
    });
  }

  return lines.join('\n');
}

// --------------------------------------------------------------------------
// System-промпт CFO. Жёстко заземляем ИИ на предоставленные данные.
// --------------------------------------------------------------------------

function buildSystemPrompt(contextText) {
  return [
    'You are the user\'s personal AI Financial CFO inside a personal-finance app.',
    'Speak like a pragmatic, friendly chief financial officer: concise, specific, actionable.',
    'CRITICAL GROUNDING RULES:',
    '- Use ONLY the financial data provided below. Do NOT invent numbers, accounts, transactions, or balances.',
    '- If the data needed to answer is missing, say so plainly and suggest what the user should add or track.',
    '- Reference concrete figures from the snapshot when giving advice.',
    '- Never give regulated investment, tax, or legal advice as guarantees; frame as general guidance.',
    '- Keep answers short unless the user asks for detail. Prefer bullet points for recommendations.',
    '',
    contextText,
  ].join('\n');
}

// --------------------------------------------------------------------------
// analyzeSpending — детерминированная аналитика трат + (опционально) ИИ-инсайт.
// Возвращает { context, analysis, insight } — insight может быть null, если
// провайдер не настроен (аналитика всё равно полезна без сети).
// --------------------------------------------------------------------------

async function analyzeSpending(userId) {
  const context = await buildFinancialContext(userId);

  const top = context.topSpendingCategories;
  const totalSpent = money.sum(top.map((c) => c.total));
  const analysis = {
    totalSpent,
    topCategories: top.map((c) => ({
      category: c.category,
      total: c.total,
      txCount: c.txCount,
      sharePercent:
        totalSpent > 0 ? money.round((c.total / totalSpent) * 100) : 0,
    })),
    recentIncome: context.summary.recentIncome,
    recentExpense: context.summary.recentExpense,
    recentNetFlow: context.summary.recentNetFlow,
    savingsRate:
      context.summary.recentIncome > 0
        ? money.round(
            (context.summary.recentNetFlow / context.summary.recentIncome) * 100
          )
        : 0,
    budgetsOverLimit: context.budgets
      .filter((b) => b.spent > b.amount)
      .map((b) => b.name),
  };

  let insight = null;
  if (provider.isConfigured()) {
    const system = buildSystemPrompt(context.text);
    const userMsg =
      'Analyze my recent spending. Identify the 3 biggest opportunities to save money, ' +
      'flag any budgets I am overspending, and give one concrete next action. ' +
      'Base everything strictly on my data above.';
    const result = await provider.chat({
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 800,
    });
    insight = (result && result.text) || '';
  }

  return { context: context.text, analysis, insight };
}

// --------------------------------------------------------------------------
// chat — разговор с CFO. Сохраняет user+assistant сообщения в БД.
//   userId         — владелец
//   conversationId — существующий разговор (опционально; иначе создаём новый)
//   message        — текст пользователя
// Возвращает { conversationId, reply, messages } .
// --------------------------------------------------------------------------

async function chat(userId, conversationId, message) {
  if (!message || !String(message).trim()) {
    throw new AppError(400, 'EMPTY_MESSAGE', 'Message must not be empty');
  }
  if (!provider.isConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI provider not configured');
  }

  // Резолвим/создаём разговор; проверяем владение, если передан id.
  let conversation = null;
  if (conversationId) {
    conversation = await AiConversation.findById(conversationId);
    if (!conversation) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    }
    if (conversation.user_id !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Not your conversation');
    }
  } else {
    const title = String(message).trim().slice(0, 60);
    conversation = await AiConversation.create(userId, title);
  }

  // Сохраняем сообщение пользователя.
  await AiConversation.addMessage(conversation.id, 'user', String(message));

  // Собираем свежий контекст + историю переписки.
  const context = await buildFinancialContext(userId);
  const system = buildSystemPrompt(context.text);

  const history = await AiConversation.getMessages(conversation.id);
  const promptMessages = history
    .slice(-HISTORY_MESSAGE_LIMIT)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  // Запрос к провайдеру.
  const result = await provider.chat({
    system,
    messages: promptMessages,
    maxTokens: 900,
  });
  const reply = (result && result.text) || '';

  // Сохраняем ответ ассистента.
  await AiConversation.addMessage(conversation.id, 'assistant', reply);

  const messages = await AiConversation.getMessages(conversation.id);
  return { conversationId: conversation.id, reply, messages };
}

// --------------------------------------------------------------------------
// chatStream — как chat(), но отдаёт ответ ПОТОКОВО через колбэки.
// Провайдер сам по себе не стримит (chat() -> {text}), поэтому мы получаем
// финальный текст и режем его на чанки, эмулируя токен-за-токеном вывод.
// Структура сделана под реальный стриминг: если провайдер однажды получит
// provider.chatStream({...}, onChunk), достаточно подменить блок генерации.
//
//   userId, conversationId, message — как в chat()
//   callbacks: {
//     onStart?({ conversationId }),
//     onChunk(textPiece),
//     onDone({ conversationId, reply, messages }),
//   }
// Возвращает { conversationId, reply, messages } (то же, что chat()).
// Сообщения сохраняются в БД ПОСЛЕ полной генерации (как и в chat()).
// --------------------------------------------------------------------------

async function chatStream(userId, conversationId, message, callbacks = {}) {
  const onStart = typeof callbacks.onStart === 'function' ? callbacks.onStart : () => {};
  const onChunk = typeof callbacks.onChunk === 'function' ? callbacks.onChunk : () => {};
  const onDone = typeof callbacks.onDone === 'function' ? callbacks.onDone : () => {};

  if (!message || !String(message).trim()) {
    throw new AppError(400, 'EMPTY_MESSAGE', 'Message must not be empty');
  }
  if (!provider.isConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI provider not configured');
  }

  // Резолвим/создаём разговор; проверяем владение, если передан id.
  let conversation = null;
  if (conversationId) {
    conversation = await AiConversation.findById(conversationId);
    if (!conversation) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    }
    if (conversation.user_id !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Not your conversation');
    }
  } else {
    const title = String(message).trim().slice(0, 60);
    conversation = await AiConversation.create(userId, title);
  }

  onStart({ conversationId: conversation.id });

  await AiConversation.addMessage(conversation.id, 'user', String(message));

  const context = await buildFinancialContext(userId);
  const system = buildSystemPrompt(context.text);

  const history = await AiConversation.getMessages(conversation.id);
  const promptMessages = history
    .slice(-HISTORY_MESSAGE_LIMIT)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const result = await provider.chat({
    system,
    messages: promptMessages,
    maxTokens: 900,
  });
  const reply = (result && result.text) || '';

  // Эмулируем стриминг: нарезаем готовый текст на чанки и отдаём по одному.
  for (const piece of chunkText(reply, STREAM_CHUNK_SIZE)) {
    onChunk(piece);
  }

  await AiConversation.addMessage(conversation.id, 'assistant', reply);
  const messages = await AiConversation.getMessages(conversation.id);

  const done = { conversationId: conversation.id, reply, messages };
  onDone(done);
  return done;
}

// Нарезка текста на чанки фиксированного размера (по символам, без потери данных).
function chunkText(text, size = STREAM_CHUNK_SIZE) {
  const str = String(text == null ? '' : text);
  const n = Math.max(1, Number(size) || STREAM_CHUNK_SIZE);
  const chunks = [];
  for (let i = 0; i < str.length; i += n) {
    chunks.push(str.slice(i, i + n));
  }
  return chunks;
}

// --------------------------------------------------------------------------
// autoCategorize — для неразмеченных транзакций (category IS NULL/'') просит
// LLM назначить категорию ИЗ существующих категорий пользователя.
//
// Заземление: список валидных категорий формируется из таблицы categories
// (плюс категории, реально встречающиеся в транзакциях пользователя). LLM
// возвращает строгий JSON-маппинг tx_id -> category_name; всё, что не входит
// в разрешённый список, отбрасывается. НИЧЕГО не пишем в БД — только suggestions.
//
// Возвращает {
//   suggestions: [{ transactionId, description, amount, type, suggestedCategory }],
//   categories: [<allowed category names>],
//   uncategorizedCount,
//   aiUsed: bool
// }
// --------------------------------------------------------------------------

async function getUserCategoryNames(userId) {
  // Категории из справочника пользователя.
  const fromTable = await query(
    `SELECT DISTINCT name FROM categories WHERE user_id = ? AND name IS NOT NULL AND TRIM(name) <> ''`,
    [userId]
  );
  // Категории, реально использованные в транзакциях (на случай пустого справочника).
  const fromTx = await query(
    `SELECT DISTINCT category AS name FROM transactions
      WHERE user_id = ? AND category IS NOT NULL AND TRIM(category) <> ''`,
    [userId]
  );
  const set = new Map(); // lowercase -> original casing (первое вхождение)
  for (const r of [...fromTable, ...fromTx]) {
    const name = String(r.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!set.has(key)) set.set(key, name);
  }
  return [...set.values()];
}

async function getUncategorizedTransactions(userId, limit = AUTOCAT_TX_LIMIT) {
  return query(
    `SELECT id, date, description, amount, type
       FROM transactions
      WHERE user_id = ?
        AND (category IS NULL OR TRIM(category) = '')
      ORDER BY date DESC, id DESC
      LIMIT ?`,
    [userId, limit]
  );
}

async function autoCategorize(userId, opts = {}) {
  const limit = opts.limit || AUTOCAT_TX_LIMIT;
  const categories = await getUserCategoryNames(userId);
  const uncategorized = await getUncategorizedTransactions(userId, limit);

  const base = {
    suggestions: [],
    categories,
    uncategorizedCount: uncategorized.length,
    aiUsed: false,
  };

  // Нечего размечать или некуда размечать — возвращаем пусто без обращения к LLM.
  if (!uncategorized.length || !categories.length) {
    return base;
  }
  if (!provider.isConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI provider not configured');
  }

  // Разрешённый набор (lowercase -> канон. написание) для строгой валидации.
  const allowed = new Map(categories.map((c) => [c.toLowerCase(), c]));

  const system = [
    'You are a precise transaction categorizer for a personal-finance app.',
    'You will receive a fixed list of ALLOWED categories and a list of transactions.',
    'Assign each transaction the single best-fitting category STRICTLY from the allowed list.',
    'RULES:',
    '- Use ONLY category names from the allowed list, copied verbatim.',
    '- If no allowed category fits a transaction, omit it from the output.',
    '- Do NOT invent categories. Do NOT add commentary.',
    '- Respond with ONLY a JSON object mapping transaction id (as string) to category name.',
    '  Example: {"12":"Groceries","15":"Transport"}',
  ].join('\n');

  const allowedList = categories.map((c) => `- ${c}`).join('\n');
  const txList = uncategorized
    .map(
      (t) =>
        `#${t.id} | ${t.date} | ${t.type} | ${money.round(t.amount)} | ${String(t.description || '').slice(0, 80)}`
    )
    .join('\n');

  const userMsg = [
    'ALLOWED CATEGORIES:',
    allowedList,
    '',
    'TRANSACTIONS (id | date | type | amount | description):',
    txList,
    '',
    'Return ONLY the JSON object mapping transaction id to an allowed category name.',
  ].join('\n');

  const result = await provider.chat({
    system,
    messages: [{ role: 'user', content: userMsg }],
    maxTokens: 1000,
  });

  const mapping = parseCategoryMapping((result && result.text) || '');

  // Индексируем неразмеченные для обогащения предложений и проверки принадлежности.
  const byId = new Map(uncategorized.map((t) => [String(t.id), t]));
  const suggestions = [];
  for (const [txId, rawCat] of Object.entries(mapping)) {
    const tx = byId.get(String(txId));
    if (!tx) continue; // не наша/не из этого батча транзакция — игнор
    const canonical = allowed.get(String(rawCat || '').toLowerCase());
    if (!canonical) continue; // категория вне разрешённого списка — отбрасываем
    suggestions.push({
      transactionId: tx.id,
      description: tx.description,
      amount: money.round(tx.amount),
      type: tx.type,
      suggestedCategory: canonical,
    });
  }

  return { ...base, suggestions, aiUsed: true };
}

// Робастный парсер JSON-ответа модели: вытаскивает первый JSON-объект,
// терпит обрамляющий текст и ```json fences```. Возвращает {} при провале.
function parseCategoryMapping(text) {
  if (!text) return {};
  let raw = String(text).trim();
  // снять markdown-ограждение, если есть
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  // если вокруг JSON есть мусор — берём от первой { до последней }
  if (raw[0] !== '{') {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return {};
    raw = raw.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v == null) continue;
    out[String(k)] = String(v);
  }
  return out;
}

// --------------------------------------------------------------------------
// applyCategorizations — применяет ПРИНЯТЫЕ пользователем назначения к БД.
// Принимает массив [{ transactionId, category }]; для каждой пары:
//   - проверяем, что транзакция принадлежит userId И сейчас не размечена
//     (защита от перетирания существующих категорий и от чужих транзакций),
//   - обновляем category параметризованным UPDATE.
// Возвращает { applied: <число>, appliedIds: [...] }.
// --------------------------------------------------------------------------

async function applyCategorizations(userId, accepted = []) {
  if (!Array.isArray(accepted) || !accepted.length) {
    return { applied: 0, appliedIds: [] };
  }

  const appliedIds = [];
  for (const item of accepted) {
    if (!item) continue;
    const txId = item.transactionId;
    const category = item.category != null ? String(item.category).trim() : '';
    if (txId == null || !category) continue;

    // Применяем только к НЕразмеченным транзакциям этого пользователя.
    const res = await run(
      `UPDATE transactions
          SET category = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
          AND (category IS NULL OR TRIM(category) = '')`,
      [category, txId, userId]
    );
    if (res && res.changes > 0) {
      appliedIds.push(Number(txId));
    }
  }

  return { applied: appliedIds.length, appliedIds };
}

// --------------------------------------------------------------------------
// monthlyNarrative — короткая «история денег» за месяц на естественном языке.
//   month — 'YYYY-MM' (по умолчанию текущий календарный месяц UTC).
// Сначала детерминированно собираем факты ИЗ реальных транзакций месяца
// (доход/расход/нетто/топ-категории/крупнейшая трата), затем (если провайдер
// настроен) просим LLM рассказать короткую историю, заземлённую на эти факты.
//
// Возвращает { month, stats, narrative, aiUsed }.
// narrative — текст модели, либо детерминированный фолбэк без сети.
// --------------------------------------------------------------------------

function normalizeMonth(month) {
  const m = String(month || '').trim();
  if (/^\d{4}-\d{2}$/.test(m)) return m;
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${mo}`;
}

async function getMonthTransactions(userId, month) {
  // SQLite: t.date хранится как TEXT 'YYYY-MM-DD...'; матчим префикс месяца.
  return query(
    `SELECT id, date, description, category, amount, type
       FROM transactions
      WHERE user_id = ?
        AND substr(date, 1, 7) = ?
      ORDER BY date ASC, id ASC`,
    [userId, month]
  );
}

async function buildMonthStats(userId, month) {
  const txs = await getMonthTransactions(userId, month);

  const incomeList = txs
    .filter((t) => t.type === 'income')
    .map((t) => Math.abs(Number(t.amount) || 0));
  const expenseList = txs
    .filter((t) => t.type === 'expense')
    .map((t) => Math.abs(Number(t.amount) || 0));

  const totalIncome = money.sum(incomeList);
  const totalExpense = money.sum(expenseList);
  const netFlow = money.sub(totalIncome, totalExpense);

  // Топ-категории расходов за месяц.
  const catMap = new Map();
  for (const t of txs) {
    if (t.type !== 'expense') continue;
    const cat = (t.category && String(t.category).trim()) || 'Uncategorized';
    const prev = catMap.get(cat) || { total: 0, count: 0 };
    catMap.set(cat, {
      total: money.add(prev.total, Math.abs(Number(t.amount) || 0)),
      count: prev.count + 1,
    });
  }
  const topCategories = [...catMap.entries()]
    .map(([category, v]) => ({ category, total: money.round(v.total), txCount: v.count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_CATEGORIES_LIMIT);

  // Крупнейшая отдельная трата месяца.
  let largestExpense = null;
  for (const t of txs) {
    if (t.type !== 'expense') continue;
    const amt = Math.abs(Number(t.amount) || 0);
    if (!largestExpense || amt > largestExpense.amount) {
      largestExpense = {
        amount: money.round(amt),
        description: t.description,
        category: (t.category && String(t.category).trim()) || 'Uncategorized',
        date: t.date,
      };
    }
  }

  const savingsRate =
    totalIncome > 0 ? money.round((netFlow / totalIncome) * 100) : 0;

  return {
    transactionsCount: txs.length,
    totalIncome,
    totalExpense,
    netFlow,
    savingsRate,
    topCategories,
    largestExpense,
  };
}

function renderNarrativeFallback(month, stats) {
  if (!stats.transactionsCount) {
    return `No transactions recorded for ${month}. Add some activity to get a money story.`;
  }
  const parts = [];
  parts.push(
    `In ${month} you earned ${stats.totalIncome} and spent ${stats.totalExpense}, ` +
      `for a net ${stats.netFlow >= 0 ? 'surplus' : 'shortfall'} of ${Math.abs(stats.netFlow)} (savings rate ${stats.savingsRate}%).`
  );
  if (stats.topCategories.length) {
    const top = stats.topCategories[0];
    parts.push(`Your biggest spending category was ${top.category} at ${top.total}.`);
  }
  if (stats.largestExpense) {
    parts.push(
      `The single largest expense was ${stats.largestExpense.amount} on "${stats.largestExpense.description || stats.largestExpense.category}".`
    );
  }
  return parts.join(' ');
}

async function monthlyNarrative(userId, month) {
  const normMonth = normalizeMonth(month);
  const stats = await buildMonthStats(userId, normMonth);

  let narrative = renderNarrativeFallback(normMonth, stats);
  let aiUsed = false;

  if (stats.transactionsCount && provider.isConfigured()) {
    const factLines = [
      `Month: ${normMonth}`,
      `Income: ${stats.totalIncome}`,
      `Expense: ${stats.totalExpense}`,
      `Net: ${stats.netFlow}`,
      `Savings rate: ${stats.savingsRate}%`,
      `Transactions: ${stats.transactionsCount}`,
    ];
    if (stats.topCategories.length) {
      factLines.push('Top spending categories:');
      stats.topCategories.forEach((c) =>
        factLines.push(`- ${c.category}: ${c.total} (${c.txCount} tx)`)
      );
    }
    if (stats.largestExpense) {
      factLines.push(
        `Largest expense: ${stats.largestExpense.amount} on "${stats.largestExpense.description || ''}" [${stats.largestExpense.category}]`
      );
    }

    const system = [
      "You are the user's personal AI Financial CFO. Write a SHORT monthly money story.",
      'GROUNDING RULES:',
      '- Use ONLY the facts/numbers provided below. Do NOT invent figures.',
      '- 3-5 sentences, warm but pragmatic, plain language (no markdown headings).',
      '- Mention the net result, the top spending area, and one concrete suggestion.',
      '',
      factLines.join('\n'),
    ].join('\n');

    const result = await provider.chat({
      system,
      messages: [
        { role: 'user', content: `Tell me the story of my money in ${normMonth}.` },
      ],
      maxTokens: 500,
    });
    const text = (result && result.text || '').trim();
    if (text) {
      narrative = text;
      aiUsed = true;
    }
  }

  return { month: normMonth, stats, narrative, aiUsed };
}

// --------------------------------------------------------------------------
// buildFinancialPlan — проактивный, структурированный финансовый ПЛАН (CFO-коучинг):
// целевая норма сбережений, конкретные сокращения по категориям, график
// финансирования целей, стратегия погашения долгов и топ-3 действия на месяц.
// Это НЕ реактивный чат и НЕ просто аналитика — это план действий.
// Возвращает { context, plan, planText }. planText=null если провайдер не настроен
// (детерминированный каркас plan полезен и без сети). `now` опционален (для тестов).
// --------------------------------------------------------------------------
function monthsBetween(from, to) {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

async function buildFinancialPlan(userId, { now } = {}) {
  const reference = now ? (now instanceof Date ? now : new Date(now)) : new Date();
  const context = await buildFinancialContext(userId);
  const [goals, debts, , topCategories] = await Promise.all([
    getGoals(userId),
    getDebts(userId),
    getBudgets(userId),
    getTopSpendingCategories(userId),
  ]);

  const income = context.summary.recentIncome || 0;
  const expense = context.summary.recentExpense || 0;
  const net = context.summary.recentNetFlow || 0;
  const currentSavingsRate = income > 0 ? money.round((net / income) * 100) : 0;
  // Тянемся к 20% сбережений (или держим текущий, если он уже выше).
  const targetSavingsRate = Math.max(currentSavingsRate, 20);
  const targetMonthlySavings = money.round((income * targetSavingsRate) / 100);
  const savingsGap = money.round(targetMonthlySavings - net); // >0 => нужно ужаться

  // Финансирование целей: сколько в месяц нужно, чтобы успеть к target_date.
  const goalPlans = goals
    .filter((g) => !g.is_completed)
    .map((g) => {
      const remaining = money.sub(g.target_amount, g.current_amount || 0);
      const months = g.target_date ? monthsBetween(reference, g.target_date) : null;
      const monthlyNeeded = months && months > 0 ? money.round(remaining / months) : null;
      return {
        name: g.name,
        currency: g.currency,
        remaining,
        targetDate: g.target_date || null,
        monthsLeft: months,
        monthlyNeeded,
        onTrackHint: monthlyNeeded === null ? 'no-date' : (monthlyNeeded <= net ? 'affordable' : 'stretch'),
      };
    });

  // Стратегия долгов: остаток = amount - paid_amount, по убыванию остатка.
  const debtPlans = debts
    .filter((d) => !d.is_paid)
    .map((d) => ({
      name: d.name,
      type: d.type,
      currency: d.currency,
      remaining: money.round(money.sub(d.amount, d.paid_amount || 0)),
      dueDate: d.due_date || null,
    }))
    .sort((a, b) => b.remaining - a.remaining);

  const plan = {
    monthlyIncome: income,
    monthlyExpense: expense,
    monthlyNet: net,
    currentSavingsRate,
    targetSavingsRate,
    targetMonthlySavings,
    savingsGap,
    goals: goalPlans,
    debts: debtPlans,
    totalDebt: money.sum(debtPlans.map((d) => d.remaining)),
    topCategories,
  };

  let planText = null;
  if (provider.isConfigured()) {
    const system = buildSystemPrompt(context.text);
    const userMsg = [
      'Build me a concrete, prioritized MONTHLY FINANCIAL PLAN based STRICTLY on my data above.',
      'Structure it as short sections with bullet points:',
      '1) Savings target — recommend a monthly savings amount and rate, and whether I am on track.',
      '2) Where to cut — 2-3 SPECIFIC spending categories to trim, each with a concrete amount and a realistic new target.',
      '3) Goals — for each savings goal, how much per month to hit it on time (or flag if the date is unrealistic).',
      '4) Debt strategy — the order to pay off my debts and why.',
      '5) Top 3 actions to take THIS month, most impactful first.',
      'Use my real numbers and currency. Be specific, encouraging, and brief.',
    ].join('\n');
    const result = await provider.chat({
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 1100,
    });
    planText = (result && result.text) || '';
  }

  return { context: context.text, plan, planText };
}

module.exports = {
  buildFinancialContext,
  buildFinancialPlan,
  buildSystemPrompt,
  analyzeSpending,
  chat,
  // Wave-2: стриминг, авто-категоризация, месячная сводка
  chatStream,
  autoCategorize,
  applyCategorizations,
  monthlyNarrative,
  // экспорт внутренних хелперов для тестов/повторного использования
  getRecentTransactions,
  getTopSpendingCategories,
  getUncategorizedTransactions,
  getUserCategoryNames,
  buildMonthStats,
  chunkText,
  parseCategoryMapping,
};
