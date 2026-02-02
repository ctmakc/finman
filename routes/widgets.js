const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Доступные виджеты
router.get('/available', (req, res) => {
  res.json([
    { type: 'balance', name: 'Общий баланс', description: 'Сумма всех счетов', sizes: ['small', 'medium'] },
    { type: 'networth', name: 'Net Worth', description: 'Чистая стоимость', sizes: ['small', 'medium'] },
    { type: 'budget', name: 'Бюджеты', description: 'Статус бюджетов', sizes: ['medium', 'large'] },
    { type: 'expenses', name: 'Расходы', description: 'Расходы за период', sizes: ['small', 'medium', 'large'] },
    { type: 'income', name: 'Доходы', description: 'Доходы за период', sizes: ['small', 'medium'] },
    { type: 'goals', name: 'Цели', description: 'Прогресс целей', sizes: ['medium', 'large'] },
    { type: 'upcoming', name: 'Предстоящее', description: 'Ближайшие платежи', sizes: ['medium', 'large'] },
    { type: 'subscriptions', name: 'Подписки', description: 'Активные подписки', sizes: ['small', 'medium'] },
    { type: 'investments', name: 'Инвестиции', description: 'Портфель', sizes: ['medium', 'large'] },
    { type: 'debts', name: 'Долги', description: 'Текущие долги', sizes: ['small', 'medium'] },
    { type: 'chart_expenses', name: 'График расходов', description: 'Динамика расходов', sizes: ['large'] },
    { type: 'chart_balance', name: 'График баланса', description: 'Динамика баланса', sizes: ['large'] },
    { type: 'recent', name: 'Последние операции', description: 'Недавние транзакции', sizes: ['medium', 'large'] },
    { type: 'quick_add', name: 'Быстрый ввод', description: 'Добавить транзакцию', sizes: ['small'] }
  ]);
});

