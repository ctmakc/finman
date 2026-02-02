// ==================== МОДЕЛЬ ЦЕЛЕЙ НАКОПЛЕНИЯ ====================

const { query, get, run } = require('../db/database');

const SavingsGoal = {
  // Создание цели
  async create(data) {
    const result = await run(
      `INSERT INTO savings_goals (user_id, name, description, target_amount, currency, target_date, category, icon, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.user_id, data.name, data.description, data.target_amount,
       data.currency || 'UAH', data.target_date, data.category,
       data.icon || 'piggy-bank', data.color || '#5D5CDE']
    );
    return this.findById(result.id);
  },

  // Получение цели по ID
  async findById(id) {
    return get('SELECT * FROM savings_goals WHERE id = ?', [id]);
  },

  // Получение всех целей пользователя
  async findByUser(userId, includeCompleted = false) {
    const sql = includeCompleted
      ? 'SELECT * FROM savings_goals WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC'
      : 'SELECT * FROM savings_goals WHERE user_id = ? AND is_active = 1 AND is_completed = 0 ORDER BY created_at DESC';
    return query(sql, [userId]);
  },

  // Обновление цели
  async update(id, data) {
    const fields = [];
    const values = [];

    ['name', 'description', 'target_amount', 'target_date', 'category', 'icon', 'color', 'is_active'].forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    });

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await run(`UPDATE savings_goals SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  },

  // Добавить пополнение
  async addContribution(goalId, amount, note = null, transactionId = null) {
    const goal = await this.findById(goalId);
    if (!goal) throw new Error('Цель не найдена');

    // Добавляем запись о пополнении
    await run(
      `INSERT INTO goal_contributions (goal_id, amount, note, transaction_id) VALUES (?, ?, ?, ?)`,
      [goalId, amount, note, transactionId]
    );

    // Обновляем текущую сумму
    const newAmount = goal.current_amount + amount;
    const isCompleted = newAmount >= goal.target_amount;

    await run(
      `UPDATE savings_goals SET current_amount = ?, is_completed = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newAmount, isCompleted ? 1 : 0, isCompleted ? new Date().toISOString() : null, goalId]
    );

    return this.findById(goalId);
  },

  // Снять средства с цели
  async withdraw(goalId, amount, note = null) {
    const goal = await this.findById(goalId);
    if (!goal) throw new Error('Цель не найдена');
    if (goal.current_amount < amount) throw new Error('Недостаточно средств');

    // Добавляем запись об снятии (отрицательная сумма)
    await run(
      `INSERT INTO goal_contributions (goal_id, amount, note) VALUES (?, ?, ?)`,
      [goalId, -amount, note || 'Снятие средств']
    );

    // Обновляем текущую сумму
    await run(
      `UPDATE savings_goals SET current_amount = current_amount - ?, is_completed = 0, completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [amount, goalId]
    );

    return this.findById(goalId);
  },

  // Получить историю пополнений
  async getContributions(goalId) {
    return query(
      `SELECT gc.*, t.description as transaction_description
       FROM goal_contributions gc
       LEFT JOIN transactions t ON gc.transaction_id = t.id
       WHERE gc.goal_id = ?
       ORDER BY gc.created_at DESC`,
      [goalId]
    );
  },

  // Получить прогресс по цели
  async getProgress(goalId) {
    const goal = await this.findById(goalId);
    if (!goal) return null;

    const percent = goal.target_amount > 0
      ? Math.min(100, (goal.current_amount / goal.target_amount) * 100)
      : 0;

    const remaining = Math.max(0, goal.target_amount - goal.current_amount);

    // Рассчитываем сколько нужно откладывать в месяц
    let monthlyRequired = null;
    if (goal.target_date && !goal.is_completed) {
      const now = new Date();
      const target = new Date(goal.target_date);
      const monthsLeft = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
      if (monthsLeft > 0) {
        monthlyRequired = remaining / monthsLeft;
      }
    }

    return {
      ...goal,
      percent: Math.round(percent * 100) / 100,
      remaining,
      monthlyRequired
    };
  },

  // Статистика по всем целям пользователя
  async getStats(userId) {
    const goals = await this.findByUser(userId, true);

    const stats = {
      totalGoals: goals.length,
      activeGoals: goals.filter(g => !g.is_completed).length,
      completedGoals: goals.filter(g => g.is_completed).length,
      totalTarget: 0,
      totalSaved: 0,
      overallProgress: 0
    };

    goals.forEach(goal => {
      stats.totalTarget += goal.target_amount;
      stats.totalSaved += goal.current_amount;
    });

    if (stats.totalTarget > 0) {
      stats.overallProgress = Math.round((stats.totalSaved / stats.totalTarget) * 10000) / 100;
    }

    return stats;
  },

  // Удаление цели
  async delete(id) {
    return run('UPDATE savings_goals SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }
};

module.exports = SavingsGoal;
