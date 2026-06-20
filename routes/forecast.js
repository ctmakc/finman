const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');
const money = require('../lib/money');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Прогноз баланса на N дней.
// УЛУЧШЕННАЯ МОДЕЛЬ (backward-compatible — старые поля сохранены, новые добавлены):
//   - сезонность по дню недели и дню месяца на историческом дневном net (income-expense);
//   - линейный тренд по дневному net через МНК;
//   - доверительный коридор +/- 1 std остатков (модель vs факт), расширяющийся со временем.
router.get('/balance', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const horizon = Math.max(1, parseInt(days) || 30);
    const userId = req.user.id;

    // Текущий баланс
    const currentBalance = await get(
      'SELECT SUM(balance) as total FROM accounts WHERE user_id = ?',
      [userId]
    );

    // Период истории для обучения модели (по умолчанию 90 дней).
    const HISTORY_DAYS = 90;
    const historyStart = new Date();
    historyStart.setDate(historyStart.getDate() - HISTORY_DAYS);
    const historyStartStr = historyStart.toISOString().split('T')[0];

    // Дневные суммы доходов/расходов из истории.
    const dailyRows = await query(
      `SELECT date,
              SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense
       FROM transactions
       WHERE user_id = ? AND date >= ?
       GROUP BY date
       ORDER BY date ASC`,
      [userId, historyStartStr]
    );

    // Средние расходы за последние 3 месяца (СОХРАНЯЕМ старое поведение для
    // обратной совместимости полей summary.avgDaily*).
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const avgExpenses = await get(
      `SELECT AVG(daily_total) as avg FROM (
        SELECT date, SUM(amount) as daily_total
        FROM transactions
        WHERE user_id = ? AND type = 'expense' AND date >= ?
        GROUP BY date
      )`,
      [userId, threeMonthsAgo.toISOString().split('T')[0]]
    );
    const avgIncome = await get(
      `SELECT AVG(daily_total) as avg FROM (
        SELECT date, SUM(amount) as daily_total
        FROM transactions
        WHERE user_id = ? AND type = 'income' AND date >= ?
        GROUP BY date
      )`,
      [userId, threeMonthsAgo.toISOString().split('T')[0]]
    );

    // Регулярные платежи. Колонка даты в схеме — next_payment_date; читаем
    // также next_execution_date для совместимости со старыми данными/кодом.
    const recurringPayments = await query(
      `SELECT amount, type, frequency, next_payment_date
       FROM recurring_payments
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );
    for (const p of recurringPayments) {
      // нормализуем имя поля, на которое опираются helper-функции
      p.next_execution_date = p.next_payment_date || p.next_execution_date;
    }

    // Подписки
    const subscriptions = await query(
      `SELECT amount, billing_cycle, next_billing_date
       FROM subscriptions
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    // ---- Обучаем сезонно-трендовую модель на дневном net ----
    const model = buildSeasonalTrendModel(dailyRows, HISTORY_DAYS);

    const dailyExpense = avgExpenses.avg || 0;
    const dailyIncome = avgIncome.avg || 0;

    // Если истории мало — деградируем к плоской средней (как раньше).
    const haveModel = model.samples >= 5;
    const flatNet = dailyIncome - dailyExpense;

    const forecast = [];
    let balance = currentBalance.total || 0;
    const today = new Date();

    // Доверительный коридор: +/- z * std остатков, расширяется ~sqrt(шага).
    const Z = 1; // 1 std (~68%)
    const residualStd = haveModel ? model.residualStd : 0;

    for (let i = 0; i <= horizon; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];

      // Базовый прогноз дневного net из модели (или плоский fallback).
      const modeledNet = haveModel ? predictNet(model, i) : flatNet;

      // Разносим net на income/expense для обратной совместимости полей.
      // Fallback-режим: плоские средние. Модельный режим: средний поток
      // доходов/расходов, скорректированный так, чтобы income - expense
      // совпадал с прогнозом net модели.
      let dayIncome = dailyIncome;
      let dayExpense = dailyExpense;
      if (haveModel) {
        dayIncome = Math.max(0, model.avgIncome);
        dayExpense = Math.max(0, model.avgExpense);
        const drift = modeledNet - (dayIncome - dayExpense);
        if (drift >= 0) dayIncome += drift;
        else dayExpense += -drift;
      }

      // Добавляем регулярные платежи поверх базового прогноза.
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

      // Ширина коридора растёт как sqrt(дни) — накопление неопределённости.
      const band = money.round(Z * residualStd * Math.sqrt(Math.max(1, i)));

      forecast.push({
        date: dateStr,
        balance: money.round(balance),
        income: money.round(dayIncome),
        expense: money.round(dayExpense),
        // НОВЫЕ поля (доверительный коридор):
        balanceLower: money.round(balance - band),
        balanceUpper: money.round(balance + band),
        confidenceBand: band
      });
    }

    // Статистика
    const endBalance = forecast[forecast.length - 1].balance;
    const change = money.round(endBalance - (currentBalance.total || 0));
    const lowestPoint = Math.min(...forecast.map(f => f.balance));
    const lowestDate = forecast.find(f => f.balance === lowestPoint)?.date;
    // Худший сценарий по нижней границе коридора.
    const worstCasePoint = Math.min(...forecast.map(f => f.balanceLower));
    const worstCaseDate = forecast.find(f => f.balanceLower === worstCasePoint)?.date;

    res.json({
      forecast,
      summary: {
        currentBalance: currentBalance.total || 0,
        projectedBalance: endBalance,
        change,
        changePercent: currentBalance.total ? ((change / currentBalance.total) * 100).toFixed(1) : 0,
        lowestPoint,
        lowestDate,
        avgDailyExpense: money.round(dailyExpense),
        avgDailyIncome: money.round(dailyIncome),
        // НОВЫЕ поля модели/коридора:
        model: haveModel ? 'seasonal_trend' : 'flat_average',
        confidence: {
          residualStd: money.round(residualStd),
          // конечная ширина коридора (на горизонте прогноза)
          endBand: forecast[forecast.length - 1].confidenceBand,
          projectedLower: forecast[forecast.length - 1].balanceLower,
          projectedUpper: forecast[forecast.length - 1].balanceUpper
        },
        trendPerDay: haveModel ? money.round(model.slope) : 0,
        worstCasePoint: money.round(worstCasePoint),
        worstCaseDate
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
              SUM(amount) as total,
              COUNT(DISTINCT date) as days,
              SUM(amount) / COUNT(DISTINCT date) as daily_avg
       FROM transactions
       WHERE user_id = ? AND type = 'expense' AND date >= ?
       GROUP BY category
       ORDER BY total DESC`,
      [userId, threeMonthsAgo.toISOString().split('T')[0]]
    );

    const projections = categoryAvg.map(cat => ({
      category: cat.category || 'Без категории',
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
      return res.status(404).json({ message: 'Цель не найдена' });
    }

    // История пополнений
    const contributions = await query(
      `SELECT date, amount FROM goal_contributions
       WHERE goal_id = ? ORDER BY date`,
      [goal.id]
    );

    const remaining = goal.target_amount - goal.current_amount;

    if (contributions.length < 2) {
      // Недостаточно данных
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
        message: 'Недостаточно данных для прогноза'
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
      return res.status(404).json({ message: 'Долг не найден' });
    }

    const remaining = debt.amount - debt.paid_amount;

    // История платежей
    const payments = await query(
      `SELECT date, amount FROM debt_payments WHERE debt_id = ? ORDER BY date`,
      [debt.id]
    );

    if (payments.length < 2) {
      return res.json({
        debt,
        remaining,
        avgPayment: 0,
        projectedDate: null,
        message: 'Недостаточно данных для прогноза'
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
        `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`,
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
  if (!payment.next_execution_date) return false;
  const nextDate = new Date(payment.next_execution_date);
  const checkDate = new Date(dateStr);

  if (payment.frequency === 'daily') return true;
  if (payment.frequency === 'weekly') {
    return nextDate.getDay() === checkDate.getDay();
  }
  if (payment.frequency === 'monthly') {
    return nextDate.getDate() === checkDate.getDate();
  }
  return payment.next_execution_date === dateStr;
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

// ==================== СЕЗОННО-ТРЕНДОВАЯ МОДЕЛЬ ====================
//
// buildSeasonalTrendModel(dailyRows, historyDays) -> {
//   slope, intercept,            // линейный тренд по дневному net (МНК)
//   weekdayFactor[7],            // аддитивная сезонность по дню недели
//   monthdayFactor{1..31},       // аддитивная сезонность по дню месяца
//   residualStd,                 // std остатков (модель vs факт) -> коридор
//   samples, avgIncome, avgExpense, originIndex
// }
//
// Идея: net(t) ≈ intercept + slope*t + weekdayFactor[dow] + monthdayFactor[dom].
// Сезонные факторы — отклонения средних по группе от общего среднего.
function buildSeasonalTrendModel(dailyRows, historyDays) {
  const model = {
    slope: 0,
    intercept: 0,
    weekdayFactor: new Array(7).fill(0),
    monthdayFactor: {},
    residualStd: 0,
    samples: 0,
    avgIncome: 0,
    avgExpense: 0,
    originIndex: 0
  };

  if (!Array.isArray(dailyRows) || dailyRows.length === 0) {
    return model;
  }

  // Опорная дата = сегодня; индекс дня = смещение в днях (отрицательное в прошлом).
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const points = dailyRows.map((r) => {
    const d = new Date(r.date);
    d.setHours(0, 0, 0, 0);
    const dayIndex = Math.round((d - today) / (1000 * 60 * 60 * 24)); // <= 0
    const income = Number(r.income) || 0;
    const expense = Number(r.expense) || 0;
    return {
      t: dayIndex,
      net: income - expense,
      income,
      expense,
      dow: d.getDay(),
      dom: d.getDate()
    };
  });

  model.samples = points.length;
  model.avgIncome = mean(points.map((p) => p.income));
  model.avgExpense = mean(points.map((p) => p.expense));

  // --- линейный тренд по net через МНК (x = t, y = net) ---
  const n = points.length;
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.net);
  const meanX = mean(xs);
  const meanY = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) * (xs[i] - meanX);
  }
  model.slope = den !== 0 ? num / den : 0;
  model.intercept = meanY - model.slope * meanX;

  // --- детренд: остаток = net - (intercept + slope*t) ---
  const detrended = points.map((p) => ({
    ...p,
    resid: p.net - (model.intercept + model.slope * p.t)
  }));
  const grandMeanResid = mean(detrended.map((p) => p.resid));

  // --- сезонность по дню недели (аддитивные отклонения) ---
  for (let dow = 0; dow < 7; dow++) {
    const grp = detrended.filter((p) => p.dow === dow);
    model.weekdayFactor[dow] = grp.length ? mean(grp.map((p) => p.resid)) - grandMeanResid : 0;
  }

  // --- сезонность по дню месяца ---
  for (let dom = 1; dom <= 31; dom++) {
    const grp = detrended.filter((p) => p.dom === dom);
    model.monthdayFactor[dom] = grp.length ? mean(grp.map((p) => p.resid)) - grandMeanResid : 0;
  }

  // --- остатки модели (для доверительного коридора) ---
  const residuals = detrended.map((p) => {
    const fitted =
      model.intercept +
      model.slope * p.t +
      grandMeanResid +
      model.weekdayFactor[p.dow] +
      (model.monthdayFactor[p.dom] || 0);
    return p.net - fitted;
  });
  model._grandMeanResid = grandMeanResid;
  model.residualStd = stdDevLocal(residuals);

  return model;
}

// Прогноз дневного net на step дней вперёд (step >= 0; 0 = сегодня).
function predictNet(model, step) {
  const t = step; // опора в today => индекс будущего дня = +step
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + step);
  const dow = date.getDay();
  const dom = date.getDate();

  const val =
    model.intercept +
    model.slope * t +
    (model._grandMeanResid || 0) +
    (model.weekdayFactor[dow] || 0) +
    (model.monthdayFactor[dom] || 0);

  return Number.isFinite(val) ? val : 0;
}

// Локальные стат-помощники (форкаст не тянет anomalyService).
function mean(nums) {
  if (!nums || !nums.length) return 0;
  return nums.reduce((a, b) => a + (Number(b) || 0), 0) / nums.length;
}
function stdDevLocal(nums) {
  const n = nums ? nums.length : 0;
  if (n < 2) return 0;
  const m = mean(nums);
  const variance = nums.reduce((acc, x) => acc + Math.pow((Number(x) || 0) - m, 2), 0) / (n - 1);
  return Math.sqrt(variance);
}

module.exports = router;
