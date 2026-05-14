// ==================== МАРШРУТЫ СПЛИТА РАСХОДОВ ====================

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { get: dbGet } = require('../db/database');
const Split = require('../models/split');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Returns true if userId is owner or registered member of groupId; null if group not found
async function canAccessGroup(groupId, userId) {
  const group = await dbGet('SELECT user_id FROM split_groups WHERE id = ?', [groupId]);
  if (!group) return null;
  if (group.user_id === userId) return true;
  const member = await dbGet('SELECT id FROM split_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return !!member;
}

// ==================== ГРУППЫ ====================

router.get('/groups', async (req, res) => {
  try {
    const groups = await Split.findGroupsByUser(req.user.id);
    res.json(groups);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const groups = await Split.findGroupsByUser(req.user.id);
    let totalOwed = 0, totalOwes = 0;

    for (const group of groups) {
      const member = await dbGet(
        'SELECT id FROM split_members WHERE group_id = ? AND user_id = ?',
        [group.id, req.user.id]
      );
      if (!member) continue;
      const balancesObj = await Split.calculateBalances(group.id);
      const userBalance = balancesObj[member.id];
      if (!userBalance) continue;
      if (userBalance.balance > 0) totalOwed += userBalance.balance;
      else totalOwes += Math.abs(userBalance.balance);
    }

    res.json({
      totalOwed: Math.round(totalOwed * 100) / 100,
      totalOwes: Math.round(totalOwes * 100) / 100,
      netBalance: Math.round((totalOwed - totalOwes) * 100) / 100,
      groupCount: groups.length,
    });
  } catch (e) {
    console.error('Split stats error:', e);
    res.json({ totalOwed: 0, totalOwes: 0, netBalance: 0, groupCount: 0 });
  }
});

router.get('/groups/:id', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const group = await Split.findGroupById(req.params.id);
    res.json(group);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/groups/:id/stats', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const stats = await Split.getGroupStats(req.params.id);
    res.json(stats);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/groups', async (req, res) => {
  try {
    const { name, description, currency, creator_name } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const group = await Split.createGroup({ user_id: req.user.id, name, description, currency, creator_name });
    res.status(201).json(group);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/groups/:id', async (req, res) => {
  try {
    const group = await Split.findGroupById(req.params.id);
    if (!group || group.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Group not found' });
    }
    const updated = await Split.updateGroup(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== УЧАСТНИКИ ====================

router.get('/groups/:id/members', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const members = await Split.getMembers(req.params.id);
    res.json(members);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/groups/:id/members', async (req, res) => {
  try {
    const group = await dbGet('SELECT user_id FROM split_groups WHERE id = ?', [req.params.id]);
    if (!group || group.user_id !== req.user.id) {
      return res.status(404).json({ message: 'Group not found' });
    }
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const member = await Split.addMember(req.params.id, { name, email, is_registered: false });
    res.status(201).json(member);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/members/:id', async (req, res) => {
  try {
    const member = await dbGet('SELECT group_id FROM split_members WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    const group = await dbGet('SELECT user_id FROM split_groups WHERE id = ?', [member.group_id]);
    if (!group || group.user_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    await Split.removeMember(req.params.id);
    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== РАСХОДЫ ====================

router.get('/groups/:id/expenses', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const expenses = await Split.getGroupExpenses(req.params.id);
    res.json(expenses);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/groups/:id/expenses', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const { paid_by, description, amount, split_type, date, category, shares } = req.body;
    if (!paid_by || !description || !amount) {
      return res.status(400).json({ message: 'Required fields are missing' });
    }
    const expense = await Split.addExpense({ group_id: req.params.id, paid_by, description, amount, split_type, date, category, shares });
    res.status(201).json(expense);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/expenses/:id', async (req, res) => {
  try {
    const expense = await dbGet('SELECT group_id FROM split_expenses WHERE id = ?', [req.params.id]);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });
    const access = await canAccessGroup(expense.group_id, req.user.id);
    if (!access) return res.status(403).json({ message: 'Not authorized' });
    await Split.deleteExpense(req.params.id);
    res.json({ message: 'Expense deleted' });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== БАЛАНСЫ И РАСЧЁТЫ ====================

router.get('/groups/:id/balances', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const balancesObj = await Split.calculateBalances(req.params.id);
    res.json(Object.values(balancesObj));
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/groups/:id/settlements/suggested', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const settlements = await Split.calculateSettlements(req.params.id);
    res.json(settlements);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/groups/:id/settlements', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const { from_member, to_member, amount, date, note } = req.body;
    if (!from_member || !to_member || !amount) {
      return res.status(400).json({ message: 'Required fields are missing' });
    }
    await Split.recordSettlement(req.params.id, from_member, to_member, amount, note);
    res.status(201).json({ message: 'Settlement recorded' });
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/groups/:id/settlements', async (req, res) => {
  try {
    const access = await canAccessGroup(req.params.id, req.user.id);
    if (!access) return res.status(404).json({ message: 'Group not found' });
    const settlements = await Split.getSettlements(req.params.id);
    res.json(settlements);
  } catch (error) {
    console.error(`Error:`, error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
