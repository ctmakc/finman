const { query, get, run } = require('../db/database');

class Tag {
  // Создать тег
  static async create(userId, name, color = '#5D5CDE') {
    try {
      const result = await run(
        `INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)`,
        [userId, name.trim(), color]
      );
      return this.findById(result.id);
    } catch (error) {
      if (error.message.includes('UNIQUE')) {
        return { error: true, message: 'Тег с таким именем уже существует' };
      }
      throw error;
    }
  }

  // Найти по ID
  static async findById(id) {
    return get(`SELECT * FROM tags WHERE id = ?`, [id]);
  }

  // Получить все теги пользователя
  static async findByUserId(userId) {
    return query(
      `SELECT t.*, COUNT(tt.transaction_id) as usage_count
       FROM tags t
       LEFT JOIN transaction_tags tt ON t.id = tt.tag_id
       WHERE t.user_id = ?
       GROUP BY t.id
       ORDER BY usage_count DESC, t.name ASC`,
      [userId]
    );
  }

  // Обновить тег
  static async update(id, userId, data) {
    const { name, color } = data;
    const fields = [];
    const values = [];

    if (name !== undefined) {
      fields.push('name = ?');
      values.push(name.trim());
    }
    if (color !== undefined) {
      fields.push('color = ?');
      values.push(color);
    }

    if (fields.length === 0) return true;

    values.push(id, userId);

    try {
      await run(
        `UPDATE tags SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
        values
      );
      return true;
    } catch (error) {
      if (error.message.includes('UNIQUE')) {
        return { error: true, message: 'Тег с таким именем уже существует' };
      }
      throw error;
    }
  }

  // Удалить тег
  static async delete(id, userId) {
    const result = await run(
      `DELETE FROM tags WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    return result.changes > 0;
  }

  // Добавить тег к транзакции
  static async addToTransaction(transactionId, tagId) {
    try {
      await run(
        `INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`,
        [transactionId, tagId]
      );
      return true;
    } catch (error) {
      console.error('Ошибка добавления тега:', error);
      return false;
    }
  }

  // Удалить тег из транзакции
  static async removeFromTransaction(transactionId, tagId) {
    await run(
      `DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?`,
      [transactionId, tagId]
    );
    return true;
  }

  // Установить теги для транзакции (заменяет все существующие)
  static async setTransactionTags(transactionId, tagIds) {
    // Удаляем старые теги
    await run(
      `DELETE FROM transaction_tags WHERE transaction_id = ?`,
      [transactionId]
    );

    // Добавляем новые
    for (const tagId of tagIds) {
      await this.addToTransaction(transactionId, tagId);
    }

    return true;
  }

  // Получить теги транзакции
  static async getTransactionTags(transactionId) {
    return query(
      `SELECT t.* FROM tags t
       JOIN transaction_tags tt ON t.id = tt.tag_id
       WHERE tt.transaction_id = ?
       ORDER BY t.name`,
      [transactionId]
    );
  }

  // Получить транзакции по тегу
  static async getTransactionsByTag(tagId, userId, limit = 100) {
    return query(
      `SELECT tr.* FROM transactions tr
       JOIN transaction_tags tt ON tr.id = tt.transaction_id
       WHERE tt.tag_id = ? AND tr.user_id = ?
       ORDER BY tr.date DESC
       LIMIT ?`,
      [tagId, userId, limit]
    );
  }

  // Найти или создать тег по имени
  static async findOrCreate(userId, name, color = '#5D5CDE') {
    let tag = await get(
      `SELECT * FROM tags WHERE user_id = ? AND name = ?`,
      [userId, name.trim()]
    );

    if (!tag) {
      const result = await this.create(userId, name, color);
      if (result.error) return null;
      tag = result;
    }

    return tag;
  }

  // Получить популярные теги
  static async getPopular(userId, limit = 10) {
    return query(
      `SELECT t.*, COUNT(tt.transaction_id) as usage_count
       FROM tags t
       JOIN transaction_tags tt ON t.id = tt.tag_id
       WHERE t.user_id = ?
       GROUP BY t.id
       ORDER BY usage_count DESC
       LIMIT ?`,
      [userId, limit]
    );
  }

  // Поиск тегов
  static async search(userId, searchTerm) {
    return query(
      `SELECT * FROM tags
       WHERE user_id = ? AND name LIKE ?
       ORDER BY name`,
      [userId, `%${searchTerm}%`]
    );
  }

  // Статистика по тегу
  static async getTagStats(tagId, userId) {
    const stats = await get(
      `SELECT
         COUNT(*) as transaction_count,
         SUM(CASE WHEN tr.type = 'income' THEN tr.amount ELSE 0 END) as total_income,
         SUM(CASE WHEN tr.type = 'expense' THEN ABS(tr.amount) ELSE 0 END) as total_expense
       FROM transactions tr
       JOIN transaction_tags tt ON tr.id = tt.transaction_id
       WHERE tt.tag_id = ? AND tr.user_id = ?`,
      [tagId, userId]
    );

    return {
      transactionCount: stats.transaction_count || 0,
      totalIncome: stats.total_income || 0,
      totalExpense: stats.total_expense || 0
    };
  }
}

module.exports = Tag;
