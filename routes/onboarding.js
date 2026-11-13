// ==================== МАРШРУТЫ ОНБОРДИНГА (WAVE-2 stream "onboarding") ====================
//
// Гайдед-онбординг первого запуска: показывает, какие шаги пройдены, позволяет
// явно отметить шаг завершённым (или пропущенным), и сеет стартовые данные
// (дефолтный счёт + базовые категории) одним вызовом quickstart.
//
// Статус выводится преимущественно из СОСТОЯНИЯ БД (наличие счёта/транзакции/
// бюджета/цели). Дополнительно поддерживается явное завершение/пропуск шага,
// которое хранится в таблице onboarding_progress.
//
// ВАЖНО (ownership): таблица onboarding_progress создаётся лениво и идемпотентно
// (CREATE TABLE IF NOT EXISTS) прямо здесь, чтобы роут работал и в тестах, и в
// проде даже до того, как Интегратор добавит формальную миграцию. См.
// integration_notes — там запрошена каноническая миграция.

const express = require('express');
const router = express.Router();
const { query, get, run } = require('../db/database');
const { defaultCurrency: DEFAULT_CURRENCY } = require('../config/config');
const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');

// ВНИМАНИЕ: аутентификация (apiAuth) монтируется на уровне server.js Интегратором
// (см. integration_notes). На случай прямого монтирования без внешнего apiAuth
// роут безопасно работает: все запросы используют req.user.id, который заполняет
// passport-jwt. Если req.user отсутствует — отдаём 401.
router.use((req, res, next) => {
  if (!req.user || !req.user.id) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }
  next();
});

// Канонический список шагов онбординга (порядок = порядок мастера).
const STEPS = ['account', 'transaction', 'budget', 'goal'];

// Дефолтные категории для стартового сидера (тип + цвет в стиле приложения).
const DEFAULT_CATEGORIES = [
  { name: 'Groceries', type: 'expense', color: '#5D5CDE' },
  { name: 'Vehicles', type: 'expense', color: '#22C55E' },
  { name: 'Housing', type: 'expense', color: '#F59E0B' },
  { name: 'Entertainment', type: 'expense', color: '#EC4899' },
  { name: 'Salary', type: 'income', color: '#10B981' },
];

