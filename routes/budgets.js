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
      message: 'Произошла ошибка при получении бюджетов'
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
    console.error('Error при получении статистики бюджетов:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при получении статистики'
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
    console.error('Error при получении активных бюджетов:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при получении активных бюджетов'
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
        message: 'Бюджет не найден'
      });
    }

    res.json(budget);
  } catch (error) {
    console.error('Error при получении бюджета:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при получении бюджета'
    });
  }
});

// Создание бюджета
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, category, amount, period, startDate, endDate, currency, notifyAtPercent } = req.body;

    // Валидация
    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Название бюджета обязательно' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: true, message: 'Сумма бюджета должна быть положительной' });
    }

    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
    if (period && !validPeriods.includes(period)) {
      return res.status(400).json({ error: true, message: 'Некорректный период' });
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
    console.error('Error при создании бюджета:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при создании бюджета'
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
      return res.status(404).json({ error: true, message: 'Бюджет не найден' });
    }

    // Валидация суммы
    if (amount !== undefined && amount <= 0) {
      return res.status(400).json({ error: true, message: 'Сумма бюджета должна быть положительной' });
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
      res.status(400).json({ error: true, message: 'Не удалось обновить бюджет' });
    }
  } catch (error) {
    console.error('Error при обновлении бюджета:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при обновлении бюджета'
    });
  }
});

// Пересчет потраченного для бюджета
router.post('/:id/recalculate', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const budget = await Budget.findById(id, req.user.id);
    if (!budget) {
      return res.status(404).json({ error: true, message: 'Бюджет не найден' });
    }

    await Budget.recalculateSpent(req.user.id, budget.category);

    const updatedBudget = await Budget.findById(id, req.user.id);

    res.json({
      success: true,
      budget: updatedBudget
    });
  } catch (error) {
    console.error('Error при пересчете бюджета:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при пересчете бюджета'
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
    console.error('Error при пересчете бюджетов:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при пересчете бюджетов'
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
      return res.status(404).json({ error: true, message: 'Бюджет не найден' });
    }

    const deleted = hardDelete
      ? await Budget.hardDelete(id, req.user.id)
      : await Budget.delete(id, req.user.id);

    if (deleted) {
      res.json({ success: true, message: 'Бюджет удален' });
    } else {
      res.status(400).json({ error: true, message: 'Не удалось удалить бюджет' });
    }
  } catch (error) {
    console.error('Error при удалении бюджета:', error);
    res.status(500).json({
      error: true,
      message: 'Произошла ошибка при удалении бюджета'
    });
  }
});

module.exports = router;
