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
const dates = require('../lib/dates');
const { cashflowOnly } = require('../lib/txFilter');
const networthService = require('../services/networthService');
const fx = require('../lib/fx');
const money = require('../lib/money');
const { AppError } = require('../middleware/error');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Допустимые размеры виджетов.
const VALID_SIZES = ['small', 'medium', 'large'];

// Дефолтный набор виджетов, который сеется при первом заходе пользователя.
const DEFAULT_WIDGETS = [
  { type: 'networth', title: 'Net Worth', position: 0, size: 'medium' },
  { type: 'cashflow', title: 'Cash flow', position: 1, size: 'medium' },
  { type: 'budget', title: 'Budgets', position: 2, size: 'medium' },
  { type: 'goals', title: 'Goals', position: 3, size: 'medium' },
  { type: 'upcoming', title: 'Upcoming payments', position: 4, size: 'medium' },
  { type: 'top_categories', title: 'Top categories', position: 5, size: 'medium' }
];

// Каталог доступных виджетов (тип -> метаданные).
const AVAILABLE_WIDGETS = [
  { type: 'balance', name: 'Total balance', description: 'Sum of all accounts', sizes: ['small', 'medium'] },
  { type: 'networth', name: 'Net Worth', description: 'Net worth', sizes: ['small', 'medium'] },
  { type: 'cashflow', name: 'Cash flow', description: 'Income minus expenses for the period', sizes: ['small', 'medium', 'large'] },
  { type: 'budget', name: 'Budgets', description: 'Budget status', sizes: ['medium', 'large'] },
  { type: 'expenses', name: 'Expenses', description: 'Expenses for the period', sizes: ['small', 'medium', 'large'] },
  { type: 'income', name: 'Income', description: 'Income for the period', sizes: ['small', 'medium'] },
  { type: 'goals', name: 'Goals', description: 'Goal progress', sizes: ['medium', 'large'] },
  { type: 'upcoming', name: 'Upcoming payments', description: 'Next payments', sizes: ['medium', 'large'] },
  { type: 'top_categories', name: 'Top categories', description: 'Largest expense categories', sizes: ['medium', 'large'] },
  { type: 'subscriptions', name: 'Subscriptions', description: 'Active subscriptions', sizes: ['small', 'medium'] },
  { type: 'investments', name: 'Investments', description: 'Portfolio', sizes: ['medium', 'large'] },
  { type: 'debts', name: 'Debts', description: 'Current debts', sizes: ['small', 'medium'] },
  { type: 'chart_expenses', name: 'Expense chart', description: 'Expenses over time', sizes: ['large'] },
  { type: 'chart_balance', name: 'Balance chart', description: 'Balance over time', sizes: ['large'] },
  { type: 'recent', name: 'Recent activity', description: 'Recent transactions', sizes: ['medium', 'large'] },
  { type: 'quick_add', name: 'Quick add', description: 'Add a transaction', sizes: ['small'] }
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
        data = await getCashflowData(req.user.id, period, dates.userTz(req.user));
        break;
      case 'budget':
        data = await getBudgetData(req.user.id);
        break;
      case 'expenses':
        data = await getExpensesData(req.user.id, period, dates.userTz(req.user));
        break;
      case 'income':
        data = await getIncomeData(req.user.id, period, dates.userTz(req.user));
        break;
      case 'goals':
        data = await getGoalsData(req.user.id);
        break;
      case 'upcoming':
        data = await getUpcomingData(req.user.id, dates.userTz(req.user));
        break;
      case 'top_categories':
        data = await getTopCategoriesData(req.user.id, period, dates.userTz(req.user));
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
        data = await getChartExpensesData(req.user.id, dates.userTz(req.user));
        break;
      case 'chart_balance':
        data = await getChartBalanceData(req.user.id);
        break;
      default:
        throw new AppError(400, 'UNKNOWN_WIDGET_TYPE', 'Unknown widget type');
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
      throw new AppError(400, 'VALIDATION', 'widget_type is required');
    }
    if (!KNOWN_TYPES.has(widget_type)) {
      throw new AppError(400, 'UNKNOWN_WIDGET_TYPE', 'Unknown widget type');
    }
    const finalSize = size || 'medium';
    if (!VALID_SIZES.includes(finalSize)) {
      throw new AppError(400, 'VALIDATION', 'Invalid widget size');
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
      throw new AppError(404, 'NOT_FOUND', 'Widget not found');
    }

    const { title, size, settings, is_visible } = req.body || {};

    let finalSize = widget.size;
    if (size !== undefined) {
      if (!VALID_SIZES.includes(size)) {
        throw new AppError(400, 'VALIDATION', 'Invalid widget size');
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
      throw new AppError(404, 'NOT_FOUND', 'Widget not found');
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
      throw new AppError(400, 'VALIDATION', 'order must be an array');
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
        throw new AppError(404, 'NOT_FOUND', `Widget ${p.id} not found`);
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
      throw new AppError(404, 'NOT_FOUND', 'Widget not found');
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

// Границы периодов — в часовом поясе пользователя (tz), не в UTC.
function monthStart(tz) {
  return dates.startOfMonthISO(dates.todayISO(tz));
}

function periodStart(period, tz) {
  const today = dates.todayISO(tz);
  if (period === 'year') {
    return `${today.slice(0, 4)}-01-01`;
  }
  if (period === 'week') {
    return dates.addDaysISO(today, -7);
  }
  return monthStart(tz);
}

// Единый фильтр денежного потока: без переводов и начального баланса.
const CFT = cashflowOnly('t');

// Balance and net worth are reported in the user's base currency
// (networthService converts each account/asset/debt via the FX service;
// a missing rate falls back to 1:1 and is listed in missingRates).
async function getBalanceData(userId) {
  const sum = await networthService.sumAccountsInBase(userId);
  return {
    total: sum.total,
    currency: sum.baseCurrency,
    baseCurrency: sum.baseCurrency,
    missingRates: sum.missingRates,
  };
}

async function getNetWorthData(userId) {
  const nw = await networthService.computeNetWorth(userId);
  return {
    netWorth: nw.netWorth,
    assets: nw.totalAssets,
    liabilities: nw.totalLiabilities,
    currency: nw.baseCurrency,
    baseCurrency: nw.baseCurrency,
    missingRates: nw.missingRates,
  };
}

// Income / expense since `start`, converted per account currency into the
// user's base currency (lib/fx).
async function cashflowTotals(userId, start, end = null) {
  const conv = await fx.converterForUser(userId);
  const params = [userId, start];
  let endSql = '';
  if (end) {
    endSql = ' AND t.date <= ?';
    params.push(end);
  }
  const rows = await query(
    `SELECT a.currency AS currency,
            SUM(CASE WHEN t.type = 'income' THEN ABS(t.amount) ELSE 0 END) AS income,
            SUM(CASE WHEN t.type = 'expense' THEN ABS(t.amount) ELSE 0 END) AS expense
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.date >= ?${endSql}${CFT.sql}
     GROUP BY a.currency`,
    [...params, ...CFT.params]
  );
  const tot = await conv.totals(rows, ['income', 'expense']);
  return {
    income: tot.income || 0,
    expense: tot.expense || 0,
    currency: conv.baseCurrency,
    missingRates: conv.missingRates
  };
}

async function getCashflowData(userId, period, tz) {
  const start = periodStart(period, tz);
  const tot = await cashflowTotals(userId, start);
  return {
    income: tot.income,
    expense: tot.expense,
    net: money.sub(tot.income, tot.expense),
    currency: tot.currency,
    baseCurrency: tot.currency,
    missingRates: tot.missingRates,
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

async function getExpensesData(userId, period, tz) {
  const tot = await cashflowTotals(userId, periodStart(period, tz));
  return { total: tot.expense, currency: tot.currency, baseCurrency: tot.currency, missingRates: tot.missingRates, period };
}

async function getIncomeData(userId, period, tz) {
  const tot = await cashflowTotals(userId, periodStart(period, tz));
  return { total: tot.income, currency: tot.currency, baseCurrency: tot.currency, missingRates: tot.missingRates, period };
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

async function getUpcomingData(userId, tz) {
  const today = dates.todayISO(tz);
  const weekLater = dates.addDaysISO(today, 7);

  // ВАЖНО: колонка recurring_payments — next_payment_date (а не *_execution_date).
  const recurring = await query(
    `SELECT rp.name as title, rp.amount, a.currency AS currency, rp.next_payment_date as date
     FROM recurring_payments rp
     LEFT JOIN accounts a ON a.id = rp.account_id
     WHERE rp.user_id = ? AND rp.is_active = 1 AND rp.next_payment_date >= ? AND rp.next_payment_date <= ? LIMIT 5`,
    [userId, today, weekLater]
  );
  const subscriptions = await query(
    `SELECT name as title, amount, currency, next_billing_date as date FROM subscriptions
     WHERE user_id = ? AND is_active = 1 AND next_billing_date IS NOT NULL
       AND next_billing_date >= ? AND next_billing_date <= ? LIMIT 5`,
    [userId, today, weekLater]
  );

  const items = [...recurring, ...subscriptions]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(0, 5);
  return { items };
}

async function getTopCategoriesData(userId, period, tz) {
  const start = periodStart(period, tz);
  const conv = await fx.converterForUser(userId);
  const rows = await query(
    `SELECT COALESCE(t.category, 'Uncategorized') as category, a.currency AS currency,
            SUM(ABS(t.amount)) as total, COUNT(*) as count
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.type = 'expense' AND t.date >= ?${CFT.sql}
     GROUP BY COALESCE(t.category, 'Uncategorized'), a.currency`,
    [userId, start, ...CFT.params]
  );
  const merged = (await conv.regroup(rows, { keys: ['category'], amounts: ['total'], counts: ['count'] }))
    .sort((x, y) => y.total - x.total)
    .slice(0, 5);
  const grand = money.sum(merged.map((r) => r.total || 0));
  return {
    period,
    total: grand,
    currency: conv.baseCurrency,
    baseCurrency: conv.baseCurrency,
    missingRates: conv.missingRates,
    categories: merged.map((r) => ({
      category: r.category,
      total: r.total || 0,
      count: r.count,
      percent: grand > 0 ? Math.round(((r.total || 0) / grand) * 100) : 0
    }))
  };
}

// Monthly equivalent of one charge per billing frequency (weekly is 52/12,
// not 1; quarterly is 1/3).
const MONTHLY_FACTOR = {
  daily: 365 / 12,
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
  annual: 1 / 12
};

function monthlyEquivalent(amount, cycle) {
  const factor = MONTHLY_FACTOR[cycle] !== undefined ? MONTHLY_FACTOR[cycle] : 1;
  return (Number(amount) || 0) * factor;
}

// Список — первые 5 подписок; monthlyTotal — по ВСЕМ активным подпискам,
// каждая приведена к месяцу по своей периодичности и к базовой валюте.
async function getSubscriptionsData(userId) {
  const conv = await fx.converterForUser(userId);
  const all = await query(
    'SELECT * FROM subscriptions WHERE user_id = ? AND is_active = 1 ORDER BY next_billing_date, id',
    [userId]
  );
  let monthlyTotal = 0;
  for (const sub of all) {
    monthlyTotal = money.add(monthlyTotal, await conv.convert(monthlyEquivalent(sub.amount, sub.billing_cycle), sub.currency));
  }
  return {
    subscriptions: all.slice(0, 5),
    count: all.length,
    monthlyTotal,
    currency: conv.baseCurrency,
    baseCurrency: conv.baseCurrency,
    missingRates: conv.missingRates
  };
}

async function getInvestmentsData(userId) {
  const conv = await fx.converterForUser(userId);
  const portfolios = await query(
    'SELECT * FROM investment_portfolios WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const rows = await query(
    `SELECT i.currency AS currency, SUM(i.quantity * COALESCE(i.current_price, i.buy_price)) AS total
     FROM investments i
     JOIN investment_portfolios p ON p.id = i.portfolio_id
     WHERE p.user_id = ? AND p.is_active = 1 AND i.is_active = 1
     GROUP BY i.currency`,
    [userId]
  );
  const tot = await conv.totals(rows, ['total']);
  return {
    portfolioCount: portfolios.length,
    totalValue: tot.total || 0,
    currency: conv.baseCurrency,
    baseCurrency: conv.baseCurrency,
    missingRates: conv.missingRates
  };
}

// Список — первые 5 долгов; totalOwed — по всем, в базовой валюте.
async function getDebtsData(userId) {
  const conv = await fx.converterForUser(userId);
  const all = await query(
    `SELECT * FROM debts WHERE user_id = ? AND is_active = 1 AND is_paid = 0 ORDER BY id`,
    [userId]
  );
  let totalOwed = 0;
  for (const d of all) {
    totalOwed = money.add(totalOwed, await conv.convert(money.sub(d.amount, d.paid_amount || 0), d.currency));
  }
  return {
    debts: all.slice(0, 5),
    count: all.length,
    totalOwed,
    currency: conv.baseCurrency,
    baseCurrency: conv.baseCurrency,
    missingRates: conv.missingRates
  };
}

async function getRecentData(userId) {
  const transactions = await query(
    `SELECT t.*, a.currency AS currency FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 10`,
    [userId]
  );
  return { transactions };
}

async function getChartExpensesData(userId, tz) {
  const data = [];
  const thisMonthStart = dates.startOfMonthISO(dates.todayISO(tz));
  let currency = null;
  for (let i = 5; i >= 0; i--) {
    const start = dates.addMonthsISO(thisMonthStart, -i, 1);
    const end = dates.endOfMonthISO(start);
    const tot = await cashflowTotals(userId, start, end);
    currency = tot.currency;
    data.push({ month: start.substring(0, 7), amount: tot.expense });
  }
  return { data, currency, baseCurrency: currency };
}

async function getChartBalanceData(userId) {
  const snapshots = await query(
    'SELECT snapshot_date as date, net_worth as value FROM networth_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 12',
    [userId]
  );
  return { data: snapshots.reverse() };
}

module.exports = router;