// Идемпотентно гарантируем существование таблицы прогресса (CREATE IF NOT EXISTS —
// дёшево и безопасно). НЕ кэшируем процессным флагом: в тестах каждый makeApp()
// создаёт свежую БД, и процессный флаг привёл бы к пропуску создания таблицы в
// новой БД и 500 в /status. Поэтому создаём всегда — операция идемпотентна.
async function ensureProgressTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS onboarding_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      step TEXT NOT NULL,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, step)
    )
  `);
}

// Подсчёт состояния БД по каждому шагу (что реально сделано пользователем).
async function computeDbState(userId) {
  const accountRow = await get(
    'SELECT COUNT(*) AS c FROM accounts WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const txRow = await get(
    'SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?',
    [userId]
  );
  const budgetRow = await get(
    'SELECT COUNT(*) AS c FROM budgets WHERE user_id = ?',
    [userId]
  );
  const goalRow = await get(
    'SELECT COUNT(*) AS c FROM savings_goals WHERE user_id = ?',
    [userId]
  );

  return {
    account: (accountRow && accountRow.c) > 0,
    transaction: (txRow && txRow.c) > 0,
    budget: (budgetRow && budgetRow.c) > 0,
    goal: (goalRow && goalRow.c) > 0,
  };
}

// Явно отмеченные шаги (completed/skipped) из onboarding_progress.
async function fetchExplicitSteps(userId) {
  await ensureProgressTable();
  const rows = await query(
    'SELECT step FROM onboarding_progress WHERE user_id = ?',
    [userId]
  );
  const set = new Set(rows.map((r) => r.step));
  return set;
}

// Собрать единый объект статуса.
async function buildStatus(userId) {
  const dbState = await computeDbState(userId);
  const explicit = await fetchExplicitSteps(userId);

  // Шаг считается завершённым, если есть данные в БД ИЛИ пользователь явно
  // отметил/пропустил шаг.
  const steps = STEPS.map((key) => {
    const done = Boolean(dbState[key]) || explicit.has(key);
    return {
      key,
      done,
      fromData: Boolean(dbState[key]),
      explicit: explicit.has(key),
    };
  });

  const completedCount = steps.filter((s) => s.done).length;
  const totalSteps = STEPS.length;

  return {
    steps,
    completed: completedCount,
    total: totalSteps,
    complete: completedCount >= totalSteps,
    // Удобный флаг для фронта: показывать ли мастер вообще.
    showWizard: completedCount < totalSteps,
  };
}

// GET /api/onboarding/status — какие шаги пройдены.
router.get('/status', async (req, res, next) => {
  try {
    const status = await buildStatus(req.user.id);
    return ok(res, status);
  } catch (error) {
    next(error);
  }
});

// POST /api/onboarding/complete-step — явно отметить шаг завершённым/пропущенным.
// body: { step: 'account'|'transaction'|'budget'|'goal' }
router.post('/complete-step', async (req, res, next) => {
  try {
    const { step } = req.body || {};
    if (!step || !STEPS.includes(step)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `step is required and must be one of: ${STEPS.join(', ')}`
      );
    }

    await ensureProgressTable();
    // Идемпотентно: повторная отметка того же шага не плодит строк.
    await run(
      'INSERT OR IGNORE INTO onboarding_progress (user_id, step) VALUES (?, ?)',
      [req.user.id, step]
    );

    const status = await buildStatus(req.user.id);
    return ok(res, status);
  } catch (error) {
    next(error);
  }
});

// POST /api/onboarding/quickstart — стартовый сидер: дефолтный счёт + категории.
// Идемпотентен: не создаёт дубликаты, если у пользователя уже есть счёт/категории.
// body (опционально): { currency, accountName }
router.post('/quickstart', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { currency, accountName } = req.body || {};
    const accCurrency = typeof currency === 'string' && currency.trim()
      ? currency.trim().toUpperCase()
      : DEFAULT_CURRENCY;
    const accName = typeof accountName === 'string' && accountName.trim()
      ? accountName.trim()
      : 'Main account';

    // Счёт создаём только если у пользователя ещё нет активных счетов.
    const existingAccount = await get(
      'SELECT id FROM accounts WHERE user_id = ? AND is_active = 1 LIMIT 1',
      [userId]
    );

    let accountId = existingAccount && existingAccount.id;
    let accountCreated = false;
    if (!accountId) {
      const result = await run(
        `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active)
         VALUES (?, ?, ?, 0, 'cash', 1)`,
        [userId, accName, accCurrency]
      );
      accountId = result.id;
      accountCreated = true;
    }

    // Категории: вставляем только отсутствующие (UNIQUE(user_id, name) защищает
    // от дублей, но мы дополнительно используем INSERT OR IGNORE).
    let categoriesCreated = 0;
    for (const cat of DEFAULT_CATEGORIES) {
      const r = await run(
        `INSERT OR IGNORE INTO categories (user_id, name, type, color)
         VALUES (?, ?, ?, ?)`,
        [userId, cat.name, cat.type, cat.color]
      );
      if (r.changes > 0) categoriesCreated += 1;
    }

    const status = await buildStatus(userId);

    return ok(
      res,
      {
        accountId,
        accountCreated,
        categoriesCreated,
        status,
      },
      201
    );
  } catch (error) {
    next(error);
  }
});

// ==================== FIRST RUN (22.11) ====================
// The empty dashboard offers three starts: import a statement, explore demo
// data, start from scratch. These endpoints back it.

const demoStarter = require('../lib/demoStarter');
const { normalize: normalizeMerchant, median, classifyFrequency } = require('../services/subscriptionDetector');
const moneyLib = require('../lib/money');

// GET /api/onboarding/state — what the first screen needs in one call.
router.get('/state', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const acc = await get(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN is_demo = 1 THEN 1 ELSE 0 END) AS demo
         FROM accounts WHERE user_id = ? AND is_active = 1`, [userId]);
    const tx = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN a.is_demo = 1 THEN 1 ELSE 0 END) AS demo
         FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ? AND t.type IN ('income','expense')`, [userId]);
    const user = await get('SELECT email_verified_at, google_id FROM users WHERE id = ?', [userId]);
    const accounts = Number(acc && acc.total) || 0;
    const demoAccounts = Number(acc && acc.demo) || 0;
    const transactions = Number(tx && tx.total) || 0;
    const demoTransactions = Number(tx && tx.demo) || 0;
    return ok(res, {
      accounts,
      demoAccounts,
      transactions,
      demoTransactions,
      ownTransactions: transactions - demoTransactions,
      demo: demoAccounts > 0,
      // No own data yet: the dashboard shows the start panel instead of $0.
      firstRun: transactions - demoTransactions === 0 && demoAccounts === 0,
      emailVerified: Boolean(user && user.email_verified_at),
      google: Boolean(user && user.google_id),
    });
  } catch (err) { next(err); }
});

// POST /api/onboarding/demo — load the tagged demo household. body: { currency }
router.post('/demo', async (req, res, next) => {
  try {
    const { currency } = req.body || {};
    const cur = typeof currency === 'string' ? currency.trim().toUpperCase() : DEFAULT_CURRENCY;
    const result = await demoStarter.loadDemo(req.user.id, { currency: cur || DEFAULT_CURRENCY });
    return ok(res, result, result.created ? 201 : 200);
  } catch (err) { next(err); }
});

// DELETE /api/onboarding/demo — remove every demo account and its rows.
router.delete('/demo', async (req, res, next) => {
  try {
    return ok(res, await demoStarter.removeDemo(req.user.id));
  } catch (err) { next(err); }
});

// GET /api/onboarding/insight?accountId=&since= — "what we found" after an import:
// period, income vs spending, top categories, recurring charges, biggest expenses.
// Without accountId: all own (non-demo) accounts; ?demo=1 reads the demo set.
router.get('/insight', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const params = [userId];
    let where = `t.user_id = ? AND t.type IN ('income','expense') AND a.is_active = 1`;
    if (req.query.accountId) {
      const accId = parseInt(req.query.accountId, 10);
      if (!Number.isInteger(accId)) throw new AppError(400, 'VALIDATION_ERROR', 'accountId must be a number');
      where += ' AND t.account_id = ?';
      params.push(accId);
    } else {
      where += req.query.demo === '1' ? ' AND a.is_demo = 1' : ' AND COALESCE(a.is_demo, 0) = 0';
    }
    const rows = await query(
      `SELECT t.date, t.description, t.category, t.amount, t.type, a.currency, a.name AS account
         FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.user_id = t.user_id
        WHERE ${where}
        ORDER BY t.date ASC`, params);

    if (!rows.length) {
      return ok(res, { count: 0 });
    }

    // Main currency = the one most rows are in; totals only in that currency
    // (no cross-currency sums without a rate).
    const byCur = new Map();
    rows.forEach((r) => byCur.set(r.currency || DEFAULT_CURRENCY, (byCur.get(r.currency || DEFAULT_CURRENCY) || 0) + 1));
    const currency = [...byCur.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const main = rows.filter((r) => (r.currency || DEFAULT_CURRENCY) === currency);

    const from = rows[0].date;
    const to = rows[rows.length - 1].date;
    const days = Math.max(1, Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1);
    const months = Math.max(1, days / 30.44);

    let income = 0;
    let expense = 0;
    const cats = new Map();
    const isTransfer = (r) => /^(transfer|transfers)$/i.test(String(r.category || ''));
    for (const r of main) {
      const amt = Math.abs(Number(r.amount) || 0);
      if (isTransfer(r)) continue;
      if (r.type === 'income') income = moneyLib.add(income, amt);
      else {
        expense = moneyLib.add(expense, amt);
        const name = (r.category && String(r.category).trim()) || 'Other';
        const c = cats.get(name) || { name, total: 0, count: 0 };
        c.total = moneyLib.add(c.total, amt);
        c.count += 1;
        cats.set(name, c);
      }
    }
    const categories = [...cats.values()].sort((a, b) => b.total - a.total);
    const topCategories = categories.slice(0, 5).map((c) => ({
      ...c,
      share: expense > 0 ? Math.round((c.total / expense) * 1000) / 10 : 0,
      monthly: moneyLib.round(c.total / months),
    }));
    const other = cats.get('Other');
    const uncategorizedShare = expense > 0 && other ? Math.round((other.total / expense) * 1000) / 10 : 0;

    // Recurring charges inside this set (same merchant, stable amount, regular gap).
    const groups = new Map();
    for (const r of main) {
      if (r.type !== 'expense' || isTransfer(r)) continue;
      const key = normalizeMerchant(r.description);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const recurring = [];
    const recurringKeys = new Set();
    for (const [key, items] of groups) {
      if (items.length < 2) continue;
      const amounts = items.map((i) => Math.abs(Number(i.amount) || 0));
      const med = median(amounts);
      // Two hits are a coincidence unless the amount is the same to the cent-ish;
      // three or more may drift ±20% (utility bills).
      const tol = items.length >= 3 ? 0.2 : 0.01;
      if (med <= 0 || !amounts.every((a) => Math.abs(a - med) <= med * tol)) continue;
      const ds = items.map((i) => new Date(`${i.date}T00:00:00Z`)).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < ds.length; i++) gaps.push(Math.round((ds[i] - ds[i - 1]) / 86400000));
      const g = median(gaps);
      const freq = classifyFrequency(g);
      if (!freq || !gaps.every((x) => x >= g * 0.65 && x <= g * 1.35)) continue;
      recurringKeys.add(key);
      recurring.push({
        name: items[items.length - 1].description,
        amount: moneyLib.round(med),
        cycle: freq.cycle,
        monthly: moneyLib.round(med * freq.perMonth),
        category: items[items.length - 1].category || null,
        lastDate: items[items.length - 1].date,
      });
    }
    recurring.sort((a, b) => b.monthly - a.monthly);

    // One-off purchases: rent and other repeating bills are already listed above.
    const biggest = main
      .filter((r) => r.type === 'expense' && !isTransfer(r) && !recurringKeys.has(normalizeMerchant(r.description)))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 3)
      .map((r) => ({ date: r.date, description: r.description, amount: Math.abs(Number(r.amount) || 0), category: r.category || 'Other' }));

    return ok(res, {
      count: rows.length,
      from,
      to,
      days,
      currency,
      otherCurrencies: [...byCur.keys()].filter((c) => c !== currency),
      income,
      expense,
      net: moneyLib.round(income - expense),
      monthlyIncome: moneyLib.round(income / months),
      monthlyExpense: moneyLib.round(expense / months),
      categoryCount: categories.length,
      topCategories,
      uncategorizedShare,
      recurring: recurring.slice(0, 8),
      recurringMonthly: moneyLib.sum(recurring.map((r) => r.monthly)),
      biggest,
    });
  } catch (err) { next(err); }
});

module.exports = router;
