const { query, get, run } = require('../db/database');

class AccountPermission {
  // Создание/обновление прав доступа к счету
  static async grant(accountId, userId, permissions, grantedBy) {
    const { canView = true, canEdit = false, canDelete = false, canAddTransactions = false } = permissions;

    // Проверяем, что дающий права - владелец счета
    const account = await get(
      `SELECT user_id FROM accounts WHERE id = ?`,
      [accountId]
    );

    if (!account || account.user_id !== grantedBy) {
      return { success: false, message: 'Only the account owner can manage access' };
    }

    // Нельзя выдать права самому себе
    if (userId === grantedBy) {
      return { success: false, message: 'Cannot change your own permissions' };
    }

    // Проверяем существующие права
    const existing = await get(
      `SELECT id FROM account_permissions WHERE account_id = ? AND user_id = ?`,
      [accountId, userId]
    );

    if (existing) {
      await run(
        `UPDATE account_permissions
         SET can_view = ?, can_edit = ?, can_delete = ?, can_add_transactions = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [canView ? 1 : 0, canEdit ? 1 : 0, canDelete ? 1 : 0, canAddTransactions ? 1 : 0, existing.id]
      );
    } else {
      await run(
        `INSERT INTO account_permissions
         (account_id, user_id, can_view, can_edit, can_delete, can_add_transactions, granted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [accountId, userId, canView ? 1 : 0, canEdit ? 1 : 0, canDelete ? 1 : 0, canAddTransactions ? 1 : 0, grantedBy]
      );
    }

    return { success: true };
  }

  // Отзыв прав доступа
  static async revoke(accountId, userId, revokedBy) {
    const account = await get(
      `SELECT user_id FROM accounts WHERE id = ?`,
      [accountId]
    );

    if (!account || account.user_id !== revokedBy) {
      return { success: false, message: 'Only the account owner can revoke access' };
    }

    await run(
      `DELETE FROM account_permissions WHERE account_id = ? AND user_id = ?`,
      [accountId, userId]
    );

    return { success: true };
  }

  // Получение прав пользователя для счета
  static async getPermissions(accountId, userId) {
    // Сначала проверяем, владелец ли это
    const account = await get(
      `SELECT user_id FROM accounts WHERE id = ?`,
      [accountId]
    );

    if (!account) return null;

    if (account.user_id === userId) {
      return {
        isOwner: true,
        canView: true,
        canEdit: true,
        canDelete: true,
        canAddTransactions: true
      };
    }

    const permission = await get(
      `SELECT * FROM account_permissions WHERE account_id = ? AND user_id = ?`,
      [accountId, userId]
    );

    if (!permission) return null;

    return {
      isOwner: false,
      canView: !!permission.can_view,
      canEdit: !!permission.can_edit,
      canDelete: !!permission.can_delete,
      canAddTransactions: !!permission.can_add_transactions
    };
  }

  // Проверка конкретного права
  static async hasPermission(accountId, userId, permissionType) {
    const permissions = await this.getPermissions(accountId, userId);
    if (!permissions) return false;
    return permissions[permissionType] === true;
  }

  // Получение всех пользователей с доступом к счету
  static async getAccountUsers(accountId, ownerId) {
    const account = await get(
      `SELECT user_id FROM accounts WHERE id = ?`,
      [accountId]
    );

    if (!account || account.user_id !== ownerId) {
      return [];
    }

    return query(
      `SELECT ap.*, u.username, u.email, u.full_name
       FROM account_permissions ap
       JOIN users u ON ap.user_id = u.id
       WHERE ap.account_id = ?
       ORDER BY ap.created_at DESC`,
      [accountId]
    );
  }

  // Получение всех доступных счетов пользователя (свои + расшаренные)
  static async getAccessibleAccounts(userId) {
    // Свои счета
    const ownAccounts = await query(
      `SELECT a.*, 1 as is_owner, 1 as can_view, 1 as can_edit, 1 as can_delete, 1 as can_add_transactions
       FROM accounts a
       WHERE a.user_id = ? AND a.is_active = 1`,
      [userId]
    );

    // Расшаренные счета
    const sharedAccounts = await query(
      `SELECT a.*, 0 as is_owner, ap.can_view, ap.can_edit, ap.can_delete, ap.can_add_transactions,
              u.username as owner_username
       FROM accounts a
       JOIN account_permissions ap ON a.id = ap.account_id
       JOIN users u ON a.user_id = u.id
       WHERE ap.user_id = ? AND ap.can_view = 1 AND a.is_active = 1`,
      [userId]
    );

    return {
      own: ownAccounts,
      shared: sharedAccounts,
      all: [...ownAccounts, ...sharedAccounts]
    };
  }

  // Массовая выдача прав (для семьи)
  static async grantToFamilyMember(ownerId, targetUserId, permissions, grantedBy) {
    // Получаем все счета владельца
    const accounts = await query(
      `SELECT id FROM accounts WHERE user_id = ? AND is_active = 1`,
      [ownerId]
    );

    for (const account of accounts) {
      await this.grant(account.id, targetUserId, permissions, ownerId);
    }

    return { success: true, accountsCount: accounts.length };
  }
}

class BudgetPermission {
  // Создание/обновление прав доступа к бюджету
  static async grant(budgetId, userId, permissions, grantedBy) {
    const { canView = true, canEdit = false } = permissions;

    // Проверяем, что дающий права - владелец бюджета
    const budget = await get(
      `SELECT user_id FROM budgets WHERE id = ?`,
      [budgetId]
    );

    if (!budget || budget.user_id !== grantedBy) {
      return { success: false, message: 'Only the budget owner can manage access' };
    }

    if (userId === grantedBy) {
      return { success: false, message: 'Cannot change your own permissions' };
    }

    const existing = await get(
      `SELECT id FROM budget_permissions WHERE budget_id = ? AND user_id = ?`,
      [budgetId, userId]
    );

    if (existing) {
      await run(
        `UPDATE budget_permissions SET can_view = ?, can_edit = ? WHERE id = ?`,
        [canView ? 1 : 0, canEdit ? 1 : 0, existing.id]
      );
    } else {
      await run(
        `INSERT INTO budget_permissions (budget_id, user_id, can_view, can_edit, granted_by)
         VALUES (?, ?, ?, ?, ?)`,
        [budgetId, userId, canView ? 1 : 0, canEdit ? 1 : 0, grantedBy]
      );
    }

    return { success: true };
  }

