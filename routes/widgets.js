// ==================== МАРШРУТЫ ВИДЖЕТОВ ДАШБОРДА ====================
// Wave-2 stream "widgets-dashboard".
//
// CRUD по dashboard_widgets + reorder + дефолтный набор виджетов при первом
// заходе. Все запросы скоупятся по req.user.id (паттерн requireOwnership:
// 404, если виджет принадлежит другому пользователю или не существует).
//
// Совместимость по контракту: ответы списков/данных виджетов остаются "сырым"
// JSON (как в wave-1 фронтенде public/js/dashboard.js), а мутации (POST/PUT/
// DELETE/reorder) возвращают единый { success:true, data } через lib/respond.

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');
const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Допустимые размеры виджетов.
const VALID_SIZES = ['small', 'medium', 'large'];

// Дефолтный набор виджетов, который сеется при первом заходе пользователя.
const DEFAULT_WIDGETS = [
  { type: 'networth', title: 'Net Worth', position: 0, size: 'medium' },
  { type: 'cashflow', title: 'Денежный поток', position: 1, size: 'medium' },
  { type: 'budget', title: 'Бюджеты', position: 2, size: 'medium' },
  { type: 'goals', title: 'Цели', position: 3, size: 'medium' },
  { type: 'upcoming', title: 'Предстоящие платежи', position: 4, size: 'medium' },
  { type: 'top_categories', title: 'Топ категорий', position: 5, size: 'medium' }
];

// Каталог доступных виджетов (тип -> метаданные).
const AVAILABLE_WIDGETS = [
  { type: 'balance', name: 'Общий баланс', description: 'Сумма всех счетов', sizes: ['small', 'medium'] },
  { type: 'networth', name: 'Net Worth', description: 'Чистая стоимость', sizes: ['small', 'medium'] },
  { type: 'cashflow', name: 'Денежный поток', description: 'Доходы минус расходы за период', sizes: ['small', 'medium', 'large'] },
  { type: 'budget', name: 'Бюджеты', description: 'Статус бюджетов', sizes: ['medium', 'large'] },
  { type: 'expenses', name: 'Расходы', description: 'Расходы за период', sizes: ['small', 'medium', 'large'] },
  { type: 'income', name: 'Доходы', description: 'Доходы за период', sizes: ['small', 'medium'] },
  { type: 'goals', name: 'Цели', description: 'Прогресс целей', sizes: ['medium', 'large'] },
  { type: 'upcoming', name: 'Предстоящие платежи', description: 'Ближайшие платежи', sizes: ['medium', 'large'] },
  { type: 'top_categories', name: 'Топ категорий', description: 'Крупнейшие категории расходов', sizes: ['medium', 'large'] },
  { type: 'subscriptions', name: 'Подписки', description: 'Активные подписки', sizes: ['small', 'medium'] },
  { type: 'investments', name: 'Инвестиции', description: 'Портфель', sizes: ['medium', 'large'] },
  { type: 'debts', name: 'Долги', description: 'Текущие долги', sizes: ['small', 'medium'] },
  { type: 'chart_expenses', name: 'График расходов', description: 'Динамика расходов', sizes: ['large'] },
  { type: 'chart_balance', name: 'График баланса', description: 'Динамика баланса', sizes: ['large'] },
  { type: 'recent', name: 'Последние операции', description: 'Недавние транзакции', sizes: ['medium', 'large'] },
  { type: 'quick_add', name: 'Быстрый ввод', description: 'Добавить транзакцию', sizes: ['small'] }
];

const KNOWN_TYPES = new Set(AVAILABLE_WIDGETS.map((w) => w.type));

// Загрузить виджет, принадлежащий пользователю (паттерн requireOwnership).
async function loadOwnedWidget(id, userId) {
  return get('SELECT * FROM dashboard_widgets WHERE id = ? AND user_id = ?', [id, userId]);
}

// Сериализация строки виджета для ответа (settings -> объект).
function serializeWidget(w) {
  let settings = {};
  try {
    settings = JSON.parse(w.settings || '{}');
  } catch (e) {
    settings = {};
  }
  return { ...w, settings };
}

// Засеять дефолтный набор виджетов для пользователя.
async function seedDefaults(userId) {
  for (const w of DEFAULT_WIDGETS) {
    await run(
      'INSERT INTO dashboard_widgets (user_id, widget_type, title, position, size) VALUES (?, ?, ?, ?, ?)',
      [userId, w.type, w.title, w.position, w.size]
    );
  }
}

// ==================== СПИСОК / КАТАЛОГ ====================

// Доступные виджеты (каталог).
router.get('/available', (req, res) => {
  res.json(AVAILABLE_WIDGETS);
});

