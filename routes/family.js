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
    console.error('Ошибка при получении семей:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении семей' });
  }
});

// Создание семьи
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: true, message: 'Название семьи обязательно' });
    }

    const family = await Family.create({
      name: name.trim(),
      description: description?.trim(),
      ownerId: req.user.id
    });

    res.status(201).json({ success: true, family });
  } catch (error) {
    console.error('Ошибка при создании семьи:', error);
    res.status(500).json({ error: true, message: 'Ошибка при создании семьи' });
  }
});

// Получение семьи по ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const family = await Family.findById(req.params.id);

    if (!family) {
      return res.status(404).json({ error: true, message: 'Семья не найдена' });
    }

    // Проверяем, что пользователь - участник
    const isMember = await Family.isMember(req.params.id, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: true, message: 'Доступ запрещен' });
    }

    const myRole = await Family.getUserRole(req.params.id, req.user.id);
    res.json({ ...family, myRole });
  } catch (error) {
    console.error('Ошибка при получении семьи:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении семьи' });
  }
});

// Обновление семьи
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name, description } = req.body;

    const family = await Family.findById(req.params.id);
    if (!family || family.owner_id !== req.user.id) {
      return res.status(403).json({ error: true, message: 'Только владелец может редактировать семью' });
    }

    await Family.update(req.params.id, req.user.id, { name, description });

    const updatedFamily = await Family.findById(req.params.id);
    res.json({ success: true, family: updatedFamily });
  } catch (error) {
    console.error('Ошибка при обновлении семьи:', error);
    res.status(500).json({ error: true, message: 'Ошибка при обновлении семьи' });
  }
});

// Удаление семьи
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const deleted = await Family.delete(req.params.id, req.user.id);

    if (!deleted) {
      return res.status(403).json({ error: true, message: 'Только владелец может удалить семью' });
    }

    res.json({ success: true, message: 'Семья удалена' });
  } catch (error) {
    console.error('Ошибка при удалении семьи:', error);
    res.status(500).json({ error: true, message: 'Ошибка при удалении семьи' });
  }
});

// ==================== УЧАСТНИКИ ====================

// Получение участников семьи
router.get('/:id/members', authenticate, async (req, res) => {
  try {
    const isMember = await Family.isMember(req.params.id, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: true, message: 'Доступ запрещен' });
    }

    const members = await Family.getMembers(req.params.id);
    res.json(members);
  } catch (error) {
    console.error('Ошибка при получении участников:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении участников' });
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

    res.json({ success: true, message: 'Участник удален' });
  } catch (error) {
    console.error('Ошибка при удалении участника:', error);
    res.status(500).json({ error: true, message: 'Ошибка при удалении участника' });
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
    console.error('Ошибка при изменении роли:', error);
    res.status(500).json({ error: true, message: 'Ошибка при изменении роли' });
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
    console.error('Ошибка при передаче владения:', error);
    res.status(500).json({ error: true, message: 'Ошибка при передаче владения' });
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
    console.error('Ошибка при выходе из семьи:', error);
    res.status(500).json({ error: true, message: 'Ошибка при выходе из семьи' });
  }
});

// ==================== ПРИГЛАШЕНИЯ ====================

// Регенерация кода приглашения
router.post('/:id/regenerate-code', authenticate, async (req, res) => {
  try {
    const newCode = await Family.regenerateInviteCode(req.params.id, req.user.id);

    if (!newCode) {
      return res.status(403).json({ error: true, message: 'Недостаточно прав' });
    }

    res.json({ success: true, inviteCode: newCode });
  } catch (error) {
    console.error('Ошибка при регенерации кода:', error);
    res.status(500).json({ error: true, message: 'Ошибка при регенерации кода' });
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
    console.error('Ошибка при присоединении:', error);
    res.status(500).json({ error: true, message: 'Ошибка при присоединении к семье' });
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
      return res.status(403).json({ error: true, message: 'Недостаточно прав' });
    }

    res.json({ success: true, invite });
  } catch (error) {
    console.error('Ошибка при создании приглашения:', error);
    res.status(500).json({ error: true, message: 'Ошибка при создании приглашения' });
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
    console.error('Ошибка при принятии приглашения:', error);
    res.status(500).json({ error: true, message: 'Ошибка при принятии приглашения' });
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
    console.error('Ошибка при получении прав:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении прав доступа' });
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
    console.error('Ошибка при выдаче прав:', error);
    res.status(500).json({ error: true, message: 'Ошибка при выдаче прав' });
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
    console.error('Ошибка при отзыве прав:', error);
    res.status(500).json({ error: true, message: 'Ошибка при отзыве прав' });
  }
});

// Получение всех доступных счетов
router.get('/accessible-accounts', authenticate, async (req, res) => {
  try {
    const accounts = await AccountPermission.getAccessibleAccounts(req.user.id);
    res.json(accounts);
  } catch (error) {
    console.error('Ошибка при получении счетов:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении счетов' });
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
    console.error('Ошибка при массовой выдаче прав:', error);
    res.status(500).json({ error: true, message: 'Ошибка при выдаче прав' });
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
    console.error('Ошибка при выдаче прав:', error);
    res.status(500).json({ error: true, message: 'Ошибка при выдаче прав' });
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
    console.error('Ошибка при отзыве прав:', error);
    res.status(500).json({ error: true, message: 'Ошибка при отзыве прав' });
  }
});

// Получение всех доступных бюджетов
router.get('/accessible-budgets', authenticate, async (req, res) => {
  try {
    const budgets = await BudgetPermission.getAccessibleBudgets(req.user.id);
    res.json(budgets);
  } catch (error) {
    console.error('Ошибка при получении бюджетов:', error);
    res.status(500).json({ error: true, message: 'Ошибка при получении бюджетов' });
  }
});

module.exports = router;
