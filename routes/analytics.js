// ==================== МАРШРУТЫ АНАЛИТИКИ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query } = require('../db/database');
const dates = require('../lib/dates');
const money = require('../lib/money');
const { cashflowOnly } = require('../lib/txFilter');
const networthService = require('../services/networthService');
const fx = require('../lib/fx');

// Фильтр денежного потока: только income/expense, без переводов и строк
// «Начальный баланс» (иначе +658 % к прошлому месяцу и категория-призрак).
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

// Суммы по категориям в базовой валюте: группируем по (категория, валюта
// счёта), переводим каждую группу и сливаем обратно. Каждая строка несёт
// currency = базовая валюта пользователя.
async function categoryTotals(userId, type, start, end) {
  const conv = await fx.converterForUser(userId);
  const rows = await query(`
    SELECT t.category AS category, a.currency AS currency, SUM(ABS(t.amount)) as total, COUNT(*) as count
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.user_id = ? AND t.type = ? AND t.date BETWEEN ? AND ?${CFT.sql}
    GROUP BY t.category, a.currency
  `, [userId, type, start, end, ...CFT.params]);
  const merged = await conv.regroup(rows, { keys: ['category'], amounts: ['total'], counts: ['count'] });
  return merged
    .map((r) => ({ ...r, currency: conv.baseCurrency }))
    .sort((a, b) => b.total - a.total);
}

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Общая статистика
router.get('/overview', async (req, res) => {
  try {
    const userId = req.user.id;
    const { start, end } = defaultRange(req);

    // Доходы и расходы (только денежный поток). Сумма каждой валюты счёта
    // переводится в базовую валюту пользователя (lib/fx).
    const conv = await fx.converterForUser(userId);
    const totalsRows = await query(`
      SELECT
        a.currency AS currency,
        COALESCE(SUM(CASE WHEN t.type = 'income' THEN ABS(t.amount) ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN t.type = 'expense' THEN ABS(t.amount) ELSE 0 END), 0) as total_expense,
        COUNT(*) as transaction_count
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND t.date BETWEEN ? AND ?${CFT.sql}
      GROUP BY a.currency
    `, [userId, start, end, ...CFT.params]);
    const totals = await conv.totals(totalsRows, ['total_income', 'total_expense'], { counts: ['transaction_count'] });

    // Total balance across accounts, converted into the user's base currency
    // (FX via networthService; missing rates fall back 1:1 and are flagged).
    const balance = await networthService.sumAccountsInBase(userId, { baseCurrency: conv.baseCurrency });

    // Количество активных целей и их прогресс (каждая цель — в своей валюте)
    const goalRows = await query(`
      SELECT currency, COUNT(*) as count,
        COALESCE(SUM(current_amount), 0) as saved,
        COALESCE(SUM(target_amount), 0) as target
      FROM savings_goals WHERE user_id = ? AND is_active = 1 AND is_completed = 0
      GROUP BY currency
    `, [userId]);
    const goals = await conv.totals(goalRows, ['saved', 'target'], { counts: ['count'] });

    // Активные долги (каждый — в своей валюте)
    const debtRows = await query(`
      SELECT currency,
        COALESCE(SUM(CASE WHEN type IN ('i_owe', 'credit', 'mortgage', 'loan') THEN amount - paid_amount ELSE 0 END), 0) as i_owe,
        COALESCE(SUM(CASE WHEN type = 'owe_me' THEN amount - paid_amount ELSE 0 END), 0) as owe_me
      FROM debts WHERE user_id = ? AND is_active = 1 AND is_paid = 0
      GROUP BY currency
    `, [userId]);
    const debts = await conv.totals(debtRows, ['i_owe', 'owe_me']);
    const missingRates = Array.from(new Set([...(balance.missingRates || []), ...conv.missingRates]));

    res.json({
      period: { start, end },
      income: totals.total_income,
      expense: totals.total_expense,
      netIncome: money.sub(totals.total_income, totals.total_expense),
      transactionCount: totals.transaction_count,
      totalBalance: balance.total,
      currency: conv.baseCurrency,
      baseCurrency: conv.baseCurrency,
      missingRates,
      savingsGoals: {
        count: goals.count,
        saved: goals.saved,
        target: goals.target,
        progress: goals.target > 0 ? Math.round((goals.saved / goals.target) * 100) : 0
      },
      debts: {
        iOwe: debts.i_owe,
        oweMe: debts.owe_me,
        net: money.sub(debts.owe_me, debts.i_owe)
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

    const data = await categoryTotals(req.user.id, 'expense', start, end);
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

    const data = await categoryTotals(req.user.id, 'income', start, end);
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
        groupBy = "strftime('%Y-%W', t.date)";
        dateFormat = 'week';
        break;
      case 'monthly':
        groupBy = "strftime('%Y-%m', t.date)";
        dateFormat = 'month';
        break;
      default:
        groupBy = 't.date';
        dateFormat = 'day';
    }

    const conv = await fx.converterForUser(req.user.id);
    const rows = await query(`
      SELECT
        ${groupBy} as period,
        a.currency AS currency,
        SUM(CASE WHEN t.type = 'income' THEN ABS(t.amount) ELSE 0 END) as income,
        SUM(CASE WHEN t.type = 'expense' THEN ABS(t.amount) ELSE 0 END) as expense
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND t.date >= ?${CFT.sql}
      GROUP BY ${groupBy}, a.currency
      ORDER BY period ASC
    `, [req.user.id, startDate, ...CFT.params]);
    const data = await conv.regroup(rows, { keys: ['period'], amounts: ['income', 'expense'] });

    res.json({ period: dateFormat, currency: conv.baseCurrency, baseCurrency: conv.baseCurrency, missingRates: conv.missingRates, data });
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
    const conv = await fx.converterForUser(req.user.id);
    const sumRange = async (from, to) => {
      const rows = await query(`
        SELECT a.currency AS currency,
          COALESCE(SUM(CASE WHEN t.type = 'income' THEN ABS(t.amount) ELSE 0 END), 0) as income,
          COALESCE(SUM(CASE WHEN t.type = 'expense' THEN ABS(t.amount) ELSE 0 END), 0) as expense
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ? AND t.date >= ? AND t.date <= ?${CFT.sql}
        GROUP BY a.currency
      `, [req.user.id, from, to, ...CFT.params]);
      return conv.totals(rows, ['income', 'expense']);
    };
    const thisMonth = await sumRange(thisMonthStart, today);
    const lastMonth = await sumRange(lastMonthStart, lastMonthEnd);

    res.json({
      period: { thisMonth: { start: thisMonthStart, end: today }, lastMonth: { start: lastMonthStart, end: lastMonthEnd } },
      currency: conv.baseCurrency,
      baseCurrency: conv.baseCurrency,
      missingRates: conv.missingRates,
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
      SELECT t.*, a.name as account_name, a.currency AS currency
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
