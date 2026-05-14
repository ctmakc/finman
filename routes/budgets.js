const express = require('express');
const passport = require('passport');
const Budget = require('../models/budget');

const router = express.Router();

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// Получение всех бюджетов пользователя
router.get('/', authenticate, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const budgets = await Budget.findByUserId(req.user.id, includeInactive);

    res.json(budgets);
  } catch (error) {
    console.error('Failed to get budgets:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get budgets'
    });
  }
});

// Получение статистики по бюджетам
router.get('/stats', authenticate, async (req, res) => {
  try {
    // Сначала пересчитаем потраченное
    await Budget.recalculateSpent(req.user.id);

    const stats = await Budget.getStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching budget stats:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get stats'
    });
  }
});

// Получение активных бюджетов
router.get('/active', authenticate, async (req, res) => {
  try {
    // Пересчитываем потраченное перед выдачей
    await Budget.recalculateSpent(req.user.id);

    const budgets = await Budget.getActiveBudgets(req.user.id);
    res.json(budgets);
  } catch (error) {
    console.error('Error fetching active budgets:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get active budgets'
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
      message: 'Failed to get budget'
    });
  }
});

// Создание бюджета
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, category, amount, period, startDate, endDate, currency, notifyAtPercent } = req.body;

    // Валидация
    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Budget name is required' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: true, message: 'Budget amount must be positive' });
    }

    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
    if (period && !validPeriods.includes(period)) {
      return res.status(400).json({ error: true, message: 'Invalid period' });
    }

    // Устанавливаем дату начала если не указана
    const budgetStartDate = startDate || new Date().toISOString().split('T')[0];

    const budget = await Budget.create({
      userId: req.user.id,
      name: name.trim(),
      category: category?.trim() || null,
      amount: parseFloat(amount),
      period: period || 'monthly',
      startDate: budgetStartDate,
      endDate: endDate || null,
      currency: currency || 'UAH',
      notifyAtPercent: notifyAtPercent || 80
    });

    res.status(201).json({
      success: true,
      budget
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
    const { name, category, amount, period, startDate, endDate, currency, notifyAtPercent, isActive } = req.body;

    // Проверка существования
    const existingBudget = await Budget.findById(id, req.user.id);
    if (!existingBudget) {
      return res.status(404).json({ error: true, message: 'Budget not found' });
    }

    // Валидация суммы
    if (amount !== undefined && amount <= 0) {
      return res.status(400).json({ error: true, message: 'Budget amount must be positive' });
    }

    const updated = await Budget.update(id, req.user.id, {
      name: name?.trim(),
      category: category?.trim(),
      amount: amount ? parseFloat(amount) : undefined,
      period,
      startDate,
      endDate,
      currency,
      notifyAtPercent,
      isActive
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

    await Budget.recalculateSpent(req.user.id, budget.category);

    const updatedBudget = await Budget.findById(id, req.user.id);

    res.json({
      success: true,
      budget: updatedBudget
    });
  } catch (error) {
    console.error('Error recalculating budget:', error);
    res.status(500).json({
      error: true,
      message: 'An error occurred recalculating budget'
    });
  }
});

// Пересчет всех бюджетов
router.post('/recalculate-all', authenticate, async (req, res) => {
  try {
    await Budget.recalculateSpent(req.user.id);

    const budgets = await Budget.getActiveBudgets(req.user.id);

    res.json({
      success: true,
      budgets
    });
  } catch (error) {
    console.error('Error recalculating budgets:', error);
    res.status(500).json({
      error: true,
      message: 'An error occurred recalculating budgets'
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
