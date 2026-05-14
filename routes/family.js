const express = require('express');
const passport = require('passport');
const Family = require('../models/family');
const { AccountPermission, BudgetPermission } = require('../models/permission');

const router = express.Router();

// Middleware для проверки аутентификации
const authenticate = passport.authenticate('jwt', { session: false });

// ==================== СЕМЬИ ====================

// Получение всех семей пользователя
router.get('/', authenticate, async (req, res) => {
  try {
    const families = await Family.findByUserId(req.user.id);
    res.json(families);
  } catch (error) {
    console.error('Failed to get families:', error);
    res.status(500).json({ error: true, message: 'Failed to get families' });
  }
});

// Создание семьи
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Family name is required' });
    }

    const family = await Family.create({
      name: name.trim(),
      description: description?.trim(),
      ownerId: req.user.id
    });

    res.status(201).json({ success: true, family });
  } catch (error) {
    console.error('Failed to create family:', error);
    res.status(500).json({ error: true, message: 'Failed to create family' });
  }
});

// Получение семьи по ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const family = await Family.findById(req.params.id);

    if (!family) {
      return res.status(404).json({ error: true, message: 'Family not found' });
    }

    // Проверяем, что пользователь - участник
    const isMember = await Family.isMember(req.params.id, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: true, message: 'Access denied' });
    }

    const myRole = await Family.getUserRole(req.params.id, req.user.id);
    res.json({ ...family, myRole });
  } catch (error) {
    console.error('Failed to get family:', error);
    res.status(500).json({ error: true, message: 'Failed to get family' });
  }
});

// Обновление семьи
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name, description } = req.body;

    const family = await Family.findById(req.params.id);
    if (!family || family.owner_id !== req.user.id) {
      return res.status(403).json({ error: true, message: 'Only the owner can редактировать семью' });
    }

    await Family.update(req.params.id, req.user.id, { name, description });

    const updatedFamily = await Family.findById(req.params.id);
    res.json({ success: true, family: updatedFamily });
  } catch (error) {
    console.error('Failed to update family:', error);
    res.status(500).json({ error: true, message: 'Failed to update family' });
  }
});

// Удаление семьи
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const deleted = await Family.delete(req.params.id, req.user.id);

    if (!deleted) {
      return res.status(403).json({ error: true, message: 'Only the owner can delete the family' });
    }

    res.json({ success: true, message: 'Family deleted' });
  } catch (error) {
    console.error('Failed to delete family:', error);
    res.status(500).json({ error: true, message: 'Failed to delete family' });
  }
});

// ==================== УЧАСТНИКИ ====================

// Получение участников семьи
router.get('/:id/members', authenticate, async (req, res) => {
  try {
    const isMember = await Family.isMember(req.params.id, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: true, message: 'Access denied' });
    }

    const members = await Family.getMembers(req.params.id);
    res.json(members);
  } catch (error) {
    console.error('Failed to get members:', error);
    res.status(500).json({ error: true, message: 'Failed to get members' });
  }
});

// Удаление участника
router.delete('/:id/members/:userId', authenticate, async (req, res) => {
  try {
    const result = await Family.removeMember(
      req.params.id,
      parseInt(req.params.userId),
      req.user.id
    );

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Member removed' });
  } catch (error) {
    console.error('Failed to remove member:', error);
    res.status(500).json({ error: true, message: 'Failed to remove member' });
  }
});

// Изменение роли участника
router.put('/:id/members/:userId/role', authenticate, async (req, res) => {
  try {
    const { role } = req.body;

    const result = await Family.changeMemberRole(
      req.params.id,
      parseInt(req.params.userId),
      role,
      req.user.id
    );

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Роль изменена' });
  } catch (error) {
    console.error('Failed to change role:', error);
    res.status(500).json({ error: true, message: 'Failed to change role' });
  }
});

// Передача владения
router.post('/:id/transfer', authenticate, async (req, res) => {
  try {
    const { newOwnerId } = req.body;

    const result = await Family.transferOwnership(
      req.params.id,
      req.user.id,
      parseInt(newOwnerId)
    );

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Владение передано' });
  } catch (error) {
    console.error('Failed to transfer ownership:', error);
    res.status(500).json({ error: true, message: 'Failed to transfer ownership' });
  }
});

// Выход из семьи
router.post('/:id/leave', authenticate, async (req, res) => {
  try {
    const result = await Family.leave(req.params.id, req.user.id);

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Вы покинули семью' });
  } catch (error) {
    console.error('Failed to leave family:', error);
    res.status(500).json({ error: true, message: 'Failed to leave family' });
  }
});

// ==================== ПРИГЛАШЕНИЯ ====================

// Регенерация кода приглашения
router.post('/:id/regenerate-code', authenticate, async (req, res) => {
  try {
    const newCode = await Family.regenerateInviteCode(req.params.id, req.user.id);

    if (!newCode) {
      return res.status(403).json({ error: true, message: 'Insufficient permissions' });
    }

    res.json({ success: true, inviteCode: newCode });
  } catch (error) {
    console.error('Failed to regenerate code:', error);
    res.status(500).json({ error: true, message: 'Failed to regenerate code' });
  }
});

