const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');
const money = require('../lib/money');
const dates = require('../lib/dates');
const { cashflowOnly } = require('../lib/txFilter');
const networthService = require('../services/networthService');

// Фильтр денежного потока (без переводов и начального баланса): иначе
// стартовый баланс счёта выглядит как доход и прогноз даёт «+116.8 % за 30 дней».
const CF = cashflowOnly();

// Процент с защитой от абсурда: |x| <= 999, не-число -> null.
function capPercent(v, max = 999) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-max, Math.min(max, Math.round(n * 10) / 10));
}

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Balance forecast for N days.
//
// Honest projection rules (wave3b):
//   - Only cash flow is used (type income/expense, no transfers, no opening
//     balances — lib/txFilter). Expenses are taken as magnitudes (ABS), so a
//     ledger that stores expenses negative never inflates the balance.
//   - Daily income / expense = totals over the OBSERVED window (first cash-flow
//     day in the last 90 days .. today), never the average of active days only:
//     a one-off salary is spread over the window, not treated as daily income.
//   - The seasonal/trend model is used only with >= 60 days and >= 40
//     transactions (confidence 'high'); its trend is frozen after as many
//     future days as were observed and each day's net is clamped around the
//     flat average, so a short history cannot be extrapolated into +999 %.
//   - confidence.level is 'low' (with a reason) under 30 days or 20
//     transactions, 'medium' under 60 days / 40 transactions, else 'high'.
//   - Scheduled recurring payments and subscriptions are added on their due days.
router.get('/balance', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const horizon = Math.min(365, Math.max(1, parseInt(days) || 30));
    const userId = req.user.id;
    const todayStr = dates.todayISO(dates.userTz(req.user));

    // Current balance across accounts in the user's base currency.
    const currentBalance = await networthService.sumAccountsInBase(userId);
    const startBalance = money.round(currentBalance.total || 0);

    // Training window: the last 90 days of cash flow.
    const HISTORY_DAYS = 90;
    const historyStartStr = dates.addDaysISO(todayStr, -HISTORY_DAYS);

    const dailyRows = await query(
      `SELECT date,
              SUM(CASE WHEN type = 'income'  THEN ABS(amount) ELSE 0 END) AS income,
              SUM(CASE WHEN type = 'expense' THEN ABS(amount) ELSE 0 END) AS expense,
              COUNT(*) AS count
       FROM transactions
       WHERE user_id = ? AND date >= ? AND date <= ?${CF.sql}
       GROUP BY date
       ORDER BY date ASC`,
      [userId, historyStartStr, todayStr, ...CF.params]
    );

    const txCount = dailyRows.reduce((s, r) => s + (Number(r.count) || 0), 0);
    const totalIncome = money.round(dailyRows.reduce((s, r) => s + (Number(r.income) || 0), 0));
    const totalExpense = money.round(dailyRows.reduce((s, r) => s + (Number(r.expense) || 0), 0));
    const firstDate = dailyRows.length ? String(dailyRows[0].date).slice(0, 10) : null;
    const observedDays = firstDate
      ? Math.min(HISTORY_DAYS + 1, Math.max(1, (dates.diffDays(firstDate, todayStr) || 0) + 1))
      : 0;

    // Daily flow over the whole observed window (not only days with activity).
    const dailyIncome = observedDays > 0 ? totalIncome / observedDays : 0;
    const dailyExpense = observedDays > 0 ? totalExpense / observedDays : 0;
    const flatNet = dailyIncome - dailyExpense;

    // Confidence from the amount of history.
    const MIN_DAYS = 30;
    const MIN_TX = 20;
    let level = 'high';
    let reason = null;
    if (txCount === 0) {
      level = 'low';
      reason = 'No cash-flow transactions in the last 90 days; the projection only applies scheduled payments.';
    } else if (observedDays < MIN_DAYS || txCount < MIN_TX) {
      level = 'low';
      reason = `Only ${observedDays} day${observedDays === 1 ? '' : 's'} of history and ${txCount} transaction${txCount === 1 ? '' : 's'} (at least ${MIN_DAYS} days and ${MIN_TX} transactions are needed for a reliable projection).`;
    } else if (observedDays < 60 || txCount < 40) {
      level = 'medium';
      reason = `${observedDays} days of history and ${txCount} transactions; the projection uses the average daily flow without seasonality.`;
    }

    // Scheduled items.
    const recurringPayments = await query(
      `SELECT amount, type, frequency, next_payment_date
       FROM recurring_payments
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );
    for (const p of recurringPayments) {
      p.next_execution_date = p.next_payment_date || p.next_execution_date;
    }
    const subscriptions = await query(
      `SELECT amount, billing_cycle, next_billing_date
       FROM subscriptions
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    // Seasonal/trend model only on solid history.
    const model = buildSeasonalTrendModel(dailyRows, HISTORY_DAYS);
    const haveModel = level === 'high' && model.samples >= 14;
    // Trend is frozen after as many future days as were observed.
    const trendCap = Math.max(1, Math.min(horizon, observedDays));
    // Any modelled day stays within [flat - spread, flat + spread].
    const spread = dailyIncome + dailyExpense;
    const netLo = Math.min(flatNet, 0) - spread;
    const netHi = Math.max(flatNet, 0) + spread;

    // Uncertainty band from the day-to-day variation of the observed window
    // (zero-activity days included), widening with sqrt(step).
    const residualStd = observedDays >= 2 ? dailySeriesStd(dailyRows, firstDate, observedDays) : 0;
    const Z = 1;

    const forecast = [];
    let balance = startBalance;
    for (let i = 0; i <= horizon; i++) {
      const dateStr = dates.addDaysISO(todayStr, i);

      let dayIncome = dailyIncome;
      let dayExpense = dailyExpense;
      if (haveModel) {
        const modeled = predictNet(model, Math.min(i, trendCap));
        const net = Math.max(netLo, Math.min(netHi, modeled));
        dayIncome = Math.max(0, model.avgIncome);
        dayExpense = Math.max(0, model.avgExpense);
        const drift = net - (dayIncome - dayExpense);
        if (drift >= 0) dayIncome += drift;
        else dayExpense += -drift;
      }

      for (const payment of recurringPayments) {
        if (isPaymentDue(payment, dateStr)) {
          const amt = Math.abs(Number(payment.amount) || 0);
          if (payment.type === 'expense') dayExpense += amt;
          else dayIncome += amt;
        }
      }
      for (const sub of subscriptions) {
        if (isSubscriptionDue(sub, dateStr)) {
          dayExpense += Math.abs(Number(sub.amount) || 0);
        }
      }

      if (i > 0) {
        balance = balance + dayIncome - dayExpense;
      }

      const band = money.round(Z * residualStd * Math.sqrt(Math.max(1, i)));
      forecast.push({
        date: dateStr,
        balance: money.round(balance),
        income: money.round(dayIncome),
        expense: money.round(dayExpense),
        balanceLower: money.round(balance - band),
        balanceUpper: money.round(balance + band),
        confidenceBand: band
      });
    }

    const endBalance = forecast[forecast.length - 1].balance;
    const change = money.round(endBalance - startBalance);
    const lowestPoint = Math.min(...forecast.map(f => f.balance));
    const lowestDate = forecast.find(f => f.balance === lowestPoint)?.date;
    const worstCasePoint = Math.min(...forecast.map(f => f.balanceLower));
    const worstCaseDate = forecast.find(f => f.balanceLower === worstCasePoint)?.date;

    res.json({
      forecast,
      summary: {
        currentBalance: startBalance,
        baseCurrency: currentBalance.baseCurrency,
        projectedBalance: endBalance,
        change,
        // Percent of the current balance; meaningless near zero -> null, else |x| <= 999.
        changePercent: Math.abs(startBalance) >= 1 ? capPercent((change / startBalance) * 100) : null,
        lowestPoint,
        lowestDate,
        avgDailyExpense: money.round(dailyExpense),
        avgDailyIncome: money.round(dailyIncome),
        model: haveModel ? 'seasonal_trend' : 'flat_average',
        confidence: {
          level,
          reason,
          residualStd: money.round(residualStd),
          endBand: forecast[forecast.length - 1].confidenceBand,
          projectedLower: forecast[forecast.length - 1].balanceLower,
          projectedUpper: forecast[forecast.length - 1].balanceUpper
        },
        history: {
          observedDays,
          transactionCount: txCount,
          firstDate,
          totalIncome,
          totalExpense,
          windowDays: HISTORY_DAYS
        },
        trendPerDay: haveModel ? money.round(model.slope) : 0,
        trendDaysApplied: haveModel ? trendCap : 0,
        worstCasePoint: money.round(worstCasePoint),
        worstCaseDate
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Expense projection by category: average daily spend over the observed window
// (first cash-flow day in the last 3 months .. today), not per active day.
router.get('/expenses', async (req, res) => {
  try {
    const horizon = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const userId = req.user.id;
    const todayStr = dates.todayISO(dates.userTz(req.user));
    const threeMonthsAgoStr = dates.addMonthsISO(todayStr, -3);

    const first = await get(
      `SELECT MIN(date) AS d FROM transactions
       WHERE user_id = ? AND date >= ? AND date <= ?${CF.sql}`,
      [userId, threeMonthsAgoStr, todayStr, ...CF.params]
    );
    const firstDate = first && first.d ? String(first.d).slice(0, 10) : null;
    const windowDays = firstDate ? Math.max(1, (dates.diffDays(firstDate, todayStr) || 0) + 1) : 0;

    const categoryTotals = await query(
      `SELECT category,
              SUM(ABS(amount)) as total,
              COUNT(*) as count,
              COUNT(DISTINCT date) as days
       FROM transactions
       WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?${CF.sql}
       GROUP BY category
       ORDER BY total DESC`,
      [userId, threeMonthsAgoStr, todayStr, ...CF.params]
    );

    const projections = categoryTotals.map(cat => {
      const dailyAvg = windowDays > 0 ? (Number(cat.total) || 0) / windowDays : 0;
      return {
        category: cat.category || 'Uncategorized',
        total: money.round(cat.total),
        count: cat.count,
        currentMonthly: money.round(dailyAvg * 30),
        projected: money.round(dailyAvg * horizon),
        dailyAvg: money.round(dailyAvg)
      };
    });

    res.json({
      days: horizon,
      observedDays: windowDays,
      confidence: windowDays < 30 ? 'low' : 'medium',
      categories: projections,
      totalProjected: money.round(projections.reduce((s, c) => s + c.projected, 0))
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
    const todayStr = dates.todayISO(dates.userTz(req.user));

    // История пополнений. В goal_contributions нет колонки date — есть created_at.
    const contributions = await query(
      `SELECT date(created_at) as date, amount FROM goal_contributions
       WHERE goal_id = ? ORDER BY created_at`,
      [goal.id]
    );

    const remaining = goal.target_amount - goal.current_amount;

    if (contributions.length < 2) {
      // Недостаточно данных
      const daysToTarget = goal.target_date
        ? dates.diffDays(todayStr, String(goal.target_date).slice(0, 10))
        : null;

      return res.json({
        goal,
        remaining,
        avgContribution: 0,
        projectedDate: null,
        daysToTarget,
        requiredDaily: daysToTarget ? remaining / daysToTarget : null,
        onTrack: null,
        message: 'Not enough data for a projection'
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
    const projectedDate = daysNeeded ? dates.addDaysISO(todayStr, daysNeeded) : null;

    // Проверка, успеваем ли к целевой дате
    let onTrack = null;
    let requiredDaily = null;
    if (goal.target_date) {
      const daysToTarget = dates.diffDays(todayStr, String(goal.target_date).slice(0, 10));
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
    const todayStr = dates.todayISO(dates.userTz(req.user));

    const remaining = debt.amount - debt.paid_amount;

    // История платежей
    // В debt_payments дата платежа — payment_date (колонки date нет).
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
        message: 'Not enough data for a projection'
      });
    }

    // Средний платёж
    const firstDate = new Date(payments[0].date);
    const lastDate = new Date(payments[payments.length - 1].date);
    const daysPassed = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
    const avgDaily = debt.paid_amount / daysPassed;

    const daysNeeded = avgDaily > 0 ? Math.ceil(remaining / avgDaily) : null;
    const projectedDate = daysNeeded ? dates.addDaysISO(todayStr, daysNeeded) : null;

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
    const todayStr = dates.todayISO(dates.userTz(req.user));
    const thisMonthStart = dates.startOfMonthISO(todayStr);

    // Данные за последние 6 месяцев (только денежный поток)
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const start = dates.addMonthsISO(thisMonthStart, -i, 1);
      const end = dates.endOfMonthISO(start);

      const income = await get(
        `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'income' AND date >= ? AND date <= ?${CF.sql}`,
        [userId, start, end, ...CF.params]
      );
      const expense = await get(
        `SELECT SUM(ABS(amount)) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?${CF.sql}`,
        [userId, start, end, ...CF.params]
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
        income: { direction: incomesTrend > 0 ? 'up' : 'down', percent: String(capPercent(Math.abs(incomesTrend)) ?? 0) },
        expense: { direction: expensesTrend > 0 ? 'up' : 'down', percent: String(capPercent(Math.abs(expensesTrend)) ?? 0) },
        savings: { direction: savingsTrend > 0 ? 'up' : 'down', percent: String(capPercent(Math.abs(savingsTrend)) ?? 0) }
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

// Std of the daily net series over the observed window, with zero-activity
// days included (so a quiet week is as informative as a busy one).
function dailySeriesStd(dailyRows, firstDate, observedDays) {
  if (!firstDate || observedDays < 2) return 0;
  const byDate = new Map();
  for (const r of dailyRows) {
    byDate.set(String(r.date).slice(0, 10), (Number(r.income) || 0) - (Number(r.expense) || 0));
  }
  const series = [];
  for (let i = 0; i < observedDays; i++) {
    series.push(byDate.get(dates.addDaysISO(firstDate, i)) || 0);
  }
  return stdDevLocal(series);
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