// Виджеты пользователя (с авто-сидом дефолтов при первом заходе).
router.get('/', async (req, res, next) => {
  try {
    let widgets = await query(
      'SELECT * FROM dashboard_widgets WHERE user_id = ? ORDER BY position, id',
      [req.user.id]
    );

    if (widgets.length === 0) {
      await seedDefaults(req.user.id);
      widgets = await query(
        'SELECT * FROM dashboard_widgets WHERE user_id = ? ORDER BY position, id',
        [req.user.id]
      );
    }

    res.json(widgets.map(serializeWidget));
  } catch (error) {
    next(error);
  }
});

// ==================== ДАННЫЕ ВИДЖЕТА ====================

router.get('/:type/data', async (req, res, next) => {
  try {
    const { type } = req.params;
    const { period = 'month' } = req.query;

    let data;
    switch (type) {
      case 'balance':
        data = await getBalanceData(req.user.id);
        break;
      case 'networth':
        data = await getNetWorthData(req.user.id);
        break;
      case 'cashflow':
        data = await getCashflowData(req.user.id, period);
        break;
      case 'budget':
        data = await getBudgetData(req.user.id);
        break;
      case 'expenses':
        data = await getExpensesData(req.user.id, period);
        break;
      case 'income':
        data = await getIncomeData(req.user.id, period);
        break;
      case 'goals':
        data = await getGoalsData(req.user.id);
        break;
      case 'upcoming':
        data = await getUpcomingData(req.user.id);
        break;
      case 'top_categories':
        data = await getTopCategoriesData(req.user.id, period);
        break;
      case 'subscriptions':
        data = await getSubscriptionsData(req.user.id);
        break;
      case 'investments':
        data = await getInvestmentsData(req.user.id);
        break;
      case 'debts':
        data = await getDebtsData(req.user.id);
        break;
      case 'recent':
        data = await getRecentData(req.user.id);
        break;
      case 'chart_expenses':
        data = await getChartExpensesData(req.user.id);
        break;
      case 'chart_balance':
        data = await getChartBalanceData(req.user.id);
        break;
      default:
        throw new AppError(400, 'UNKNOWN_WIDGET_TYPE', 'Неизвестный тип виджета');
    }

    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ==================== CRUD ====================

// Добавить виджет.
router.post('/', async (req, res, next) => {
  try {
    const { widget_type, title, size, settings } = req.body || {};

    if (!widget_type || typeof widget_type !== 'string') {
      throw new AppError(400, 'VALIDATION', 'widget_type обязателен');
    }
    if (!KNOWN_TYPES.has(widget_type)) {
      throw new AppError(400, 'UNKNOWN_WIDGET_TYPE', 'Неизвестный тип виджета');
    }
    const finalSize = size || 'medium';
    if (!VALID_SIZES.includes(finalSize)) {
      throw new AppError(400, 'VALIDATION', 'Недопустимый размер виджета');
    }

    const maxPos = await get(
      'SELECT MAX(position) as max FROM dashboard_widgets WHERE user_id = ?',
      [req.user.id]
    );
    const nextPos = (maxPos && maxPos.max != null) ? maxPos.max + 1 : 0;

    const result = await run(
      'INSERT INTO dashboard_widgets (user_id, widget_type, title, position, size, settings) VALUES (?, ?, ?, ?, ?, ?)',
      [
        req.user.id,
        widget_type,
        title || null,
        nextPos,
        finalSize,
        JSON.stringify(settings || {})
      ]
    );

    const created = await get('SELECT * FROM dashboard_widgets WHERE id = ?', [result.id]);
    return ok(res, serializeWidget(created), 201);
  } catch (error) {
    next(error);
  }
});

// Обновить виджет (title/size/settings/is_visible) — скоуп по владельцу.
router.put('/:id', async (req, res, next) => {
  try {
    const widget = await loadOwnedWidget(req.params.id, req.user.id);
    if (!widget) {
      throw new AppError(404, 'NOT_FOUND', 'Виджет не найден');
    }

    const { title, size, settings, is_visible } = req.body || {};

    let finalSize = widget.size;
    if (size !== undefined) {
      if (!VALID_SIZES.includes(size)) {
        throw new AppError(400, 'VALIDATION', 'Недопустимый размер виджета');
      }
      finalSize = size;
    }

    const finalTitle = title !== undefined ? title : widget.title;
    const finalSettings = settings !== undefined
      ? JSON.stringify(settings || {})
      : (widget.settings || '{}');
    const finalVisible = is_visible !== undefined
      ? (is_visible ? 1 : 0)
      : widget.is_visible;

    await run(
      'UPDATE dashboard_widgets SET title = ?, size = ?, settings = ?, is_visible = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [finalTitle, finalSize, finalSettings, finalVisible, req.params.id, req.user.id]
    );

    const updated = await get('SELECT * FROM dashboard_widgets WHERE id = ?', [req.params.id]);
    return ok(res, serializeWidget(updated));
  } catch (error) {
    next(error);
  }
});

// Показать/скрыть виджет (удобный шорткат).
router.patch('/:id/visibility', async (req, res, next) => {
  try {
    const widget = await loadOwnedWidget(req.params.id, req.user.id);
    if (!widget) {
      throw new AppError(404, 'NOT_FOUND', 'Виджет не найден');
    }
    const { is_visible } = req.body || {};
    const visible = is_visible ? 1 : 0;
    await run(
      'UPDATE dashboard_widgets SET is_visible = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [visible, req.params.id, req.user.id]
    );
    const updated = await get('SELECT * FROM dashboard_widgets WHERE id = ?', [req.params.id]);
    return ok(res, serializeWidget(updated));
  } catch (error) {
    next(error);
  }
});

// Изменить порядок виджетов.
// Принимает ЛИБО упорядоченный список id: { order: [3, 1, 2] }
// (позиция = индекс в массиве), ЛИБО пары { order: [{id, position}, ...] }
// для обратной совместимости с wave-1 фронтендом.
router.post('/reorder', async (req, res, next) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) {
      throw new AppError(400, 'VALIDATION', 'order должен быть массивом');
    }

    // Нормализуем оба формата к [{ id, position }].
    const pairs = order.map((item, index) => {
      if (item && typeof item === 'object') {
        return { id: item.id, position: item.position != null ? item.position : index };
      }
      // примитив (id) -> позиция = индекс в массиве
      return { id: item, position: index };
    });

    // Валидация: все id принадлежат пользователю.
    const owned = await query(
      'SELECT id FROM dashboard_widgets WHERE user_id = ?',
      [req.user.id]
    );
    const ownedIds = new Set(owned.map((r) => Number(r.id)));
    for (const p of pairs) {
      if (p.id == null || !ownedIds.has(Number(p.id))) {
        throw new AppError(404, 'NOT_FOUND', `Виджет ${p.id} не найден`);
      }
    }

    for (const p of pairs) {
      await run(
        'UPDATE dashboard_widgets SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [p.position, p.id, req.user.id]
      );
    }

    const widgets = await query(
      'SELECT * FROM dashboard_widgets WHERE user_id = ? ORDER BY position, id',
      [req.user.id]
    );
    return ok(res, { widgets: widgets.map(serializeWidget) });
  } catch (error) {
    next(error);
  }
});

