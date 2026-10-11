// ==================== МОДЕЛЬ ЦЕЛЕЙ НАКОПЛЕНИЯ ====================

const { query, get, run, transaction } = require('../db/database');
const { defaultCurrency: DEFAULT_CURRENCY } = require('../config/config');
const money = require('../lib/money');
const dates = require('../lib/dates');

const SavingsGoal = {
  // Синхронный расчёт прогресса по строке цели (для списков/карточек).
  // Фронт (public/js/goals.js) читает: progress (0..100), remaining,
  // current_amount, target_amount, target_date. Дополнительно: percent (alias),
  // daysLeft, monthlyRequired, isReached.
  calculateProgress(goal, today = null) {
    if (!goal) return goal;
    const target = Number(goal.target_amount) || 0;
    const current = Number(goal.current_amount) || 0;
    const rawPercent = target > 0 ? (current / target) * 100 : 0;
    const percent = Math.round(Math.min(100, Math.max(0, rawPercent)) * 100) / 100;
    const remaining = Math.max(0, money.sub(target, current));

    const todayStr = today || dates.todayISO();
    let daysLeft = null;
    let monthlyRequired = null;
    if (goal.target_date) {
      daysLeft = dates.diffDays(todayStr, String(goal.target_date).slice(0, 10));
      if (remaining > 0 && daysLeft !== null && daysLeft > 0) {
        const months = Math.max(1, Math.ceil(daysLeft / 30));
        monthlyRequired = money.div(remaining, months);
      }
    }

    return {
      ...goal,
      progress: percent,
      percent,
      remaining,
      isReached: remaining <= 0 || !!goal.is_completed,
      daysLeft,
      monthlyRequired
    };
  },

  // Агрегированная статистика для /api/goals/stats.
  // Фронт читает activeGoals, totalSaved, overallProgress; остальное — для
  // виджетов/AI: totalTarget, totalRemaining, completedGoals, nextDeadline.
  async getUserStats(userId, today = null) {
    const todayStr = today || dates.todayISO();
    const goals = await this.findByUser(userId, true);
    const active = goals.filter((g) => !g.is_completed);

    let totalTarget = 0;
    let totalSaved = 0;
    let totalRemaining = 0;
    for (const g of active) {
      totalTarget = money.add(totalTarget, g.target_amount);
      totalSaved = money.add(totalSaved, g.current_amount);
      totalRemaining = money.add(totalRemaining, Math.max(0, money.sub(g.target_amount, g.current_amount)));
    }
    const overallProgress =
      totalTarget > 0 ? Math.round(Math.min(100, (totalSaved / totalTarget) * 100) * 100) / 100 : 0;

    // Ближайший дедлайн среди активных целей с датой >= сегодня.
    const dated = active
      .filter((g) => g.target_date && String(g.target_date).slice(0, 10) >= todayStr)
      .sort((a, b) => String(a.target_date).localeCompare(String(b.target_date)));
    const nextDeadline = dated.length
      ? {
          id: dated[0].id,
          name: dated[0].name,
          target_date: String(dated[0].target_date).slice(0, 10),
          daysLeft: dates.diffDays(todayStr, String(dated[0].target_date).slice(0, 10)),
          remaining: Math.max(0, money.sub(dated[0].target_amount, dated[0].current_amount))
        }
      : null;

    return {
      totalGoals: goals.length,
      activeGoals: active.length,
      completedGoals: goals.length - active.length,
      totalTarget,
      totalSaved,
      totalRemaining,
      overallProgress,
      nextDeadline
    };
  },

  // Создание цели
  async create(data) {
    const result = await run(
      `INSERT INTO savings_goals (user_id, name, description, target_amount, current_amount, currency, target_date, category, icon, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.user_id, data.name, data.description, data.target_amount,
       money.round(data.current_amount || 0),
       data.currency || DEFAULT_CURRENCY, data.target_date, data.category,
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
    if (!goal) throw new Error('Goal not found');
    // Тело формы/JSON может прислать строку: 50 + "100" = "50100".
    const value = money.round(Number(amount));
    if (!(value > 0)) throw new Error('Amount must be positive');

    await transaction(async () => {
      await run(
        `INSERT INTO goal_contributions (goal_id, amount, note, transaction_id) VALUES (?, ?, ?, ?)`,
        [goalId, value, note, transactionId]
      );
      // Атомарно в SQL: параллельные пополнения не теряют друг друга.
      await run(
        `UPDATE savings_goals
         SET current_amount = ROUND(current_amount + ?, 2),
             is_completed = CASE WHEN ROUND(current_amount + ?, 2) >= target_amount THEN 1 ELSE 0 END,
             completed_at = CASE WHEN ROUND(current_amount + ?, 2) >= target_amount THEN COALESCE(completed_at, ?) ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [value, value, value, new Date().toISOString(), goalId]
      );
    });

    return this.findById(goalId);
  },

  // Снять средства с цели
  async withdraw(goalId, amount, note = null) {
    const goal = await this.findById(goalId);
    if (!goal) throw new Error('Goal not found');
    const value = money.round(Number(amount));
    if (!(value > 0)) throw new Error('Amount must be positive');

    await transaction(async () => {
      // Проверка остатка внутри транзакции и в самом UPDATE.
      const res = await run(
        `UPDATE savings_goals
         SET current_amount = ROUND(current_amount - ?, 2),
             is_completed = CASE WHEN ROUND(current_amount - ?, 2) >= target_amount THEN 1 ELSE 0 END,
             completed_at = CASE WHEN ROUND(current_amount - ?, 2) >= target_amount THEN completed_at ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND current_amount >= ?`,
        [value, value, value, goalId, value]
      );
      if (res.changes === 0) throw new Error('Insufficient funds');
      await run(
        `INSERT INTO goal_contributions (goal_id, amount, note) VALUES (?, ?, ?)`,
        [goalId, -value, note || 'Withdrawal']
      );
    });

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
