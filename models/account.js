const { query, get, run } = require('../db/database');

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
          accountData.currency || 'RUB',
          accountData.balance || 0,
          accountData.accountType || 'checking'
        ]
      );
      
      return { id: result.id, ...accountData };
    } catch (error) {
      throw error;
    }
  }
  
  // Получение всех счетов пользователя
  static async findByUserId(userId) {
    try {
      const accounts = await query(
        `SELECT * FROM accounts WHERE user_id = ? AND is_active = 1 ORDER BY name`,
        [userId]
      );
      
      return accounts;
    } catch (error) {
      throw error;
    }
  }
  
  // Получение счета по ID
  static async findById(id, userId) {
    try {
      const account = await get(
        `SELECT * FROM accounts WHERE id = ? AND user_id = ?`,
        [id, userId]
      );
      
      return account;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление счета
  static async update(id, userId, accountData) {
    try {
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
      params.push(id);
      params.push(userId);
      
      const result = await run(
        `UPDATE accounts SET ${updateFields.join(', ')} 
         WHERE id = ? AND user_id = ?`,
        params
      );
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
  
  // Удаление счета (мягкое удаление)
  static async delete(id, userId) {
    try {
      const result = await run(
        `UPDATE accounts SET is_active = 0, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND user_id = ?`,
        [id, userId]
      );
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление баланса счета
  static async updateBalance(id, userId, amount) {
    try {
      const result = await run(
        `UPDATE accounts 
         SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND user_id = ?`,
        [amount, id, userId]
      );
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Account;