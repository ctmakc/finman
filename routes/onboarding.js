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
const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');

// ВНИМАНИЕ: аутентификация (apiAuth) монтируется на уровне server.js Интегратором
// (см. integration_notes). На случай прямого монтирования без внешнего apiAuth
// роут безопасно работает: все запросы используют req.user.id, который заполняет
// passport-jwt. Если req.user отсутствует — отдаём 401.
router.use((req, res, next) => {
  if (!req.user || !req.user.id) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Требуется аутентификация'));
  }
  next();
});

// Канонический список шагов онбординга (порядок = порядок мастера).
const STEPS = ['account', 'transaction', 'budget', 'goal'];

// Дефолтные категории для стартового сидера (тип + цвет в стиле приложения).
const DEFAULT_CATEGORIES = [
  { name: 'Продукты', type: 'expense', color: '#5D5CDE' },
  { name: 'Транспорт', type: 'expense', color: '#22C55E' },
  { name: 'Жильё', type: 'expense', color: '#F59E0B' },
  { name: 'Развлечения', type: 'expense', color: '#EC4899' },
  { name: 'Зарплата', type: 'income', color: '#10B981' },
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
        `step обязателен и должен быть одним из: ${STEPS.join(', ')}`
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
      : 'UAH';
    const accName = typeof accountName === 'string' && accountName.trim()
      ? accountName.trim()
      : 'Основной счёт';

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

module.exports = router;
