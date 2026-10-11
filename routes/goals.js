// ==================== МАРШРУТЫ ЦЕЛЕЙ НАКОПЛЕНИЯ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const SavingsGoal = require('../models/savingsGoal');
const { todayISO, userTz } = require('../lib/dates');
const { normalizeBody, missingFields, missingFieldsMessage } = require('../lib/bodyFields');

// Body fields accepted in snake_case or camelCase (public API docs vs PWA).
const GOAL_FIELDS = {
  name: [],
  description: [],
  target_amount: ['targetAmount', 'target', 'goalAmount'],
  current_amount: ['currentAmount', 'saved'],
  currency: [],
  target_date: ['targetDate', 'deadline'],
  category: [],
  icon: [],
  color: [],
  is_active: ['isActive'],
};
const GOAL_REQUIRED = ['name', 'target_amount'];

function parseAmount(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Все маршруты требуют аутентификации
const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Получить все цели пользователя
router.get('/', async (req, res) => {
  try {
    const includeCompleted = req.query.includeCompleted === 'true';
    const goals = await SavingsGoal.findByUser(req.user.id, includeCompleted);
    const today = todayISO(userTz(req.user));
    res.json(goals.map(g => SavingsGoal.calculateProgress(g, today)));
  } catch (error) {
    console.error('Error fetching goals:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить статистику
router.get('/stats', async (req, res) => {
  try {
    const stats = await SavingsGoal.getUserStats(req.user.id, todayISO(userTz(req.user)));
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить цель по ID
router.get('/:id', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Goal not found' });
    }
    res.json(SavingsGoal.calculateProgress(goal, todayISO(userTz(req.user))));
  } catch (error) {
    console.error('Error fetching goal:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a goal. Accepts snake_case and camelCase bodies.
router.post('/', async (req, res) => {
  try {
    const data = normalizeBody(req.body, GOAL_FIELDS);
    const missing = missingFields(data, GOAL_REQUIRED);
    if (missing.length) {
      return res.status(400).json({ message: missingFieldsMessage(missing), missing });
    }
    const target = parseAmount(data.target_amount);
    if (!(target > 0)) {
      return res.status(400).json({ message: 'target_amount must be a positive number' });
    }
    const current = data.current_amount === undefined ? undefined : parseAmount(data.current_amount);
    if (current !== undefined && !(current >= 0)) {
      return res.status(400).json({ message: 'current_amount must be a non-negative number' });
    }

    const goal = await SavingsGoal.create({
      user_id: req.user.id,
      name: data.name,
      description: data.description,
      target_amount: target,
      current_amount: current,
      currency: data.currency,
      target_date: data.target_date,
      category: data.category,
      icon: data.icon,
      color: data.color
    });

    res.status(201).json(goal);
  } catch (error) {
    console.error('Error creating goal:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Обновить цель
router.put('/:id', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Goal not found' });
    }

    const updated = await SavingsGoal.update(req.params.id, normalizeBody(req.body, GOAL_FIELDS));
    res.json(updated);
  } catch (error) {
    console.error('Error updating goal:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Добавить пополнение
router.post('/:id/contribute', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Goal not found' });
    }

    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Amount must be positive' });
    }

    const updated = await SavingsGoal.addContribution(req.params.id, amount, note);
    res.json(updated);
  } catch (error) {
    console.error('Contribution error:', error);
    if (error && error.status && error.status < 500) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    if (error && /^(Insufficient funds|Amount must be positive)$/.test(error.message)) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Снять средства
router.post('/:id/withdraw', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Goal not found' });
    }

    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Amount must be positive' });
    }

    const updated = await SavingsGoal.withdraw(req.params.id, amount, note);
    res.json(updated);
  } catch (error) {
    console.error('Withdrawal error:', error);
    if (error && error.status && error.status < 500) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    if (error && /^(Insufficient funds|Amount must be positive)$/.test(error.message)) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить историю пополнений
router.get('/:id/contributions', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Goal not found' });
    }

    const contributions = await SavingsGoal.getContributions(req.params.id);
    res.json(contributions);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Удалить цель
router.delete('/:id', async (req, res) => {
  try {
    const goal = await SavingsGoal.findById(req.params.id);
    if (!goal || goal.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Goal not found' });
    }

    await SavingsGoal.delete(req.params.id);
    res.json({ message: 'Goal deleted' });
  } catch (error) {
    console.error('Error deleting goal:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