// Удалить виджет — скоуп по владельцу.
router.delete('/:id', async (req, res, next) => {
  try {
    const widget = await loadOwnedWidget(req.params.id, req.user.id);
    if (!widget) {
      throw new AppError(404, 'NOT_FOUND', 'Виджет не найден');
    }
    await run('DELETE FROM dashboard_widgets WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id
    ]);
    return ok(res, { id: Number(req.params.id), deleted: true });
  } catch (error) {
    next(error);
  }
});

// ==================== ФУНКЦИИ ДАННЫХ ВИДЖЕТОВ ====================

function monthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
}

function periodStart(period) {
  const now = new Date();
  if (period === 'year') {
    return new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
  }
  if (period === 'week') {
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  }
  return monthStart();
}

async function getBalanceData(userId) {
  const result = await get('SELECT SUM(balance) as total FROM accounts WHERE user_id = ?', [userId]);
  return { total: (result && result.total) || 0 };
}

async function getNetWorthData(userId) {
  const accounts = await get('SELECT SUM(balance) as total FROM accounts WHERE user_id = ?', [userId]);
  const debts = await get(
    `SELECT SUM(amount - paid_amount) as total FROM debts WHERE user_id = ? AND is_active = 1 AND type IN ('i_owe', 'credit', 'loan')`,
    [userId]
  );
  const assets = await get(
    'SELECT SUM(value) as total FROM manual_assets WHERE user_id = ? AND is_active = 1',
    [userId]
  );

  const accountsTotal = (accounts && accounts.total) || 0;
  const assetsTotal = (assets && assets.total) || 0;
  const liabilities = (debts && debts.total) || 0;
  const netWorth = accountsTotal + assetsTotal - liabilities;
  return { netWorth, assets: accountsTotal + assetsTotal, liabilities };
}

async function getCashflowData(userId, period) {
  const start = periodStart(period);
  const income = await get(
    `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'income' AND date >= ?`,
    [userId, start]
  );
  const expense = await get(
    `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ?`,
    [userId, start]
  );
  const incomeTotal = (income && income.total) || 0;
  const expenseTotal = (expense && expense.total) || 0;
  return {
    income: incomeTotal,
    expense: expenseTotal,
    net: incomeTotal - expenseTotal,
    period
  };
}

