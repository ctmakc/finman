const express = require('express');
const passport = require('passport');
const Budget = require('../models/budget');
const dates = require('../lib/dates');

const router = express.Router();
const { defaultCurrency: DEFAULT_CURRENCY } = require('../config/config');

const VALID_PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
// Same rule as accounts/subscriptions: the code is rendered by the UI and fed
// to Intl, so only ISO-like letter codes are accepted ('US$' is not).
const CURRENCY_CODE = /^[A-Za-z]{3,5}$/;

// A money field from the body as a finite number, or NaN. Number('') is 0 and
// Number(true) is 1, so only numbers and numeric strings are accepted.
function toMoneyNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

// Validates amount/carryover/period/currency. Returns an error message or null.
// partial=true (PUT): absent fields are not required.
function validateBudgetBody(body, partial) {
  const { amount, carryover, period, currency } = body;
  if (!partial || amount !== undefined) {
    const n = toMoneyNumber(amount);
    if (!Number.isFinite(n) || n <= 0) return 'Budget amount must be positive';
  }
  if (carryover !== undefined && carryover !== null && carryover !== '' && !Number.isFinite(toMoneyNumber(carryover))) {
    return 'Carryover must be a number';
  }
  if (period !== undefined && period !== null && !VALID_PERIODS.includes(period)) {
    return 'Invalid period';
  }
  if (currency !== undefined && currency !== null && currency !== '' && !CURRENCY_CODE.test(String(currency))) {
    return 'Currency must be a 3-5 letter code, e.g. CAD';
  }
  return null;
}

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Получение всех бюджетов пользователя
router.get('/', authenticate, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const budgets = await Budget.findByUserId(req.user.id, includeInactive);

    // Конверт-бюджеты: отдаём rollover (bool), carryover и effectiveLimit (amount+carryover).
    const enriched = budgets.map((b) => {
      const carryover = b.carryover || 0;
      return {
        ...b,
        rollover: !!b.rollover,
        carryover,
        effectiveLimit: Math.round(((b.amount || 0) + carryover) * 100) / 100,
      };
    });
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching budgets:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch budgets'
    });
  }
});

// Получение статистики по бюджетам
router.get('/stats', authenticate, async (req, res) => {
  try {
    // Сначала пересчитаем потраченное
    await Budget.recalculateSpent(req.user.id, null, dates.todayISO(dates.userTz(req.user)));

    const stats = await Budget.getStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching budget stats:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch statistics'
    });
  }
});

// Получение активных бюджетов
router.get('/active', authenticate, async (req, res) => {
  try {
    // Пересчитываем потраченное перед выдачей
    const today = dates.todayISO(dates.userTz(req.user));
    await Budget.recalculateSpent(req.user.id, null, today);

    const budgets = await Budget.getActiveBudgets(req.user.id, today);
    res.json(budgets);
  } catch (error) {
    console.error('Error fetching active budgets:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch active budgets'
    });
  }
});

// Получение бюджета по ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const budget = await Budget.findById(req.params.id, req.user.id);

    if (!budget) {
      return res.status(404).json({
        error: true,
        message: 'Budget not found'
      });
    }

    res.json(budget);
  } catch (error) {
    console.error('Error fetching budget:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch budget'
    });
  }
});

// Создание бюджета
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, category, amount, period, startDate, endDate, currency, notifyAtPercent, rollover, carryover } = req.body;

    // Валидация
    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Budget name is required' });
    }
    const invalid = validateBudgetBody(req.body, false);
    if (invalid) {
      return res.status(400).json({ error: true, message: invalid });
    }

    // Устанавливаем дату начала если не указана
    const budgetStartDate = startDate || dates.todayISO(dates.userTz(req.user));

    const budget = await Budget.create({
      userId: req.user.id,
      name: name.trim(),
      category: category?.trim() || null,
      amount: toMoneyNumber(amount),
      period: period || 'monthly',
      startDate: budgetStartDate,
      endDate: endDate || null,
      currency: currency ? String(currency).toUpperCase() : DEFAULT_CURRENCY,
      notifyAtPercent: notifyAtPercent || 80,
      rollover: rollover ? true : false,
      carryover: carryover !== undefined && carryover !== null && carryover !== '' ? toMoneyNumber(carryover) : 0
    });

    const carryoverVal = budget.carryover || 0;
    res.status(201).json({
      success: true,
      budget: {
        ...budget,
        rollover: !!budget.rollover,
        carryover: carryoverVal,
        effectiveLimit: Math.round(((budget.amount || 0) + carryoverVal) * 100) / 100,
      }
    });
  } catch (error) {
    console.error('Error creating budget:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to create budget'
    });
  }
});