// Присоединение по коду
router.post('/join', authenticate, async (req, res) => {
  try {
    const { inviteCode } = req.body;

    if (!inviteCode || !inviteCode.trim()) {
      return res.status(400).json({ error: true, message: 'Код приглашения обязателен' });
    }

    const result = await Family.joinByCode(inviteCode.trim(), req.user.id);

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    const family = await Family.findById(result.familyId);
    res.json({ success: true, family });
  } catch (error) {
    console.error('Error при присоединении:', error);
    res.status(500).json({ error: true, message: 'Failed to join family' });
  }
});

// Создание персонального приглашения
router.post('/:id/invite', authenticate, async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: true, message: 'Email обязателен' });
    }

    const invite = await Family.createInvite(
      req.params.id,
      req.user.id,
      email.trim(),
      role || 'member'
    );

    if (!invite) {
      return res.status(403).json({ error: true, message: 'Insufficient permissions' });
    }

    res.json({ success: true, invite });
  } catch (error) {
    console.error('Failed to create invitation:', error);
    res.status(500).json({ error: true, message: 'Failed to create invitation' });
  }
});

// Принятие приглашения по токену
router.post('/accept-invite', authenticate, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: true, message: 'Токен приглашения обязателен' });
    }

    const result = await Family.acceptInvite(token, req.user.id);

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    const family = await Family.findById(result.familyId);
    res.json({ success: true, family });
  } catch (error) {
    console.error('Failed to accept invitation:', error);
    res.status(500).json({ error: true, message: 'Failed to accept invitation' });
  }
});

// ==================== ПРАВА ДОСТУПА К СЧЕТАМ ====================

// Получение прав доступа к счету
router.get('/accounts/:accountId/permissions', authenticate, async (req, res) => {
  try {
    const users = await AccountPermission.getAccountUsers(
      parseInt(req.params.accountId),
      req.user.id
    );

    res.json(users);
  } catch (error) {
    console.error('Error при получении прав:', error);
    res.status(500).json({ error: true, message: 'Failed to get permissions' });
  }
});

// Выдача прав на счет
router.post('/accounts/:accountId/permissions', authenticate, async (req, res) => {
  try {
    const { userId, canView, canEdit, canDelete, canAddTransactions } = req.body;

    if (!userId) {
      return res.status(400).json({ error: true, message: 'userId обязателен' });
    }

    const result = await AccountPermission.grant(
      parseInt(req.params.accountId),
      parseInt(userId),
      { canView, canEdit, canDelete, canAddTransactions },
      req.user.id
    );

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Права выданы' });
  } catch (error) {
    console.error('Failed to grant permissions:', error);
    res.status(500).json({ error: true, message: 'Failed to grant permissions' });
  }
});

// Отзыв прав на счет
router.delete('/accounts/:accountId/permissions/:userId', authenticate, async (req, res) => {
  try {
    const result = await AccountPermission.revoke(
      parseInt(req.params.accountId),
      parseInt(req.params.userId),
      req.user.id
    );

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Права отозваны' });
  } catch (error) {
    console.error('Failed to revoke permissions:', error);
    res.status(500).json({ error: true, message: 'Failed to revoke permissions' });
  }
});

// Получение всех доступных счетов
router.get('/accessible-accounts', authenticate, async (req, res) => {
  try {
    const accounts = await AccountPermission.getAccessibleAccounts(req.user.id);
    res.json(accounts);
  } catch (error) {
    console.error('Failed to get accounts:', error);
    res.status(500).json({ error: true, message: 'Failed to get accounts' });
  }
});

// Массовая выдача прав участнику семьи
router.post('/bulk-permissions', authenticate, async (req, res) => {
  try {
    const { targetUserId, permissions } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: true, message: 'targetUserId обязателен' });
    }

    const result = await AccountPermission.grantToFamilyMember(
      req.user.id,
      parseInt(targetUserId),
      permissions || {},
      req.user.id
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error при массовой выдаче прав:', error);
    res.status(500).json({ error: true, message: 'Failed to grant permissions' });
  }
});

// ==================== ПРАВА ДОСТУПА К БЮДЖЕТАМ ====================

// Выдача прав на бюджет
router.post('/budgets/:budgetId/permissions', authenticate, async (req, res) => {
  try {
    const { userId, canView, canEdit } = req.body;

    if (!userId) {
      return res.status(400).json({ error: true, message: 'userId обязателен' });
    }

    const result = await BudgetPermission.grant(
      parseInt(req.params.budgetId),
      parseInt(userId),
      { canView, canEdit },
      req.user.id
    );

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Права выданы' });
  } catch (error) {
    console.error('Failed to grant permissions:', error);
    res.status(500).json({ error: true, message: 'Failed to grant permissions' });
  }
});

// Отзыв прав на бюджет
router.delete('/budgets/:budgetId/permissions/:userId', authenticate, async (req, res) => {
  try {
    const result = await BudgetPermission.revoke(
      parseInt(req.params.budgetId),
      parseInt(req.params.userId),
      req.user.id
    );

    if (!result.success) {
      return res.status(400).json({ error: true, message: result.message });
    }

    res.json({ success: true, message: 'Права отозваны' });
  } catch (error) {
    console.error('Failed to revoke permissions:', error);
    res.status(500).json({ error: true, message: 'Failed to revoke permissions' });
  }
});

// Получение всех доступных бюджетов
router.get('/accessible-budgets', authenticate, async (req, res) => {
  try {
    const budgets = await BudgetPermission.getAccessibleBudgets(req.user.id);
    res.json(budgets);
  } catch (error) {
    console.error('Failed to get budgets:', error);
    res.status(500).json({ error: true, message: 'Failed to get budgets' });
  }
});

module.exports = router;
