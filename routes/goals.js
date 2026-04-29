// ==================== МАРШРУТЫ ЦЕЛЕЙ НАКОПЛЕНИЯ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const SavingsGoal = require('../models/savingsGoal');

// Все маршруты требуют аутентификации
const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить все цели пользователя
router.get('/', async (req, res) => {
  try {
    const includeCompleted = req.query.includeCompleted === 'true';
    const goals = await SavingsGoal.findByUser(req.user.id, includeCompleted);
    const goalsWithProgress = goals.map(g => SavingsGoal.calculateProgress ? SavingsGoal.calculateProgress(g) : g);
    res.json(goalsWithProgress);
  } catch (error) {
    console.error('Ошибка получения целей:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Stats
router.get('/stats', async (req, res) => {
  try {
    const goals = await SavingsGoal.findByUser(req.user.id, false);
    const activeGoals = goals.length;
    const totalSaved = goals.reduce((s, g) => s + (parseFloat(g.current_amount) || 0), 0);
    const totalTarget = goals.reduce((s, g) => s + (parseFloat(g.target_amount) || 0), 0);
    const overallProgress = totalTarget > 0 ? Math.round((totalSaved / totalTarget) * 100) : 0;
    res.json({ activeGoals, totalSaved, totalTarget, overallProgress });
  } catch (error) {
    console.error('Goals stats error:', error);
    res.status(500).json({ activeGoals: 0, totalSaved: 0, totalTarget: 0, overallProgress: 0 });
  }
});

// Получить цель по ID
router.get('/:id', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Цель не найдена' });
    }
    res.json(SavingsGoal.calculateProgress ? SavingsGoal.calculateProgress(goal) : goal);
  } catch (error) {
    console.error('Ошибка получения цели:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Создать цель
router.post('/', async (req, res) => {
  try {
    const { name, description, target_amount, currency, target_date, category, icon, color } = req.body;
    
    if (!name || !target_amount) {
      return res.status(400).json({ message: 'Название и целевая сумма обязательны' });
    }

    const goal = await SavingsGoal.create({
      user_id: req.user.id,
      name, description, target_amount, currency, target_date, category, icon, color
    });

    res.status(201).json(goal);
  } catch (error) {
    console.error('Ошибка создания цели:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Обновить цель
router.put('/:id', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Цель не найдена' });
    }

    const updated = await SavingsGoal.update(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка обновления цели:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Добавить пополнение
router.post('/:id/contribute', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Цель не найдена' });
    }

    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Сумма должна быть положительной' });
    }

    const updated = await SavingsGoal.addContribution(req.params.id, amount, note);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка пополнения:', error);
    res.status(500).json({ message: error.message || 'Ошибка сервера' });
  }
});

// Снять средства
router.post('/:id/withdraw', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Цель не найдена' });
    }

    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Сумма должна быть положительной' });
    }

    const updated = await SavingsGoal.withdraw(req.params.id, amount, note);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка снятия:', error);
    res.status(500).json({ message: error.message || 'Ошибка сервера' });
  }
});

// Получить историю пополнений
router.get('/:id/contributions', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Цель не найдена' });
    }

    const contributions = await SavingsGoal.getContributions(req.params.id);
    res.json(contributions);
  } catch (error) {
    console.error('Ошибка получения истории:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Удалить цель
router.delete('/:id', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Цель не найдена' });
    }

    await SavingsGoal.delete(req.params.id);
    res.json({ message: 'Цель удалена' });
  } catch (error) {
    console.error('Ошибка удаления цели:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
