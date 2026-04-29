const { query, get, run } = require('../db/database');
const Account = require('./account');

class Transaction {
  // Создание транзакции
  static async create(transactionData) {
    try {
      // Начать транзакцию
      await run('BEGIN TRANSACTION');
      
      // Создать запись о транзакции
      const result = await run(
        `INSERT INTO transactions 
         (account_id, user_id, date, description, category, amount, type) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionData.accountId,
          transactionData.userId,
          transactionData.date,
          transactionData.description || '',
          transactionData.category || 'Other',
          transactionData.amount,
          transactionData.type || (transactionData.amount >= 0 ? 'income' : 'expense')
        ]
      );
      
      // Обновить баланс счета
      await Account.updateBalance(
        transactionData.accountId, 
        transactionData.userId, 
        transactionData.amount
      );
      
      // Завершить транзакцию
      await run('COMMIT');
      
      return { id: result.id, ...transactionData };
    } catch (error) {
      // Откатить транзакцию в случае ошибки
      await run('ROLLBACK');
      throw error;
    }
  }
  
  // Создание нескольких транзакций (импорт)
  static async bulkCreate(transactions) {
    try {
      // Начать транзакцию
      await run('BEGIN TRANSACTION');
      
      const results = [];
      
      // Обработка каждой транзакции
      for (const transaction of transactions) {
        // Создать запись о транзакции
        const result = await run(
          `INSERT INTO transactions 
           (account_id, user_id, date, description, category, amount, type) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            transaction.accountId,
            transaction.userId,
            transaction.date,
            transaction.description || '',
            transaction.category || 'Other',
            transaction.amount,
            transaction.type || (transaction.amount >= 0 ? 'income' : 'expense')
          ]
        );
        
        // Обновить баланс счета (только если транзакция новая)
        if (!transaction.skipBalanceUpdate) {
          await Account.updateBalance(
            transaction.accountId, 
            transaction.userId, 
            transaction.amount
          );
        }
        
        results.push({ id: result.id, ...transaction });
      }
      
      // Завершить транзакцию
      await run('COMMIT');
      
      return results;
    } catch (error) {
      // Откатить транзакцию в случае ошибки
      await run('ROLLBACK');
      throw error;
    }
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
      
      // Начать транзакцию
      await run('BEGIN TRANSACTION');
      
      // Вычислить разницу для обновления баланса
      let balanceDifference = 0;
      
      if (transactionData.amount !== undefined) {
        balanceDifference = transactionData.amount - currentTransaction.amount;
      }
      
      // Подготовить поля для обновления
      let updateFields = [];
      let params = [];
      
      if (transactionData.date) {
        updateFields.push('date = ?');
        params.push(transactionData.date);
      }
      
      if (transactionData.description !== undefined) {
        updateFields.push('description = ?');
        params.push(transactionData.description);
      }
      
      if (transactionData.category) {
        updateFields.push('category = ?');
        params.push(transactionData.category);
      }
      
      if (transactionData.amount !== undefined) {
        updateFields.push('amount = ?');
        params.push(transactionData.amount);
      }
      
      if (transactionData.type) {
        updateFields.push('type = ?');
        params.push(transactionData.type);
      }
      
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      params.push(userId);
      
      // Обновить транзакцию
      const result = await run(
        `UPDATE transactions 
         SET ${updateFields.join(', ')} 
         WHERE id = ? AND user_id = ?`,
        params
      );
      
      // Обновить баланс счета, если сумма изменилась
      if (balanceDifference !== 0) {
        await Account.updateBalance(
          currentTransaction.account_id,
          userId,
          balanceDifference
        );
      }
      
      // Завершить транзакцию
      await run('COMMIT');
      
      return result.changes > 0;
    } catch (error) {
      // Откатить транзакцию в случае ошибки
      await run('ROLLBACK');
      throw error;
    }
  }
  
  // Удаление транзакции
  static async delete(id, userId) {
    try {
      // Получить транзакцию для обновления баланса
      const transaction = await this.findById(id, userId);
      
      if (!transaction) {
        throw new Error('Транзакция не найдена');
      }
      
      // Начать транзакцию
      await run('BEGIN TRANSACTION');
      
      // Удалить транзакцию
      const result = await run(
        `DELETE FROM transactions WHERE id = ? AND user_id = ?`,
        [id, userId]
      );
      
      // Обновить баланс счета (вычесть сумму транзакции)
      await Account.updateBalance(
        transaction.account_id,
        userId,
        -transaction.amount
      );
      
      // Завершить транзакцию
      await run('COMMIT');
      
      return result.changes > 0;
    } catch (error) {
      // Откатить транзакцию в случае ошибки
      await run('ROLLBACK');
      throw error;
    }
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