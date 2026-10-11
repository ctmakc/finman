const crypto = require('crypto');
const { query, get, run, transaction } = require('../db/database');
const Account = require('./account');
const money = require('../lib/money');
const { AppError } = require('../middleware/error');

// Знак хранимой суммы задаётся типом (единое правило для всех писателей —
// UI, импорт, чеки, регулярные платежи):
//   expense  -> amount < 0      income -> amount > 0
//   transfer -> знак ноги как есть (списание < 0, зачисление > 0)
//   opening  -> как есть (начальный баланс кредитки может быть отрицательным)
// Дельта баланса счёта всегда равна хранимой сумме, поэтому балансы и
// SUM(amount) по счёту (reconcile) сходятся без знаний о типе.
function normalizeType(type, amount) {
  if (type) return type;
  return Number(amount) >= 0 ? 'income' : 'expense';
}
function signedAmount(amount, type) {
  const abs = Math.abs(money.round(amount));
  if (type === 'expense') return -abs;
  if (type === 'income') return abs;
  return money.round(amount);
}

class Transaction {
  static normalizeType = normalizeType;
  static signedAmount = signedAmount;

  // Создание транзакции
  static async create(transactionData) {
    // Округляем сумму до копеек, знак — по типу.
    const type = normalizeType(transactionData.type, transactionData.amount);
    const amount = signedAmount(transactionData.amount, type);
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
          type
        ]
      );
      await Account.updateBalance(
        transactionData.accountId,
        transactionData.userId,
        amount
      );
      return { id: result.id, ...transactionData, amount, type };
    });
  }
  
  // Создание нескольких транзакций (импорт)
  static async bulkCreate(transactions) {
    return transaction(async () => {
      const results = [];
      for (const tx of transactions) {
        const type = normalizeType(tx.type, tx.amount);
        const amount = signedAmount(tx.amount, type);
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
            type
          ]
        );
        if (!tx.skipBalanceUpdate) {
          await Account.updateBalance(tx.accountId, tx.userId, amount);
        }
        results.push({ id: result.id, ...tx, amount, type });
      }
      return results;
    });
  }

  // Двойная запись перевода между двумя счетами одного пользователя.
  // Создаёт ДВЕ строки type='transfer' с общим transfer_id:
  //   - со счёта-источника: amount = -amount, баланс(from) -= amount
  //   - на счёт-получатель:  amount = +amount, баланс(to)   += amount
  // Всё внутри transaction() -> атомарно (обе строки + оба баланса или ничего).
  // Тип 'transfer' автоматически исключён из агрегатов income/expense
  // (они фильтруют type IN ('income','expense')), поэтому переводы не искажают
  // статистику доходов/расходов и не меняют чистый итог по пользователю.
  static async createTransfer({ userId, fromAccountId, toAccountId, amount, date, description }) {
    const amt = money.round(amount);

    if (!(amt > 0)) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Сумма перевода должна быть положительной');
    }
    if (String(fromAccountId) === String(toAccountId)) {
      throw new AppError(400, 'SAME_ACCOUNT', 'Нельзя переводить на тот же счёт');
    }

    const transferId = crypto.randomUUID();
    const desc = description || 'Перевод';
    const txDate = date || new Date().toISOString().split('T')[0];

    return transaction(async () => {
      // Строка-списание со счёта-источника.
      const fromRow = await run(
        `INSERT INTO transactions
         (account_id, user_id, date, description, category, amount, type, transfer_id)
         VALUES (?, ?, ?, ?, ?, ?, 'transfer', ?)`,
        [fromAccountId, userId, txDate, desc, 'Перевод', -amt, transferId]
      );
      await Account.updateBalance(fromAccountId, userId, -amt);

      // Строка-зачисление на счёт-получатель.
      const toRow = await run(
        `INSERT INTO transactions
         (account_id, user_id, date, description, category, amount, type, transfer_id)
         VALUES (?, ?, ?, ?, ?, ?, 'transfer', ?)`,
        [toAccountId, userId, txDate, desc, 'Перевод', amt, transferId]
      );
      await Account.updateBalance(toAccountId, userId, amt);

      return {
        transferId,
        amount: amt,
        date: txDate,
        description: desc,
        from: { id: fromRow.id, accountId: fromAccountId, amount: -amt },
        to: { id: toRow.id, accountId: toAccountId, amount: amt },
      };
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
  
  // Обновление транзакции.
  // Обычная строка: знак новой суммы — по (новому или текущему) типу, дельта
  // баланса = новая_сумма − старая_сумма (смена типа переносит сумму на другую
  // сторону). Нога перевода: см. updateTransferLegs — правятся обе ноги.
  static async update(id, userId, transactionData) {
    const currentTransaction = await this.findById(id, userId);

    if (!currentTransaction) {
      throw new Error('Транзакция не найдена');
    }

    if (currentTransaction.transfer_id) {
      return this.updateTransferLegs(currentTransaction, userId, transactionData);
    }

    const newType = transactionData.type || currentTransaction.type;
    const hasAmount = transactionData.amount !== undefined;
    let newAmount = currentTransaction.amount;
    if (hasAmount || transactionData.type) {
      newAmount = signedAmount(hasAmount ? transactionData.amount : currentTransaction.amount, newType);
    }
    const balanceDifference = money.sub(newAmount, currentTransaction.amount);

    return transaction(async () => {
      const updateFields = [];
      const params = [];
      if (transactionData.date) { updateFields.push('date = ?'); params.push(transactionData.date); }
      if (transactionData.description !== undefined) { updateFields.push('description = ?'); params.push(transactionData.description); }
      if (transactionData.category) { updateFields.push('category = ?'); params.push(transactionData.category); }
      if (newAmount !== currentTransaction.amount) { updateFields.push('amount = ?'); params.push(newAmount); }
      if (newType !== currentTransaction.type) { updateFields.push('type = ?'); params.push(newType); }
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
  }

  // Правка перевода через любую из его ног. Обе строки с этим transfer_id
  // меняются вместе: дата/описание/категория — одинаково; сумма — по модулю
  // (списание остаётся < 0, зачисление > 0), оба баланса сдвигаются на свои
  // дельты. Тип ноги перевода менять нельзя (AppError 400).
  static async updateTransferLegs(leg, userId, transactionData) {
    if (transactionData.type && transactionData.type !== 'transfer') {
      throw new AppError(400, 'TRANSFER_TYPE_LOCKED', 'Тип ноги перевода изменить нельзя — удалите перевод и создайте транзакцию');
    }
    let newAbs = null;
    if (transactionData.amount !== undefined) {
      newAbs = Math.abs(money.round(transactionData.amount));
      if (!(newAbs > 0)) {
        throw new AppError(400, 'INVALID_AMOUNT', 'Сумма перевода должна быть положительной');
      }
    }

    return transaction(async () => {
      const legs = await query(
        `SELECT id, account_id, amount FROM transactions WHERE transfer_id = ? AND user_id = ?`,
        [leg.transfer_id, userId]
      );
      let changed = 0;
      for (const row of legs) {
        const updateFields = [];
        const params = [];
        if (transactionData.date) { updateFields.push('date = ?'); params.push(transactionData.date); }
        if (transactionData.description !== undefined) { updateFields.push('description = ?'); params.push(transactionData.description); }
        if (transactionData.category) { updateFields.push('category = ?'); params.push(transactionData.category); }
        if (newAbs !== null) {
          const newAmount = row.amount < 0 ? -newAbs : newAbs;
          const delta = money.sub(newAmount, row.amount);
          if (delta !== 0) {
            updateFields.push('amount = ?'); params.push(newAmount);
            await Account.updateBalance(row.account_id, userId, delta);
          }
        }
        updateFields.push('updated_at = CURRENT_TIMESTAMP');
        params.push(row.id, userId);
        const result = await run(
          `UPDATE transactions SET ${updateFields.join(', ')} WHERE id = ? AND user_id = ?`,
          params
        );
        changed += result.changes;
      }
      return changed > 0;
    });
  }

  // Удаление транзакции. Нога перевода удаляется вместе с парной: обе строки
  // и оба баланса — атомарно, иначе остаётся «сирота» и деньги появляются из
  // воздуха на счёте-получателе.
  static async delete(id, userId) {
    const row = await this.findById(id, userId);
    if (!row) {
      throw new Error('Транзакция не найдена');
    }
    return transaction(async () => {
      const legs = row.transfer_id
        ? await query(
            `SELECT id, account_id, amount FROM transactions WHERE transfer_id = ? AND user_id = ?`,
            [row.transfer_id, userId]
          )
        : [row];
      let changes = 0;
      for (const leg of legs) {
        const result = await run(
          `DELETE FROM transactions WHERE id = ? AND user_id = ?`,
          [leg.id, userId]
        );
        changes += result.changes;
        await Account.updateBalance(leg.account_id, userId, -leg.amount);
      }
      return changes > 0;
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