// ==================== МАРШРУТЫ АНАЛИТИКИ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get } = require('../db/database');
const dates = require('../lib/dates');
const { cashflowOnly } = require('../lib/txFilter');
const networthService = require('../services/networthService');

// Фильтр денежного потока: только income/expense, без переводов и строк
// «Начальный баланс» (иначе +658 % к прошлому месяцу и категория-призрак).
const CF = cashflowOnly();
const CFT = cashflowOnly('t');

// Границы периода по умолчанию — текущий месяц в часовом поясе пользователя.
function defaultRange(req) {
  const today = dates.todayISO(dates.userTz(req.user));
  return {
    start: req.query.startDate || dates.startOfMonthISO(today),
    end: req.query.endDate || today,
    today
  };
}

// Процент изменения с защитой от абсурда (деление на малую базу): |x| <= 999.
function pctChange(curr, prev) {
  if (!(prev > 0)) return 0;
  const v = ((curr - prev) / prev) * 100;
  if (!Number.isFinite(v)) return 0;
  return Math.max(-999, Math.min(999, Math.round(v * 100) / 100));
}

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Общая статистика
router.get('/overview', async (req, res) => {
  try {
    const userId = req.user.id;
    const { start, end } = defaultRange(req);

    // Доходы и расходы (только денежный поток)
    const totals = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) as total_expense,
        COUNT(*) as transaction_count
      FROM transactions
      WHERE user_id = ? AND date BETWEEN ? AND ?${CF.sql}
    `, [userId, start, end, ...CF.params]);

    // Total balance across accounts, converted into the user's base currency
    // (FX via networthService; missing rates fall back 1:1 and are flagged).
    const balance = await networthService.sumAccountsInBase(userId);

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
      totalBalance: balance.total,
      baseCurrency: balance.baseCurrency,
      missingRates: balance.missingRates,
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

// Расходы по категориям
router.get('/expenses-by-category', async (req, res) => {
  try {
    const { start, end } = defaultRange(req);

    const data = await query(`
      SELECT category, SUM(ABS(amount)) as total, COUNT(*) as count
      FROM transactions
      WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ?${CF.sql}
      GROUP BY category
      ORDER BY total DESC
    `, [req.user.id, start, end, ...CF.params]);

    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Доходы по категориям
router.get('/income-by-category', async (req, res) => {
  try {
    const { start, end } = defaultRange(req);

    const data = await query(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM transactions
      WHERE user_id = ? AND type = 'income' AND date BETWEEN ? AND ?${CF.sql}
      GROUP BY category
      ORDER BY total DESC
    `, [req.user.id, start, end, ...CF.params]);

    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Тренды (по дням/неделям/месяцам)
router.get('/trends', async (req, res) => {
  try {
    const { period = 'daily', months = 6 } = req.query;
    const { today } = defaultRange(req);
    const startDate = dates.addMonthsISO(today, -(parseInt(months) || 6));

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
      WHERE user_id = ? AND date >= ?${CF.sql}
      GROUP BY ${groupBy}
      ORDER BY period ASC
    `, [req.user.id, startDate, ...CF.params]);

    res.json({ period: dateFormat, data });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Сравнение периодов
router.get('/compare', async (req, res) => {
  try {
    const { today } = defaultRange(req);
    const thisMonthStart = dates.startOfMonthISO(today);
    const lastMonthStart = dates.addMonthsISO(thisMonthStart, -1, 1);
    const lastMonthEnd = dates.addDaysISO(thisMonthStart, -1);

    // Месяц к месяцу — только денежный поток: начальный баланс счёта и переводы
    // между счетами не доход и не расход.
    const thisMonth = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) as expense
      FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?${CF.sql}
    `, [req.user.id, thisMonthStart, today, ...CF.params]);

    const lastMonth = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END), 0) as expense
      FROM transactions WHERE user_id = ? AND date BETWEEN ? AND ?${CF.sql}
    `, [req.user.id, lastMonthStart, lastMonthEnd, ...CF.params]);

    res.json({
      period: { thisMonth: { start: thisMonthStart, end: today }, lastMonth: { start: lastMonthStart, end: lastMonthEnd } },
      thisMonth,
      lastMonth,
      changes: {
        income: pctChange(thisMonth.income, lastMonth.income),
        expense: pctChange(thisMonth.expense, lastMonth.expense)
      }
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Топ расходов
router.get('/top-expenses', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const { start, end } = defaultRange(req);

    const data = await query(`
      SELECT t.*, a.name as account_name
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ? AND t.type = 'expense' AND t.date BETWEEN ? AND ?${CFT.sql}
      ORDER BY ABS(t.amount) DESC
      LIMIT ?
    `, [req.user.id, start, end, ...CFT.params, parseInt(limit) || 10]);

    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Баланс по счетам
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
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
