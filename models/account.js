const { query, get, run } = require('../db/database');
const orgScope = require('../services/orgScope');

// `scope` is req.user ({ id, orgId }) for org-shared access, or a bare
// numeric user id from not-yet-migrated callers (own-data-only).
class Account {
  // Создание счета
  static async create(accountData) {
    try {
      const result = await run(
        `INSERT INTO accounts 
         (user_id, name, account_number, bank_name, currency, balance, account_type) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          accountData.userId,
          accountData.name,
          accountData.accountNumber || '',
          accountData.bankName || '',
          accountData.currency || 'USD',
          accountData.balance || 0,
          accountData.accountType || 'checking'
        ]
      );
      
      return { id: result.id, ...accountData };
    } catch (error) {
      throw error;
    }
  }
  
  // Получение всех счетов организации
  static async findByUserId(scope) {
    try {
      const ids = await orgScope.scopeUserIds(scope);
      const ph = orgScope.placeholders(ids.length);
      const accounts = await query(
        `SELECT * FROM accounts WHERE user_id IN (${ph}) AND is_active = 1 ORDER BY name`,
        ids
      );

      return accounts;
    } catch (error) {
      throw error;
    }
  }

  // Получение счета по ID
  static async findById(id, scope) {
    try {
      const ids = await orgScope.scopeUserIds(scope);
      const ph = orgScope.placeholders(ids.length);
      const account = await get(
        `SELECT * FROM accounts WHERE id = ? AND user_id IN (${ph})`,
        [id, ...ids]
      );

      return account;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление счета
  static async update(id, scope, accountData) {
    try {
      const ids = await orgScope.scopeUserIds(scope);
      let updateFields = [];
      let params = [];
      
      if (accountData.name) {
        updateFields.push('name = ?');
        params.push(accountData.name);
      }
      
      if (accountData.accountNumber) {
        updateFields.push('account_number = ?');
        params.push(accountData.accountNumber);
      }
      
      if (accountData.bankName) {
        updateFields.push('bank_name = ?');
        params.push(accountData.bankName);
      }
      
      if (accountData.currency) {
        updateFields.push('currency = ?');
        params.push(accountData.currency);
      }
      
      if (accountData.balance !== undefined) {
        updateFields.push('balance = ?');
        params.push(accountData.balance);
      }
      
      if (accountData.accountType) {
        updateFields.push('account_type = ?');
        params.push(accountData.accountType);
      }
      
      if (accountData.isActive !== undefined) {
        updateFields.push('is_active = ?');
        params.push(accountData.isActive ? 1 : 0);
      }
      
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      const ph = orgScope.placeholders(ids.length);
      params.push(id, ...ids);

      const result = await run(
        `UPDATE accounts SET ${updateFields.join(', ')}
         WHERE id = ? AND user_id IN (${ph})`,
        params
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Удаление счета (мягкое удаление)
  static async delete(id, scope) {
    try {
      const ids = await orgScope.scopeUserIds(scope);
      const ph = orgScope.placeholders(ids.length);
      const result = await run(
        `UPDATE accounts SET is_active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id IN (${ph})`,
        [id, ...ids]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Обновление баланса счета
  static async updateBalance(id, scope, amount) {
    try {
      const ids = await orgScope.scopeUserIds(scope);
      const ph = orgScope.placeholders(ids.length);
      const result = await run(
        `UPDATE accounts
         SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id IN (${ph})`,
        [amount, id, ...ids]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Account;