async function getBudgetData(userId) {
  const budgets = await query(
    'SELECT * FROM budgets WHERE user_id = ? AND is_active = 1 LIMIT 5',
    [userId]
  );
  return { budgets, count: budgets.length };
}

async function getExpensesData(userId, period) {
  const start = periodStart(period);
  const result = await get(
    `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ?`,
    [userId, start]
  );
  return { total: (result && result.total) || 0, period };
}

async function getIncomeData(userId, period) {
  const start = periodStart(period);
  const result = await get(
    `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'income' AND date >= ?`,
    [userId, start]
  );
  return { total: (result && result.total) || 0, period };
}

async function getGoalsData(userId) {
  const goals = await query(
    'SELECT * FROM savings_goals WHERE user_id = ? AND is_active = 1 AND is_completed = 0 LIMIT 5',
    [userId]
  );
  return {
    goals: goals.map((g) => ({
      ...g,
      progress: g.target_amount > 0 ? (g.current_amount / g.target_amount) * 100 : 0
    }))
  };
}

async function getUpcomingData(userId) {
  const today = new Date().toISOString().split('T')[0];
  const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // ВАЖНО: колонка recurring_payments — next_payment_date (а не *_execution_date).
  const recurring = await query(
    `SELECT name as title, amount, next_payment_date as date FROM recurring_payments
     WHERE user_id = ? AND is_active = 1 AND next_payment_date >= ? AND next_payment_date <= ? LIMIT 5`,
    [userId, today, weekLater]
  );
  const subscriptions = await query(
    `SELECT name as title, amount, next_billing_date as date FROM subscriptions
     WHERE user_id = ? AND is_active = 1 AND next_billing_date IS NOT NULL
       AND next_billing_date >= ? AND next_billing_date <= ? LIMIT 5`,
    [userId, today, weekLater]
  );

  const items = [...recurring, ...subscriptions]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 5);
  return { items };
}

async function getTopCategoriesData(userId, period) {
  const start = periodStart(period);
  const rows = await query(
    `SELECT COALESCE(category, 'Без категории') as category, SUM(amount) as total, COUNT(*) as count
     FROM transactions
     WHERE user_id = ? AND type = 'expense' AND date >= ?
     GROUP BY category
     ORDER BY total DESC
     LIMIT 5`,
    [userId, start]
  );
  const grand = rows.reduce((s, r) => s + (r.total || 0), 0);
  return {
    period,
    total: grand,
    categories: rows.map((r) => ({
      category: r.category,
      total: r.total || 0,
      count: r.count,
      percent: grand > 0 ? Math.round(((r.total || 0) / grand) * 100) : 0
    }))
  };
}

async function getSubscriptionsData(userId) {
  const subs = await query(
    'SELECT * FROM subscriptions WHERE user_id = ? AND is_active = 1 LIMIT 5',
    [userId]
  );
  const monthlyTotal = subs.reduce((s, sub) => {
    if (sub.billing_cycle === 'monthly') return s + sub.amount;
    if (sub.billing_cycle === 'yearly') return s + sub.amount / 12;
    return s + sub.amount;
  }, 0);
  return { subscriptions: subs, monthlyTotal };
}

async function getInvestmentsData(userId) {
  const portfolios = await query(
    'SELECT * FROM investment_portfolios WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  let totalValue = 0;
  for (const p of portfolios) {
    const val = await get(
      'SELECT SUM(quantity * COALESCE(current_price, buy_price)) as total FROM investments WHERE portfolio_id = ? AND is_active = 1',
      [p.id]
    );
    totalValue += (val && val.total) || 0;
  }
  return { portfolioCount: portfolios.length, totalValue };
}

async function getDebtsData(userId) {
  const debts = await query(
    `SELECT * FROM debts WHERE user_id = ? AND is_active = 1 AND is_paid = 0 LIMIT 5`,
    [userId]
  );
  const totalOwed = debts.reduce((s, d) => s + (d.amount - d.paid_amount), 0);
  return { debts, totalOwed };
}

async function getRecentData(userId) {
  const transactions = await query(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 10',
    [userId]
  );
  return { transactions };
}

async function getChartExpensesData(userId) {
  const data = [];
  for (let i = 5; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    const start = new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0];

    const result = await get(
      `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`,
      [userId, start, end]
    );
    data.push({ month: start.substring(0, 7), amount: (result && result.total) || 0 });
  }
  return { data };
}

async function getChartBalanceData(userId) {
  const snapshots = await query(
    'SELECT snapshot_date as date, net_worth as value FROM networth_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 12',
    [userId]
  );
  return { data: snapshots.reverse() };
}

module.exports = router;
