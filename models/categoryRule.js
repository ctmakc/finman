// models/categoryRule.js — CRUD для детерминированных правил категоризации.
// Таблица category_rules (см. migrations/011_rules.js). Все операции
// ограничены user_id (изоляция арендаторов).
const { query, get, run } = require('../db/database');

// Допустимые значения полей (валидируются на уровне модели, чтобы
// гарантировать целостность независимо от вызывающего кода).
const MATCH_FIELDS = ['description', 'category', 'amount'];
const MATCH_OPS = ['contains', 'equals', 'gt', 'lt', 'regex'];

function normalizeField(field) {
  return MATCH_FIELDS.includes(field) ? field : 'description';
}

function normalizeOp(op) {
  return MATCH_OPS.includes(op) ? op : 'contains';
}

class CategoryRule {
  static get MATCH_FIELDS() {
    return MATCH_FIELDS.slice();
  }

  static get MATCH_OPS() {
    return MATCH_OPS.slice();
  }

  // Создать правило
  static async create(userId, data = {}) {
    const match_field = normalizeField(data.match_field);
    const match_op = normalizeOp(data.match_op);
    const match_value = data.match_value == null ? '' : String(data.match_value);
    const set_category = data.set_category == null ? '' : String(data.set_category).trim();
    const priority = Number.isFinite(Number(data.priority)) ? parseInt(data.priority, 10) : 100;
    const is_active = data.is_active === undefined ? 1 : (data.is_active ? 1 : 0);

    if (!set_category) {
      return { error: true, message: 'Не указана категория (set_category)' };
    }
    if (!match_value) {
      return { error: true, message: 'Не указано значение условия (match_value)' };
    }

    const result = await run(
      `INSERT INTO category_rules
         (user_id, priority, match_field, match_op, match_value, set_category, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, priority, match_field, match_op, match_value, set_category, is_active]
    );
    return this.findById(result.id, userId);
  }

  // Найти правило по ID (в пределах пользователя)
  static async findById(id, userId) {
    return get(
      `SELECT * FROM category_rules WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
  }

  // Все правила пользователя в порядке приоритета
  static async findByUserId(userId, { activeOnly = false } = {}) {
    let sql = `SELECT * FROM category_rules WHERE user_id = ?`;
    if (activeOnly) sql += ` AND is_active = 1`;
    sql += ` ORDER BY priority ASC, id ASC`;
    return query(sql, [userId]);
  }

  // Обновить правило (частичное)
  static async update(id, userId, data = {}) {
    const current = await this.findById(id, userId);
    if (!current) return null;

    const fields = [];
    const values = [];

    if (data.priority !== undefined) {
      const p = parseInt(data.priority, 10);
      fields.push('priority = ?');
      values.push(Number.isFinite(p) ? p : current.priority);
    }
    if (data.match_field !== undefined) {
      fields.push('match_field = ?');
      values.push(normalizeField(data.match_field));
    }
    if (data.match_op !== undefined) {
      fields.push('match_op = ?');
      values.push(normalizeOp(data.match_op));
    }
    if (data.match_value !== undefined) {
      fields.push('match_value = ?');
      values.push(String(data.match_value));
    }
    if (data.set_category !== undefined) {
      const cat = String(data.set_category).trim();
      if (!cat) return { error: true, message: 'Категория не может быть пустой' };
      fields.push('set_category = ?');
      values.push(cat);
    }
    if (data.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(data.is_active ? 1 : 0);
    }

    if (fields.length === 0) return current;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, userId);

    await run(
      `UPDATE category_rules SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
      values
    );
    return this.findById(id, userId);
  }

  // Удалить правило
  static async delete(id, userId) {
    const result = await run(
      `DELETE FROM category_rules WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    return result.changes > 0;
  }
}

module.exports = CategoryRule;
