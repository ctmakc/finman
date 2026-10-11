// ==================== МАРШРУТЫ СПЛИТА РАСХОДОВ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const Split = require('../models/split');
const { get } = require('../db/database');
const money = require('../lib/money');
const dates = require('../lib/dates');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// ---- Guards владения (закрывают IDOR на всех :id-роутах) ----
// :id = id группы -> грузим группу и сверяем владельца.
async function ownGroup(req, res, next) {
  try {
    const group = await Split.findGroupById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (Number(group.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ message: 'No access to this group' });
    }
    req.group = group;
    next();
  } catch (error) {
    console.error('ownGroup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
}

// :id = id участника -> участник -> его группа -> владелец.
async function ownMember(req, res, next) {
  try {
    const member = await get('SELECT group_id FROM split_members WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    const group = await Split.findGroupById(member.group_id);
    if (!group || Number(group.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    next();
  } catch (error) {
    console.error('ownMember error:', error);
    res.status(500).json({ message: 'Server error' });
  }
}

// :id = id расхода -> расход -> его группа -> владелец.
async function ownExpense(req, res, next) {
  try {
    const expense = await get('SELECT group_id FROM split_expenses WHERE id = ?', [req.params.id]);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });
    const group = await Split.findGroupById(expense.group_id);
    if (!group || Number(group.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    next();
  } catch (error) {
    console.error('ownExpense error:', error);
    res.status(500).json({ message: 'Server error' });
  }
}

// ==================== ГРУППЫ ====================

// Получить группы пользователя
router.get('/groups', async (req, res) => {
  try {
    const groups = await Split.findGroupsByUser(req.user.id);
    res.json(groups);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Статистика пользователя
router.get('/stats', async (req, res) => {
  try {
    const stats = await Split.getUserStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить группу по ID
router.get('/groups/:id', ownGroup, async (req, res) => {
  try {
    res.json(req.group);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Статистика группы
router.get('/groups/:id/stats', ownGroup, async (req, res) => {
  try {
    const stats = await Split.getGroupStats(req.params.id);
    res.json(stats);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Создать группу
router.post('/groups', async (req, res) => {
  try {
    const { name, description, currency, creator_name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const group = await Split.createGroup({
      user_id: req.user.id,
      name, description, currency, creator_name
    });

    res.status(201).json(group);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Обновить группу
router.put('/groups/:id', ownGroup, async (req, res) => {
  try {
    const updated = await Split.updateGroup(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== УЧАСТНИКИ ====================

// Получить участников
router.get('/groups/:id/members', ownGroup, async (req, res) => {
  try {
    const members = await Split.getMembers(req.params.id);
    res.json(members);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Добавить участника
router.post('/groups/:id/members', ownGroup, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const member = await Split.addMember(req.params.id, { name, email, is_registered: false });
    res.status(201).json(member);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Удалить участника
router.delete('/members/:id', ownMember, async (req, res) => {
  try {
    await Split.removeMember(req.params.id);
    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== РАСХОДЫ ====================

// Получить расходы группы
router.get('/groups/:id/expenses', ownGroup, async (req, res) => {
  try {
    const expenses = await Split.getExpenses(req.params.id);
    res.json(expenses);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Все id участников из тела запроса должны принадлежать этой группе:
// иначе в расход/взаиморасчёт попадали участники чужих групп (и их имена
// потом возвращались в списке расходов).
async function membersOfGroup(groupId, ids) {
  const members = await Split.getMembers(groupId);
  const own = new Set(members.map((m) => String(m.id)));
  return ids.every((id) => own.has(String(id)));
}

// Добавить расход
router.post('/groups/:id/expenses', ownGroup, async (req, res) => {
  try {
    const { paid_by, description, amount, split_type, date, category, shares } = req.body;

    if (!paid_by || !description || !amount) {
      return res.status(400).json({ message: 'Please fill in the required fields' });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ message: 'Amount must be positive' });
    }
    const shareIds = Array.isArray(shares) ? shares.map((s) => s && s.member_id) : [];
    if (!(await membersOfGroup(req.params.id, [paid_by, ...shareIds]))) {
      return res.status(400).json({ message: 'Unknown group member' });
    }
    if (split_type === 'custom') {
      const total = Array.isArray(shares) ? money.add(...shares.map((s) => money.round(Number(s.amount) || 0)), 0) : 0;
      if (!Array.isArray(shares) || shares.length === 0 || total !== money.round(Number(amount))) {
        return res.status(400).json({ message: 'Custom shares must add up to the expense amount' });
      }
    }

    const expense = await Split.addExpense({
      group_id: req.params.id,
      paid_by, description, amount, split_type, category, shares,
      // date NOT NULL: без даты был 500.
      date: date || dates.todayISO(dates.userTz(req.user)),
    });

    res.status(201).json(expense);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Удалить расход
router.delete('/expenses/:id', ownExpense, async (req, res) => {
  try {
    await Split.deleteExpense(req.params.id);
    res.json({ message: 'Expense deleted' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== БАЛАНСЫ И РАСЧЁТЫ ====================

// Получить балансы
router.get('/groups/:id/balances', ownGroup, async (req, res) => {
  try {
    const balances = await Split.calculateBalances(req.params.id);
    res.json(balances);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить рекомендуемые переводы
router.get('/groups/:id/settlements/suggested', ownGroup, async (req, res) => {
  try {
    const settlements = await Split.calculateSettlements(req.params.id);
    res.json(settlements);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Записать взаиморасчёт
router.post('/groups/:id/settlements', ownGroup, async (req, res) => {
  try {
    const { from_member, to_member, amount, date, note } = req.body;

    if (!from_member || !to_member || !amount) {
      return res.status(400).json({ message: 'Please fill in the required fields' });
    }
    if (!(Number(amount) > 0) || String(from_member) === String(to_member)) {
      return res.status(400).json({ message: 'Invalid settlement' });
    }
    if (!(await membersOfGroup(req.params.id, [from_member, to_member]))) {
      return res.status(400).json({ message: 'Unknown group member' });
    }

    const settlement = await Split.addSettlement({
      group_id: req.params.id,
      from_member, to_member, amount, date, note
    });

    res.status(201).json(settlement);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Получить историю взаиморасчётов
router.get('/groups/:id/settlements', ownGroup, async (req, res) => {
  try {
    const settlements = await Split.getSettlements(req.params.id);
    res.json(settlements);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