// Виджеты пользователя
router.get('/', async (req, res) => {
  try {
    let widgets = await query(
      'SELECT * FROM dashboard_widgets WHERE user_id = ? ORDER BY position',
      [req.user.id]
    );

    // Если нет виджетов, создаём дефолтные
    if (widgets.length === 0) {
      const defaults = [
        { type: 'balance', title: 'Баланс', position: 0, size: 'small' },
        { type: 'expenses', title: 'Расходы за месяц', position: 1, size: 'small' },
        { type: 'income', title: 'Доходы за месяц', position: 2, size: 'small' },
        { type: 'budget', title: 'Бюджеты', position: 3, size: 'medium' },
        { type: 'upcoming', title: 'Предстоящие платежи', position: 4, size: 'medium' },
        { type: 'recent', title: 'Последние операции', position: 5, size: 'medium' }
      ];

      for (const w of defaults) {
        await run(
          'INSERT INTO dashboard_widgets (user_id, widget_type, title, position, size) VALUES (?, ?, ?, ?, ?)',
          [req.user.id, w.type, w.title, w.position, w.size]
        );
      }

      widgets = await query('SELECT * FROM dashboard_widgets WHERE user_id = ? ORDER BY position', [req.user.id]);
    }

    res.json(widgets.map(w => ({
      ...w,
      settings: JSON.parse(w.settings || '{}')
    })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Данные для виджета
router.get('/:type/data', async (req, res) => {
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
        return res.status(400).json({ message: 'Неизвестный тип виджета' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Добавить виджет
router.post('/', async (req, res) => {
  try {
    const { widget_type, title, size, settings } = req.body;

    const maxPos = await get('SELECT MAX(position) as max FROM dashboard_widgets WHERE user_id = ?', [req.user.id]);

    const result = await run(
      'INSERT INTO dashboard_widgets (user_id, widget_type, title, position, size, settings) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, widget_type, title, (maxPos.max || 0) + 1, size || 'medium', JSON.stringify(settings || {})]
    );

    res.status(201).json({ id: result.id, message: 'Виджет добавлен' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Обновить виджет
router.put('/:id', async (req, res) => {
  try {
    const widget = await get('SELECT * FROM dashboard_widgets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!widget) return res.status(404).json({ message: 'Виджет не найден' });

    const { title, size, settings, is_visible } = req.body;

    await run(
      'UPDATE dashboard_widgets SET title = ?, size = ?, settings = ?, is_visible = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [title || widget.title, size || widget.size, JSON.stringify(settings || JSON.parse(widget.settings || '{}')), is_visible !== undefined ? (is_visible ? 1 : 0) : widget.is_visible, req.params.id]
    );

    res.json({ message: 'Виджет обновлён' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Изменить порядок виджетов
router.post('/reorder', async (req, res) => {
  try {
    const { order } = req.body; // [{id: 1, position: 0}, {id: 2, position: 1}, ...]

    for (const item of order) {
      await run('UPDATE dashboard_widgets SET position = ? WHERE id = ? AND user_id = ?', [item.position, item.id, req.user.id]);
    }

    res.json({ message: 'Порядок обновлён' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Удалить виджет
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM dashboard_widgets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Виджет удалён' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Функции получения данных
async function getBalanceData(userId) {
  const result = await get('SELECT SUM(balance) as total FROM accounts WHERE user_id = ?', [userId]);
  return { total: result.total || 0 };
}

async function getNetWorthData(userId) {
  const accounts = await get('SELECT SUM(balance) as total FROM accounts WHERE user_id = ?', [userId]);
  const debts = await get(`SELECT SUM(amount - paid_amount) as total FROM debts WHERE user_id = ? AND is_active = 1 AND type IN ('i_owe', 'credit')`, [userId]);
  const assets = await get('SELECT SUM(value) as total FROM manual_assets WHERE user_id = ? AND is_active = 1', [userId]);

  const netWorth = (accounts.total || 0) + (assets.total || 0) - (debts.total || 0);
  return { netWorth, assets: (accounts.total || 0) + (assets.total || 0), liabilities: debts.total || 0 };
}

async function getBudgetData(userId) {
  const budgets = await query('SELECT * FROM budgets WHERE user_id = ? LIMIT 5', [userId]);
  return { budgets, count: budgets.length };
}

async function getExpensesData(userId, period) {
  const start = period === 'month' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0] : new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
  const result = await get(`SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ?`, [userId, start]);
  return { total: result.total || 0, period };
}

async function getIncomeData(userId, period) {
  const start = period === 'month' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0] : new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
  const result = await get(`SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'income' AND date >= ?`, [userId, start]);
  return { total: result.total || 0, period };
}

async function getGoalsData(userId) {
  const goals = await query('SELECT * FROM savings_goals WHERE user_id = ? AND is_active = 1 AND is_completed = 0 LIMIT 5', [userId]);
  return { goals: goals.map(g => ({ ...g, progress: g.target_amount > 0 ? (g.current_amount / g.target_amount * 100) : 0 })) };
}

async function getUpcomingData(userId) {
  const today = new Date().toISOString().split('T')[0];
  const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const recurring = await query(`SELECT description as title, amount, next_execution_date as date FROM recurring_payments WHERE user_id = ? AND is_active = 1 AND next_execution_date >= ? AND next_execution_date <= ? LIMIT 5`, [userId, today, weekLater]);
  const subscriptions = await query(`SELECT name as title, amount, next_billing_date as date FROM subscriptions WHERE user_id = ? AND is_active = 1 AND next_billing_date >= ? AND next_billing_date <= ? LIMIT 5`, [userId, today, weekLater]);

  return { items: [...recurring, ...subscriptions].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 5) };
}

async function getSubscriptionsData(userId) {
  const subs = await query('SELECT * FROM subscriptions WHERE user_id = ? AND is_active = 1 LIMIT 5', [userId]);
  const monthlyTotal = subs.reduce((s, sub) => s + (sub.billing_cycle === 'monthly' ? sub.amount : sub.billing_cycle === 'yearly' ? sub.amount / 12 : sub.amount), 0);
  return { subscriptions: subs, monthlyTotal };
}

async function getInvestmentsData(userId) {
  const portfolios = await query('SELECT * FROM investment_portfolios WHERE user_id = ? AND is_active = 1', [userId]);
  let totalValue = 0;
  for (const p of portfolios) {
    const val = await get('SELECT SUM(quantity * COALESCE(current_price, buy_price)) as total FROM investments WHERE portfolio_id = ? AND is_active = 1', [p.id]);
    totalValue += val.total || 0;
  }
  return { portfolioCount: portfolios.length, totalValue };
}

async function getDebtsData(userId) {
  const debts = await query(`SELECT * FROM debts WHERE user_id = ? AND is_active = 1 AND is_paid = 0 LIMIT 5`, [userId]);
  const totalOwed = debts.reduce((s, d) => s + (d.amount - d.paid_amount), 0);
  return { debts, totalOwed };
}

async function getRecentData(userId) {
  const transactions = await query('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 10', [userId]);
  return { transactions };
}

async function getChartExpensesData(userId) {
  const data = [];
  for (let i = 5; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    const start = new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0];

    const result = await get(`SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`, [userId, start, end]);
    data.push({ month: start.substring(0, 7), amount: result.total || 0 });
  }
  return { data };
}

async function getChartBalanceData(userId) {
  const snapshots = await query('SELECT snapshot_date as date, net_worth as value FROM networth_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 12', [userId]);
  return { data: snapshots.reverse() };
}

module.exports = router;
