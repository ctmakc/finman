// ==================== AI FINANCIAL CFO — SERVICE ====================
// Строит финансовый контекст пользователя ИЗ ЕГО РЕАЛЬНЫХ ДАННЫХ
// (транзакции, бюджеты, цели, чистая стоимость, топ-категории трат) и
// общается с провайдер-агностичным LLM (lib/ai/provider) под промптом CFO,
// заземлённым ТОЛЬКО на эти данные. Сообщения сохраняются в ai_conversations/
// ai_messages через models/aiConversation.
//
// Контракт провайдера: provider.chat({ system, messages, maxTokens }) -> { text }
// provider.isConfigured() -> bool. Если не настроен — бросаем AppError(503).

const { query, get } = require('../db/database');
const money = require('../lib/money');
const provider = require('../lib/ai/provider');
const { AppError } = require('../middleware/error');
const AiConversation = require('../models/aiConversation');

// Сколько последних транзакций и сообщений тянуть в контекст.
const RECENT_TX_LIMIT = 30;
const TOP_CATEGORIES_LIMIT = 8;
const HISTORY_MESSAGE_LIMIT = 20;

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

module.exports = {
  buildFinancialContext,
  buildSystemPrompt,
  analyzeSpending,
  chat,
  // экспорт внутренних хелперов для тестов/повторного использования
  getRecentTransactions,
  getTopSpendingCategories,
};
