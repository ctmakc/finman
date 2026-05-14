const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Прогноз баланса на N дней
router.get('/balance', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const userId = req.user.id;

    // Текущий баланс
    const currentBalance = await get(
      'SELECT SUM(balance) as total FROM accounts WHERE user_id = ?',
      [userId]
    );

    // Средние расходы за последние 3 месяца
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const avgExpenses = await get(
      `SELECT AVG(daily_total) as avg FROM (
        SELECT date, SUM(ABS(amount)) as daily_total
        FROM transactions
        WHERE user_id = ? AND type = 'expense' AND date >= ?
        GROUP BY date
      )`,
      [userId, threeMonthsAgo.toISOString().split('T')[0]]
    );

    // Средние доходы
    const avgIncome = await get(
      `SELECT AVG(daily_total) as avg FROM (
        SELECT date, SUM(amount) as daily_total
        FROM transactions
        WHERE user_id = ? AND type = 'income' AND date >= ?
        GROUP BY date
      )`,
      [userId, threeMonthsAgo.toISOString().split('T')[0]]
    );

    // Регулярные платежи
    const recurringPayments = await query(
      `SELECT amount, type, frequency, next_payment_date
       FROM recurring_payments
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    // Subscriptions
    const subscriptions = await query(
      `SELECT amount, billing_cycle, next_billing_date
       FROM subscriptions
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    // Прогнозируем на каждый день
    const forecast = [];
    let balance = currentBalance.total || 0;
    const dailyExpense = avgExpenses.avg || 0;
    const dailyIncome = avgIncome.avg || 0;
    const today = new Date();

    for (let i = 0; i <= parseInt(days); i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];

      let dayExpense = dailyExpense;
      let dayIncome = dailyIncome;

      // Добавляем регулярные платежи
      for (const payment of recurringPayments) {
        if (isPaymentDue(payment, dateStr)) {
          if (payment.type === 'expense') {
            dayExpense += payment.amount;
          } else {
            dayIncome += payment.amount;
          }
        }
      }

      // Добавляем подписки
      for (const sub of subscriptions) {
        if (isSubscriptionDue(sub, dateStr)) {
          dayExpense += sub.amount;
        }
      }

      if (i > 0) {
        balance = balance + dayIncome - dayExpense;
      }

      forecast.push({
        date: dateStr,
        balance: Math.round(balance * 100) / 100,
        income: Math.round(dayIncome * 100) / 100,
        expense: Math.round(dayExpense * 100) / 100
      });
    }

    // Статистика
    const endBalance = forecast[forecast.length - 1].balance;
    const change = endBalance - (currentBalance.total || 0);
    const lowestPoint = Math.min(...forecast.map(f => f.balance));
    const lowestDate = forecast.find(f => f.balance === lowestPoint)?.date;

    res.json({
      forecast,
      summary: {
        currentBalance: currentBalance.total || 0,
        projectedBalance: endBalance,
        change,
        changePercent: currentBalance.total ? ((change / currentBalance.total) * 100).toFixed(1) : 0,
        lowestPoint,
        lowestDate,
        avgDailyExpense: Math.round(dailyExpense * 100) / 100,
        avgDailyIncome: Math.round(dailyIncome * 100) / 100
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Прогноз расходов по категориям
router.get('/expenses', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const userId = req.user.id;

    // Средние расходы по категориям за последние 3 месяца
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const categoryAvg = await query(
      `SELECT category,
              SUM(ABS(amount)) as total,
              COUNT(DISTINCT date) as days,
              SUM(ABS(amount)) / COUNT(DISTINCT date) as daily_avg
       FROM transactions
       WHERE user_id = ? AND type = 'expense' AND date >= ?
       GROUP BY category
       ORDER BY total DESC`,
      [userId, threeMonthsAgo.toISOString().split('T')[0]]
    );

    const projections = categoryAvg.map(cat => ({
      category: cat.category || 'Uncategorized',
      currentMonthly: Math.round(cat.daily_avg * 30 * 100) / 100,
      projected: Math.round(cat.daily_avg * parseInt(days) * 100) / 100,
      dailyAvg: Math.round(cat.daily_avg * 100) / 100
    }));

    res.json({
      days: parseInt(days),
      categories: projections,
      totalProjected: projections.reduce((s, c) => s + c.projected, 0)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Прогноз достижения цели
router.get('/goal/:id', async (req, res) => {
  try {
    const goal = await get(
      'SELECT * FROM savings_goals WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!goal) {
      return res.status(404).json({ message: 'Goal not found' });
    }

    // История пополнений
    const contributions = await query(
      `SELECT date(created_at) as date, amount FROM goal_contributions
       WHERE goal_id = ? ORDER BY created_at`,
      [goal.id]
    );

    const remaining = goal.target_amount - goal.current_amount;

    if (contributions.length < 2) {
      // Not enough data
      const daysToTarget = goal.target_date
        ? Math.ceil((new Date(goal.target_date) - new Date()) / (1000 * 60 * 60 * 24))
        : null;

      return res.json({
        goal,
        remaining,
        avgContribution: 0,
        projectedDate: null,
        daysToTarget,
        requiredDaily: daysToTarget ? remaining / daysToTarget : null,
        onTrack: null,
        message: 'Not enough data for forecast'
      });
    }

    // Средняя скорость накопления
    const firstDate = new Date(contributions[0].date);
    const lastDate = new Date(contributions[contributions.length - 1].date);
    const daysPassed = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
    const totalContributed = contributions.reduce((s, c) => s + c.amount, 0);
    const avgDaily = totalContributed / daysPassed;

    // Прогноз даты достижения
    const daysNeeded = avgDaily > 0 ? Math.ceil(remaining / avgDaily) : null;
    const projectedDate = daysNeeded
      ? new Date(Date.now() + daysNeeded * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : null;

    // Проверка, успеваем ли к целевой дате
    let onTrack = null;
    let requiredDaily = null;
    if (goal.target_date) {
      const daysToTarget = Math.ceil((new Date(goal.target_date) - new Date()) / (1000 * 60 * 60 * 24));
      requiredDaily = daysToTarget > 0 ? remaining / daysToTarget : remaining;
      onTrack = avgDaily >= requiredDaily;
    }

    res.json({
      goal,
      remaining,
      avgContribution: Math.round(avgDaily * 100) / 100,
      avgMonthly: Math.round(avgDaily * 30 * 100) / 100,
      projectedDate,
      daysNeeded,
      requiredDaily: requiredDaily ? Math.round(requiredDaily * 100) / 100 : null,
      onTrack
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Прогноз погашения долга
router.get('/debt/:id', async (req, res) => {
  try {
    const debt = await get(
      'SELECT * FROM debts WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!debt) {
      return res.status(404).json({ message: 'Debt not found' });
    }

    const remaining = debt.amount - debt.paid_amount;

    // История платежей
    const payments = await query(
      `SELECT payment_date as date, amount FROM debt_payments WHERE debt_id = ? ORDER BY payment_date`,
      [debt.id]
    );

    if (payments.length < 2) {
      return res.json({
        debt,
        remaining,
        avgPayment: 0,
        projectedDate: null,
        message: 'Not enough data for forecast'
      });
    }

    // Средний платёж
    const firstDate = new Date(payments[0].date);
    const lastDate = new Date(payments[payments.length - 1].date);
    const daysPassed = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
    const avgDaily = debt.paid_amount / daysPassed;

    const daysNeeded = avgDaily > 0 ? Math.ceil(remaining / avgDaily) : null;
    const projectedDate = daysNeeded
      ? new Date(Date.now() + daysNeeded * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : null;

    res.json({
      debt,
      remaining,
      avgPayment: Math.round(avgDaily * 30 * 100) / 100,
      projectedDate,
      daysNeeded
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Анализ трендов
router.get('/trends', async (req, res) => {
  try {
    const userId = req.user.id;

    // Данные за последние 6 месяцев
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const start = new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0];

      const income = await get(
        `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'income' AND date >= ? AND date <= ?`,
        [userId, start, end]
      );
      const expense = await get(
        `SELECT SUM(ABS(amount)) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`,
        [userId, start, end]
      );

      months.push({
        month: start.substring(0, 7),
        income: income.total || 0,
        expense: expense.total || 0,
        savings: (income.total || 0) - (expense.total || 0)
      });
    }

    // Тренды
    const incomesTrend = calculateTrend(months.map(m => m.income));
    const expensesTrend = calculateTrend(months.map(m => m.expense));
    const savingsTrend = calculateTrend(months.map(m => m.savings));

    // Прогноз на следующий месяц
    const nextMonthIncome = predictNext(months.map(m => m.income));
    const nextMonthExpense = predictNext(months.map(m => m.expense));

    res.json({
      months,
      trends: {
        income: { direction: incomesTrend > 0 ? 'up' : 'down', percent: Math.abs(incomesTrend).toFixed(1) },
        expense: { direction: expensesTrend > 0 ? 'up' : 'down', percent: Math.abs(expensesTrend).toFixed(1) },
        savings: { direction: savingsTrend > 0 ? 'up' : 'down', percent: Math.abs(savingsTrend).toFixed(1) }
      },
      prediction: {
        nextMonthIncome: Math.round(nextMonthIncome),
        nextMonthExpense: Math.round(nextMonthExpense),
        nextMonthSavings: Math.round(nextMonthIncome - nextMonthExpense)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Вспомогательные функции
function isPaymentDue(payment, dateStr) {
  if (!payment.next_payment_date) return false;
  const nextDate = new Date(payment.next_payment_date);
  const checkDate = new Date(dateStr);

  if (payment.frequency === 'daily') return true;
  if (payment.frequency === 'weekly') {
    return nextDate.getDay() === checkDate.getDay();
  }
  if (payment.frequency === 'monthly') {
    return nextDate.getDate() === checkDate.getDate();
  }
  return payment.next_payment_date === dateStr;
}

function isSubscriptionDue(sub, dateStr) {
  if (!sub.next_billing_date) return false;
  const nextDate = new Date(sub.next_billing_date);
  const checkDate = new Date(dateStr);

  if (sub.billing_cycle === 'monthly') {
    return nextDate.getDate() === checkDate.getDate();
  }
  if (sub.billing_cycle === 'yearly') {
    return nextDate.getDate() === checkDate.getDate() && nextDate.getMonth() === checkDate.getMonth();
  }
  return sub.next_billing_date === dateStr;
}

function calculateTrend(values) {
  if (values.length < 2) return 0;
  const first = values.slice(0, Math.floor(values.length / 2));
  const second = values.slice(Math.floor(values.length / 2));
  const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
  if (avgFirst === 0) return 0;
  return ((avgSecond - avgFirst) / avgFirst) * 100;
}

function predictNext(values) {
  if (values.length < 2) return values[values.length - 1] || 0;
  // Простая линейная регрессия
  const n = values.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
  const sumX2 = values.reduce((sum, _, x) => sum + x * x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  return Math.max(0, slope * n + intercept);
}

module.exports = router;