  // Отзыв прав
  static async revoke(budgetId, userId, revokedBy) {
    const budget = await get(
      `SELECT user_id FROM budgets WHERE id = ?`,
      [budgetId]
    );

    if (!budget || budget.user_id !== revokedBy) {
      return { success: false, message: 'Only the budget owner can revoke access' };
    }

    await run(
      `DELETE FROM budget_permissions WHERE budget_id = ? AND user_id = ?`,
      [budgetId, userId]
    );

    return { success: true };
  }

  // Получение прав
  static async getPermissions(budgetId, userId) {
    const budget = await get(
      `SELECT user_id FROM budgets WHERE id = ?`,
      [budgetId]
    );

    if (!budget) return null;

    if (budget.user_id === userId) {
      return { isOwner: true, canView: true, canEdit: true };
    }

    const permission = await get(
      `SELECT * FROM budget_permissions WHERE budget_id = ? AND user_id = ?`,
      [budgetId, userId]
    );

    if (!permission) return null;

    return {
      isOwner: false,
      canView: !!permission.can_view,
      canEdit: !!permission.can_edit
    };
  }

  // Получение доступных бюджетов
  static async getAccessibleBudgets(userId) {
    const ownBudgets = await query(
      `SELECT b.*, 1 as is_owner, 1 as can_view, 1 as can_edit
       FROM budgets b
       WHERE b.user_id = ? AND b.is_active = 1`,
      [userId]
    );

    const sharedBudgets = await query(
      `SELECT b.*, 0 as is_owner, bp.can_view, bp.can_edit, u.username as owner_username
       FROM budgets b
       JOIN budget_permissions bp ON b.id = bp.budget_id
       JOIN users u ON b.user_id = u.id
       WHERE bp.user_id = ? AND bp.can_view = 1 AND b.is_active = 1`,
      [userId]
    );

    return {
      own: ownBudgets,
      shared: sharedBudgets,
      all: [...ownBudgets, ...sharedBudgets]
    };
  }
}

module.exports = {
  AccountPermission,
  BudgetPermission
};
