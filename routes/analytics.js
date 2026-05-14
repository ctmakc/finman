// ==================== МАРШРУТЫ АНАЛИТИКИ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Общая статистика
router.get('/overview', async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;
    
    const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    // Income и расходы
    const totals = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) as total_expense,
        COUNT(*) as transaction_count
      FROM transactions
      WHERE user_id = ? AND date BETWEEN ? AND ?
    `, [userId, start, end]);

    // Balance по счетам
    const balance = await get(`
      SELECT COALESCE(SUM(balance), 0) as total_balance
      FROM accounts WHERE user_id = ? AND is_active = 1
    `, [userId]);

    // Количество активных целей и их прогресс
    const goals = await get(`
      SELECT COUNT(*) as count,
        COALESCE(SUM(current_amount), 0) as saved,
        COALESCE(SUM(target_amount), 0) as target
      FROM savings_goals WHERE user_id = ? AND is_active = 1 AND is_completed = 0
    `, [userId]);

    // Активные долги
    const debts = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN type IN ('i_owe', 'credit', 'mortgage', 'loan') THEN amount - paid_amount ELSE 0 END), 0) as i_owe,
        COALESCE(SUM(CASE WHEN type = 'owe_me' THEN amount - paid_amount ELSE 0 END), 0) as owe_me
      FROM debts WHERE user_id = ? AND is_active = 1 AND is_paid = 0
    `, [userId]);

    res.json({
      period: { start, end },
      income: totals.total_income,
      expense: totals.total_expense,
      netIncome: totals.total_income - totals.total_expense,
      transactionCount: totals.transaction_count,
      totalBalance: balance.total_balance,
      savingsGoals: {
        count: goals.count,
        saved: goals.saved,
        target: goals.target,
        progress: goals.target > 0 ? Math.round((goals.saved / goals.target) * 100) : 0
      },
      debts: {
        iOwe: debts.i_owe,
        oweMe: debts.owe_me,
        net: debts.owe_me - debts.i_owe
      }
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Expenses по категориям
router.get('/expenses-by-category', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    const data = await query(`
      SELECT category, SUM(ABS(amount)) as total, COUNT(*) as count
      FROM transactions
      WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ?
      GROUP BY category
      ORDER BY total DESC
    `, [req.user.id, start, end]);

    res.json(data);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Income по категориям
router.get('/income-by-category', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    const data = await query(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM transactions
      WHERE user_id = ? AND type = 'income' AND date BETWEEN ? AND ?
      GROUP BY category
      ORDER BY total DESC
    `, [req.user.id, start, end]);

    res.json(data);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Тренды (по дням/неделям/месяцам)
router.get('/trends', async (req, res) => {
  try {
    const { period = 'daily', months = 6 } = req.query;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - parseInt(months));

    let groupBy, dateFormat;
    switch (period) {
      case 'weekly':
        groupBy = "strftime('%Y-%W', date)";
        dateFormat = 'week';
        break;
      case 'monthly':
        groupBy = "strftime('%Y-%m', date)";
        dateFormat = 'month';
        break;
      default:
        groupBy = 'date';
        dateFormat = 'day';
    }

    const data = await query(`
      SELECT 
        ${groupBy} as period,
        SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END) as expense
      FROM transactions
      WHERE user_id = ? AND date >= ?
      GROUP BY ${groupBy}
      ORDER BY period ASC
    `, [req.user.id, startDate.toISOString().split('T')[0]]);

    res.json({ period: dateFormat, data });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Сравнение периодов
router.get('/compare', async (req, res) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const thisMonth = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) as expense
      FROM transactions WHERE user_id = ? AND date >= ?
    `, [req.user.id, thisMonthStart.toISOString().split('T')[0]]);

    const lastMonth = await get(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) as expense
      FROM transactions WHERE user_id = ? AND date BETWEEN ? AND ?
    `, [req.user.id, lastMonthStart.toISOString().split('T')[0], lastMonthEnd.toISOString().split('T')[0]]);

    const incomeChange = lastMonth.income > 0 ? ((thisMonth.income - lastMonth.income) / lastMonth.income) * 100 : 0;
    const expenseChange = lastMonth.expense > 0 ? ((thisMonth.expense - lastMonth.expense) / lastMonth.expense) * 100 : 0;

    res.json({
      thisMonth,
      lastMonth,
      changes: {
        income: Math.round(incomeChange * 100) / 100,
        expense: Math.round(expenseChange * 100) / 100
      }
    });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Топ расходов
router.get('/top-expenses', async (req, res) => {
  try {
    const { limit = 10, startDate, endDate } = req.query;
    const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    const data = await query(`
      SELECT t.*, a.name as account_name
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ? AND t.type = 'expense' AND t.date BETWEEN ? AND ?
      ORDER BY ABS(t.amount) DESC
      LIMIT ?
    `, [req.user.id, start, end, parseInt(limit)]);

    res.json(data);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Balance по счетам
router.get('/account-balances', async (req, res) => {
  try {
    const accounts = await query(`
      SELECT id, name, bank_name, balance, currency, account_type
      FROM accounts
      WHERE user_id = ? AND is_active = 1
      ORDER BY balance DESC
    `, [req.user.id]);

    res.json(accounts);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
