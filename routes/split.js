// ==================== МАРШРУТЫ СПЛИТА РАСХОДОВ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Split = require('../models/split');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// ==================== ГРУППЫ ====================

// Получить группы пользователя
router.get('/groups', async (req, res) => {
  try {
    const groups = await Split.findGroupsByUser(req.user.id);
    res.json(groups);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Статистика пользователя
router.get('/stats', async (req, res) => {
  try {
    res.json({ theyOweMe: 0, iOwe: 0, balance: 0, groupCount: 0 });
  } catch (e) {
    res.status(500).json({ theyOweMe: 0, iOwe: 0, balance: 0, groupCount: 0 });
  }
});;

// Получить группу по ID
router.get('/groups/:id', async (req, res) => {
  try {
    const group = await Split.findGroupById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: 'Группа не найдена' });
    }
    res.json(group);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Статистика группы
router.get('/groups/:id/stats', async (req, res) => {
  try {
    const stats = await Split.getGroupStats(req.params.id);
    res.json(stats);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Создать группу
router.post('/groups', async (req, res) => {
  try {
    const { name, description, currency, creator_name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Название обязательно' });
    }

    const group = await Split.createGroup({
      user_id: req.user.id,
      name, description, currency, creator_name
    });

    res.status(201).json(group);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Обновить группу
router.put('/groups/:id', async (req, res) => {
  try {
    const group = await Split.findGroupById(req.params.id);
    if (!group || group.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Группа не найдена' });
    }

    const updated = await Split.updateGroup(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ==================== УЧАСТНИКИ ====================

// Получить участников
router.get('/groups/:id/members', async (req, res) => {
  try {
    const members = await Split.getMembers(req.params.id);
    res.json(members);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Добавить участника
router.post('/groups/:id/members', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Имя обязательно' });
    }

    const member = await Split.addMember(req.params.id, { name, email, is_registered: false });
    res.status(201).json(member);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Удалить участника
router.delete('/members/:id', async (req, res) => {
  try {
    await Split.removeMember(req.params.id);
    res.json({ message: 'Участник удалён' });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ==================== РАСХОДЫ ====================

// Получить расходы группы
router.get('/groups/:id/expenses', async (req, res) => {
  try {
    const expenses = await Split.getExpenses(req.params.id);
    res.json(expenses);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Добавить расход
router.post('/groups/:id/expenses', async (req, res) => {
  try {
    const { paid_by, description, amount, split_type, date, category, shares } = req.body;
    
    if (!paid_by || !description || !amount) {
      return res.status(400).json({ message: 'Заполните обязательные поля' });
    }

    const expense = await Split.addExpense({
      group_id: req.params.id,
      paid_by, description, amount, split_type, date, category, shares
    });

    res.status(201).json(expense);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Удалить расход
router.delete('/expenses/:id', async (req, res) => {
  try {
    await Split.deleteExpense(req.params.id);
    res.json({ message: 'Расход удалён' });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ==================== БАЛАНСЫ И РАСЧЁТЫ ====================

// Получить балансы
router.get('/groups/:id/balances', async (req, res) => {
  try {
    const balances = await Split.calculateBalances(req.params.id);
    res.json(balances);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Получить рекомендуемые переводы
router.get('/groups/:id/settlements/suggested', async (req, res) => {
  try {
    const settlements = await Split.calculateSettlements(req.params.id);
    res.json(settlements);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Записать взаиморасчёт
router.post('/groups/:id/settlements', async (req, res) => {
  try {
    const { from_member, to_member, amount, date, note } = req.body;
    
    if (!from_member || !to_member || !amount) {
      return res.status(400).json({ message: 'Заполните обязательные поля' });
    }

    const settlement = await Split.addSettlement({
      group_id: req.params.id,
      from_member, to_member, amount, date, note
    });

    res.status(201).json(settlement);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Получить историю взаиморасчётов
router.get('/groups/:id/settlements', async (req, res) => {
  try {
    const settlements = await Split.getSettlements(req.params.id);
    res.json(settlements);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
