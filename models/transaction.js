const { query, get, run, transaction } = require('../db/database');
const Account = require('./account');
const money = require('../lib/money');

class Transaction {
  // Создание транзакции
  static async create(transactionData) {
    // Округляем сумму до копеек (хранимая транзакция и баланс — точные до 2 знаков).
    const amount = money.round(transactionData.amount);
    return transaction(async () => {
      const result = await run(
        `INSERT INTO transactions
         (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionData.accountId,
          transactionData.userId,
          transactionData.date,
          transactionData.description || '',
          transactionData.category || 'Прочее',
          amount,
          transactionData.type || (amount >= 0 ? 'income' : 'expense')
        ]
      );
      await Account.updateBalance(
        transactionData.accountId,
        transactionData.userId,
        amount
      );
      return { id: result.id, ...transactionData, amount };
    });
  }
  
  // Создание нескольких транзакций (импорт)
  static async bulkCreate(transactions) {
    return transaction(async () => {
      const results = [];
      for (const tx of transactions) {
        const amount = money.round(tx.amount);
        const result = await run(
          `INSERT INTO transactions
           (account_id, user_id, date, description, category, amount, type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            tx.accountId,
            tx.userId,
            tx.date,
            tx.description || '',
            tx.category || 'Прочее',
            amount,
            tx.type || (amount >= 0 ? 'income' : 'expense')
          ]
        );
        if (!tx.skipBalanceUpdate) {
          await Account.updateBalance(tx.accountId, tx.userId, amount);
        }
        results.push({ id: result.id, ...tx, amount });
      }
      return results;
    });
  }
  
  // Получение транзакций пользователя (с фильтрацией и пагинацией)
  static async findByUserId(userId, options = {}) {
    try {
      const {
        accountId,
        startDate,
        endDate,
        category,
        type,
        minAmount,
        maxAmount,
        search,
        page = 1,
        limit = 100,
        sortBy = 'date',
        sortOrder = 'DESC'
      } = options;
      
      let sql = `
        SELECT t.*, a.name as account_name
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE t.user_id = ?
      `;

      const params = [userId];

      // Фильтрация по счету
      if (accountId) {
        sql += ` AND t.account_id = ?`;
        params.push(accountId);
      }

      // Фильтрация по датам
      if (startDate) {
        sql += ` AND t.date >= ?`;
        params.push(startDate);
      }

      if (endDate) {
        sql += ` AND t.date <= ?`;
        params.push(endDate);
      }

      // Фильтрация по категории
      if (category) {
        sql += ` AND t.category = ?`;
        params.push(category);
      }

      // Фильтрация по типу (доход/расход)
      if (type) {
        sql += ` AND t.type = ?`;
        params.push(type);
      }

      // Фильтрация по сумме
      if (minAmount !== undefined) {
        sql += ` AND t.amount >= ?`;
        params.push(minAmount);
      }

      if (maxAmount !== undefined) {
        sql += ` AND t.amount <= ?`;
        params.push(maxAmount);
      }

      // Поиск по описанию
      if (search) {
        sql += ` AND (t.description LIKE ? OR t.category LIKE ?)`;
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm);
      }

      // Сортировка и пагинация
      const validSortColumns = ['date', 'amount', 'category', 'description', 'created_at'];
      const validSortOrders = ['ASC', 'DESC'];

      const actualSortBy = validSortColumns.includes(sortBy) ? sortBy : 'date';
      const actualSortOrder = validSortOrders.includes(sortOrder.toUpperCase())
        ? sortOrder.toUpperCase()
        : 'DESC';

      sql += ` ORDER BY t.${actualSortBy} ${actualSortOrder}`;

      // Пагинация
      const offset = (page - 1) * limit;
      sql += ` LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const transactions = await query(sql, params);
      
      return transactions;
    } catch (error) {
      throw error;
    }
  }
  
  // Получение транзакции по ID
  static async findById(id, userId) {
    try {
      const transaction = await get(
        `SELECT t.*, a.name as account_name
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         WHERE t.id = ? AND t.user_id = ?`,
        [id, userId]
      );
      
      return transaction;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление транзакции
  static async update(id, userId, transactionData) {
    try {
      // Получить текущую транзакцию
      const currentTransaction = await this.findById(id, userId);
      
      if (!currentTransaction) {
        throw new Error('Транзакция не найдена');
      }
      
      return transaction(async () => {
        // Вычислить разницу для обновления баланса (округлённую до копеек).
        let balanceDifference = 0;
        let newAmount;
        if (transactionData.amount !== undefined) {
          newAmount = money.round(transactionData.amount);
          balanceDifference = money.sub(newAmount, currentTransaction.amount);
        }

        const updateFields = [];
        const params = [];
        if (transactionData.date) { updateFields.push('date = ?'); params.push(transactionData.date); }
        if (transactionData.description !== undefined) { updateFields.push('description = ?'); params.push(transactionData.description); }
        if (transactionData.category) { updateFields.push('category = ?'); params.push(transactionData.category); }
        if (transactionData.amount !== undefined) { updateFields.push('amount = ?'); params.push(newAmount); }
        if (transactionData.type) { updateFields.push('type = ?'); params.push(transactionData.type); }
        updateFields.push('updated_at = CURRENT_TIMESTAMP');
        params.push(id);
        params.push(userId);

        const result = await run(
          `UPDATE transactions
           SET ${updateFields.join(', ')}
           WHERE id = ? AND user_id = ?`,
          params
        );

        if (balanceDifference !== 0) {
          await Account.updateBalance(currentTransaction.account_id, userId, balanceDifference);
        }
        return result.changes > 0;
      });
    } catch (error) {
      throw error;
    }
  }
  
  // Удаление транзакции
  static async delete(id, userId) {
    const row = await this.findById(id, userId);
    if (!row) {
      throw new Error('Транзакция не найдена');
    }
    return transaction(async () => {
      const result = await run(
        `DELETE FROM transactions WHERE id = ? AND user_id = ?`,
        [id, userId]
      );
      await Account.updateBalance(row.account_id, userId, -row.amount);
      return result.changes > 0;
    });
  }
  
  // Получение статистики по транзакциям
  static async getStats(userId, options = {}) {
    try {
      const {
        accountId,
        startDate,
        endDate,
        groupBy = 'month' // 'day', 'month', 'year', 'category'
      } = options;
      
      let sql = '';
      const params = [userId];

      // Базовые условия фильтрации
      let whereClause = 'WHERE t.user_id = ?';
      
      if (accountId) {
        whereClause += ' AND t.account_id = ?';
        params.push(accountId);
      }
      
      if (startDate) {
        whereClause += ' AND t.date >= ?';
        params.push(startDate);
      }
      
      if (endDate) {
        whereClause += ' AND t.date <= ?';
        params.push(endDate);
      }
      
      // Статистика по категориям
      if (groupBy === 'category') {
        sql = `
          SELECT
            t.category,
            t.type,
            SUM(t.amount) as total_amount,
            COUNT(*) as count
          FROM transactions t
          ${whereClause}
          GROUP BY t.category, t.type
          ORDER BY t.type, total_amount DESC
        `;
      } 
      // Статистика по датам (день, месяц, год)
      else {
        let dateFormat = '';
        
        if (groupBy === 'day') {
          dateFormat = '%Y-%m-%d';
        } else if (groupBy === 'month') {
          dateFormat = '%Y-%m';
        } else if (groupBy === 'year') {
          dateFormat = '%Y';
        }
        
        sql = `
          SELECT
            strftime('${dateFormat}', t.date) as period,
            t.type,
            SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END) as income,
            SUM(CASE WHEN t.type = 'expense' THEN ABS(t.amount) ELSE 0 END) as expense
          FROM transactions t
          ${whereClause}
          GROUP BY period, t.type
          ORDER BY period
        `;
      }
      
      const stats = await query(sql, params);
      return stats;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Transaction;