// Обновление бюджета
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, amount, period, startDate, endDate, currency, notifyAtPercent, isActive, rollover, carryover } = req.body;

    // Проверка существования
    const existingBudget = await Budget.findById(id, req.user.id);
    if (!existingBudget) {
      return res.status(404).json({ error: true, message: 'Budget not found' });
    }

    // Валидация суммы/переноса/периода/валюты
    const invalid = validateBudgetBody(req.body, true);
    if (invalid) {
      return res.status(400).json({ error: true, message: invalid });
    }

    const updated = await Budget.update(id, req.user.id, {
      name: name?.trim(),
      category: category?.trim(),
      amount: amount !== undefined ? toMoneyNumber(amount) : undefined,
      period,
      startDate,
      endDate,
      currency: currency ? String(currency).toUpperCase() : currency,
      notifyAtPercent,
      isActive,
      rollover: rollover !== undefined ? (rollover ? true : false) : undefined,
      // null/'' resets the carryover to 0 (as before); a number sets it.
      carryover: carryover === undefined ? undefined : (carryover === null || carryover === '' ? 0 : toMoneyNumber(carryover))
    });

    if (updated) {
      const budget = await Budget.findById(id, req.user.id);
      res.json({ success: true, budget });
    } else {
      res.status(400).json({ error: true, message: 'Failed to update budget' });
    }
  } catch (error) {
    console.error('Error updating budget:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to update budget'
    });
  }
});

// Пересчет потраченного для бюджета
router.post('/:id/recalculate', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const budget = await Budget.findById(id, req.user.id);
    if (!budget) {
      return res.status(404).json({ error: true, message: 'Budget not found' });
    }

    await Budget.recalculateSpent(req.user.id, budget.category, dates.todayISO(dates.userTz(req.user)));

    const updatedBudget = await Budget.findById(id, req.user.id);

    res.json({
      success: true,
      budget: updatedBudget
    });
  } catch (error) {
    console.error('Error recalculating budget:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to recalculate budget'
    });
  }
});

// Пересчет всех бюджетов
router.post('/recalculate-all', authenticate, async (req, res) => {
  try {
    const today = dates.todayISO(dates.userTz(req.user));
    await Budget.recalculateSpent(req.user.id, null, today);

    const budgets = await Budget.getActiveBudgets(req.user.id, today);

    res.json({
      success: true,
      budgets
    });
  } catch (error) {
    console.error('Error recalculating budgets:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to recalculate budgets'
    });
  }
});

// Перенос остатка (envelope/rollover) в carryover следующего периода.
// body: { period } — какой период переносим (по умолчанию monthly).
router.post('/roll-forward', authenticate, async (req, res) => {
  try {
    const fromPeriod = req.body.period || 'monthly';

    if (!VALID_PERIODS.includes(fromPeriod)) {
      return res.status(400).json({ error: true, message: 'Invalid period' });
    }

    // Закрывается ПРЕДЫДУЩИЙ период (по дню пользователя), остаток считается
    // по его транзакциям; повторный вызов в том же периоде ничего не меняет
    // (budgets.last_rolled_period). spent после переноса — текущий период.
    const today = dates.todayISO(dates.userTz(req.user));
    const rolled = await Budget.rollForward(req.user.id, fromPeriod, { today });
    await Budget.recalculateSpent(req.user.id, null, today);
    const budgets = await Budget.getActiveBudgets(req.user.id, today);

    res.json({
      success: true,
      rolledCount: rolled.length,
      rolled,
      budgets
    });
  } catch (error) {
    console.error('Error rolling over budgets:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to roll over budgets'
    });
  }
});

// Удаление бюджета (деактивация)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const hardDelete = req.query.hard === 'true';

    const existingBudget = await Budget.findById(id, req.user.id);
    if (!existingBudget) {
      return res.status(404).json({ error: true, message: 'Budget not found' });
    }

    const deleted = hardDelete
      ? await Budget.hardDelete(id, req.user.id)
      : await Budget.delete(id, req.user.id);

    if (deleted) {
      res.json({ success: true, message: 'Budget deleted' });
    } else {
      res.status(400).json({ error: true, message: 'Failed to delete budget' });
    }
  } catch (error) {
    console.error('Error deleting budget:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to delete budget'
    });
  }
});

module.exports = router;
