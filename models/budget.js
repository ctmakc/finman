const { query, get, run } = require('../db/database');

class Budget {
  // Создание бюджета
  static async create(budgetData) {
    try {
      const result = await run(
        `INSERT INTO budgets
         (user_id, name, category, amount, period, start_date, end_date, currency, notify_at_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          budgetData.userId,
          budgetData.name,
          budgetData.category || null,
          budgetData.amount,
          budgetData.period || 'monthly',
          budgetData.startDate,
          budgetData.endDate || null,
          budgetData.currency || 'UAH',
          budgetData.notifyAtPercent || 80
        ]
      );

      return { id: result.id, ...budgetData };
    } catch (error) {
      throw error;
    }
  }

  // Получение всех бюджетов пользователя
  static async findByUserId(userId, includeInactive = false) {
    try {
      const sql = includeInactive
        ? `SELECT * FROM budgets WHERE user_id = ? ORDER BY created_at DESC`
        : `SELECT * FROM budgets WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC`;

      const budgets = await query(sql, [userId]);
      return budgets.map(b => this.formatBudget(b));
    } catch (error) {
      throw error;
    }
  }

  // Получение активных бюджетов для текущего периода
  static async getActiveBudgets(userId) {
    try {
      const today = new Date().toISOString().split('T')[0];

      const budgets = await query(
        `SELECT * FROM budgets
         WHERE user_id = ? AND is_active = 1
         AND start_date <= ?
         AND (end_date IS NULL OR end_date >= ?)
         ORDER BY category, name`,
        [userId, today, today]
      );

      return budgets.map(b => this.formatBudget(b));
    } catch (error) {
      throw error;
    }
  }

  // Получение бюджета по ID
  static async findById(id, userId) {
    try {
      const budget = await get(
        `SELECT * FROM budgets WHERE id = ? AND user_id = ?`,
        [id, userId]
      );

      return budget ? this.formatBudget(budget) : null;
    } catch (error) {
      throw error;
    }
  }

  // Получение бюджета по категории
  static async findByCategory(userId, category) {
    try {
      const today = new Date().toISOString().split('T')[0];

      const budget = await get(
        `SELECT * FROM budgets
         WHERE user_id = ? AND category = ? AND is_active = 1
         AND start_date <= ?
         AND (end_date IS NULL OR end_date >= ?)`,
        [userId, category, today, today]
      );

      return budget ? this.formatBudget(budget) : null;
    } catch (error) {
      throw error;
    }
  }

  // Форматирование бюджета
  static formatBudget(budget) {
    const spent = budget.spent || 0;
    const amount = budget.amount || 0;
    const percentUsed = amount > 0 ? Math.round((spent / amount) * 100) : 0;
    const remaining = amount - spent;

    return {
      id: budget.id,
      userId: budget.user_id,
      name: budget.name,
      category: budget.category,
      amount: amount,
      spent: spent,
      remaining: remaining,
      percentUsed: percentUsed,
      period: budget.period,
      startDate: budget.start_date,
      endDate: budget.end_date,
      currency: budget.currency,
      notifyAtPercent: budget.notify_at_percent,
      isActive: budget.is_active === 1,
      isOverBudget: spent > amount,
      shouldNotify: percentUsed >= budget.notify_at_percent,
      createdAt: budget.created_at,
      updatedAt: budget.updated_at
    };
  }

  // Обновление бюджета
  static async update(id, userId, budgetData) {
    try {
      const updates = [];
      const params = [];

      if (budgetData.name !== undefined) {
        updates.push('name = ?');
        params.push(budgetData.name);
      }
      if (budgetData.category !== undefined) {
        updates.push('category = ?');
        params.push(budgetData.category);
      }
      if (budgetData.amount !== undefined) {
        updates.push('amount = ?');
        params.push(budgetData.amount);
      }
      if (budgetData.period !== undefined) {
        updates.push('period = ?');
        params.push(budgetData.period);
      }
      if (budgetData.startDate !== undefined) {
        updates.push('start_date = ?');
        params.push(budgetData.startDate);
      }
      if (budgetData.endDate !== undefined) {
        updates.push('end_date = ?');
        params.push(budgetData.endDate);
      }
      if (budgetData.currency !== undefined) {
        updates.push('currency = ?');
        params.push(budgetData.currency);
      }
      if (budgetData.notifyAtPercent !== undefined) {
        updates.push('notify_at_percent = ?');
        params.push(budgetData.notifyAtPercent);
      }
      if (budgetData.isActive !== undefined) {
        updates.push('is_active = ?');
        params.push(budgetData.isActive ? 1 : 0);
      }

      if (updates.length === 0) {
        return false;
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id, userId);

      const result = await run(
        `UPDATE budgets SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        params
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Обновление суммы потраченного
  static async updateSpent(id, userId, spent) {
    try {
      const result = await run(
        `UPDATE budgets SET spent = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [spent, id, userId]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Добавление к потраченному
  static async addToSpent(id, userId, amount) {
    try {
      const result = await run(
        `UPDATE budgets SET spent = spent + ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [amount, id, userId]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Пересчет потраченного на основе транзакций
  static async recalculateSpent(userId, category = null) {
    try {
      // Получаем активные бюджеты
      const budgets = category
        ? [await this.findByCategory(userId, category)].filter(Boolean)
        : await this.getActiveBudgets(userId);

      for (const budget of budgets) {
        // Определяем даты периода
        const { startDate, endDate } = this.getPeriodDates(budget);

        // Считаем сумму расходов по категории за период
        let sql, params;

        if (budget.category) {
          sql = `SELECT COALESCE(SUM(ABS(amount)), 0) as total
                 FROM transactions
                 WHERE user_id = ? AND category = ? AND type = 'expense'
                 AND date >= ? AND date <= ?`;
          params = [userId, budget.category, startDate, endDate];
        } else {
          // Общий бюджет - все расходы
          sql = `SELECT COALESCE(SUM(ABS(amount)), 0) as total
                 FROM transactions
                 WHERE user_id = ? AND type = 'expense'
                 AND date >= ? AND date <= ?`;
          params = [userId, startDate, endDate];
        }

        const result = await get(sql, params);
        await this.updateSpent(budget.id, userId, result.total);
      }

      return true;
    } catch (error) {
      throw error;
    }
  }

  // Получение дат периода для бюджета
  static getPeriodDates(budget) {
    const now = new Date();
    let startDate, endDate;

    switch (budget.period) {
      case 'daily':
        startDate = now.toISOString().split('T')[0];
        endDate = startDate;
        break;

      case 'weekly':
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const monday = new Date(now);
        monday.setDate(now.getDate() + mondayOffset);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        startDate = monday.toISOString().split('T')[0];
        endDate = sunday.toISOString().split('T')[0];
        break;

      case 'monthly':
      default:
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
        break;

      case 'yearly':
        startDate = `${now.getFullYear()}-01-01`;
        endDate = `${now.getFullYear()}-12-31`;
        break;

      case 'custom':
        startDate = budget.startDate;
        endDate = budget.endDate || now.toISOString().split('T')[0];
        break;
    }

    return { startDate, endDate };
  }

  // Удаление (деактивация) бюджета
  static async delete(id, userId) {
    try {
      const result = await run(
        `UPDATE budgets SET is_active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [id, userId]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Полное удаление бюджета
  static async hardDelete(id, userId) {
    try {
      const result = await run(
        `DELETE FROM budgets WHERE id = ? AND user_id = ?`,
        [id, userId]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Получение статистики по бюджетам
  static async getStats(userId) {
    try {
      const budgets = await this.getActiveBudgets(userId);

      const stats = {
        totalBudgets: budgets.length,
        totalBudgetAmount: 0,
        totalSpent: 0,
        overBudgetCount: 0,
        nearLimitCount: 0,
        budgets: []
      };

      for (const budget of budgets) {
        stats.totalBudgetAmount += budget.amount;
        stats.totalSpent += budget.spent;

        if (budget.isOverBudget) {
          stats.overBudgetCount++;
        } else if (budget.shouldNotify) {
          stats.nearLimitCount++;
        }

        stats.budgets.push({
          id: budget.id,
          name: budget.name,
          category: budget.category,
          amount: budget.amount,
          spent: budget.spent,
          percentUsed: budget.percentUsed,
          status: budget.isOverBudget ? 'over' : (budget.shouldNotify ? 'warning' : 'ok')
        });
      }

      stats.totalRemaining = stats.totalBudgetAmount - stats.totalSpent;
      stats.overallPercentUsed = stats.totalBudgetAmount > 0
        ? Math.round((stats.totalSpent / stats.totalBudgetAmount) * 100)
        : 0;

      return stats;
    } catch (error) {
      throw error;
    }
  }

  // Сброс потраченного для нового периода
  static async resetForNewPeriod(userId, period) {
    try {
      const result = await run(
        `UPDATE budgets SET spent = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND period = ? AND is_active = 1`,
        [userId, period]
      );

      return result.changes;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Budget;
