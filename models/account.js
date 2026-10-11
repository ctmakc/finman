const { query, get, run, transaction } = require('../db/database');
const money = require('../lib/money');

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
          accountData.currency || 'UAH',
          accountData.balance || 0,
          accountData.accountType || 'checking'
        ]
      );
      
      return { id: result.id, ...accountData };
    } catch (error) {
      throw error;
    }
  }

  // Создание счёта пользователем с начальным балансом.
  // Баланс записывается ОДИН раз (в accounts.balance), а в леджер ложится
  // одна строка type='opening' на ту же сумму — без повторного инкремента
  // баланса. Строка нужна, чтобы SUM(amount) по счёту сходился с балансом
  // (reconcile, Beancount-экспорт), и исключена из доходов/расходов во всей
  // аналитике, которая фильтрует type IN ('income','expense'). Атомарно.
  static async createWithOpeningBalance(accountData) {
    const balance = money.round(accountData.balance || 0);
    return transaction(async () => {
      const result = await run(
        `INSERT INTO accounts
         (user_id, name, account_number, bank_name, currency, balance, account_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          accountData.userId,
          accountData.name,
          accountData.accountNumber || '',
          accountData.bankName || '',
          accountData.currency || 'UAH',
          balance,
          accountData.accountType || 'checking'
        ]
      );
      if (balance !== 0) {
        await run(
          `INSERT INTO transactions
           (account_id, user_id, date, description, category, amount, type)
           VALUES (?, ?, ?, ?, ?, ?, 'opening')`,
          [
            result.id,
            accountData.userId,
            accountData.openingDate || new Date().toISOString().split('T')[0],
            'Начальный баланс',
            'Начальный баланс',
            balance
          ]
        );
      }
      return { id: result.id, ...accountData, balance };
    });
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
  
  // Обновление баланса счета.
  // Читаем текущий баланс и пересчитываем через money.add, чтобы хранимое
  // значение всегда было округлено до 2 знаков и не накапливало float-дрейф
  // (например, многократные 0.1 + 0.2 в SQLite REAL).
  static async updateBalance(id, userId, amount) {
    // Атомарный инкремент (без read-modify-write -> нет потерянных обновлений
    // при конкуренции). ROUND(...,2) держит баланс точным до копеек прямо в БД.
    const result = await run(
      `UPDATE accounts
       SET balance = ROUND(balance + ?, 2), updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [money.round(amount), id, userId]
    );
    return result.changes > 0;
  }
}

module.exports = Account;