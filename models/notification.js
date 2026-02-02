// ==================== МОДЕЛЬ УВЕДОМЛЕНИЙ ====================

const { query, get, run } = require('../db/database');

const Notification = {
  // Типы уведомлений
  TYPES: {
    BUDGET_WARNING: 'budget_warning',       // Приближение к лимиту бюджета
    BUDGET_EXCEEDED: 'budget_exceeded',     // Превышение бюджета
    RECURRING_REMINDER: 'recurring_reminder', // Напоминание о платеже
    RECURRING_DUE: 'recurring_due',         // Платёж сегодня
    GOAL_MILESTONE: 'goal_milestone',       // Достижение вехи цели
    GOAL_COMPLETED: 'goal_completed',       // Цель достигнута
    DEBT_DUE: 'debt_due',                   // Долг скоро истекает
    DEBT_OVERDUE: 'debt_overdue',           // Долг просрочен
    WEEKLY_SUMMARY: 'weekly_summary',       // Еженедельная сводка
    SYSTEM: 'system'                        // Системное уведомление
  },

  // Создание уведомления
  async create(data) {
    const result = await run(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES (?, ?, ?, ?, ?)`,
      [data.user_id, data.type, data.title, data.message,
       data.data ? JSON.stringify(data.data) : null]
    );
    return this.findById(result.id);
  },

  // Массовое создание уведомлений
  async createMany(notifications) {
    const results = [];
    for (const data of notifications) {
      const result = await this.create(data);
      results.push(result);
    }
    return results;
  },

  // Получить уведомление по ID
  async findById(id) {
    const notification = await get('SELECT * FROM notifications WHERE id = ?', [id]);
    if (notification && notification.data) {
      try {
        notification.data = JSON.parse(notification.data);
      } catch {}
    }
    return notification;
  },

  // Получить уведомления пользователя
  async findByUser(userId, options = {}) {
    let sql = 'SELECT * FROM notifications WHERE user_id = ?';
    const params = [userId];

    if (options.unreadOnly) {
      sql += ' AND is_read = 0';
    }

    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    sql += ' ORDER BY created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const notifications = await query(sql, params);

    return notifications.map(n => {
      if (n.data) {
        try {
          n.data = JSON.parse(n.data);
        } catch {}
      }
      return n;
    });
  },

  // Количество непрочитанных
  async countUnread(userId) {
    const result = await get(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    );
    return result ? result.count : 0;
  },

  // Отметить как прочитанное
  async markAsRead(id) {
    return run(
      'UPDATE notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
  },

  // Отметить все как прочитанные
  async markAllAsRead(userId) {
    return run(
      'UPDATE notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 0',
      [userId]
    );
  },

  // Удалить уведомление
  async delete(id) {
    return run('DELETE FROM notifications WHERE id = ?', [id]);
  },

  // Очистить старые уведомления (старше N дней)
  async clearOld(userId, daysToKeep = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    return run(
      'DELETE FROM notifications WHERE user_id = ? AND created_at < ?',
      [userId, cutoffDate.toISOString()]
    );
  },

  // ==================== НАСТРОЙКИ ====================

  // Получить настройки уведомлений
  async getSettings(userId) {
    let settings = await get('SELECT * FROM notification_settings WHERE user_id = ?', [userId]);

    if (!settings) {
      // Создаём настройки по умолчанию
      await run(
        `INSERT INTO notification_settings (user_id) VALUES (?)`,
        [userId]
      );
      settings = await get('SELECT * FROM notification_settings WHERE user_id = ?', [userId]);
    }

    return settings;
  },

  // Обновить настройки
  async updateSettings(userId, data) {
    const fields = [];
    const values = [];

    ['budget_alerts', 'recurring_reminders', 'goal_milestones',
     'debt_reminders', 'weekly_summary', 'push_enabled', 'email_enabled'].forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field] ? 1 : 0);
      }
    });

    if (fields.length === 0) return this.getSettings(userId);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId);

    await run(`UPDATE notification_settings SET ${fields.join(', ')} WHERE user_id = ?`, values);
    return this.getSettings(userId);
  },

  // ==================== ГЕНЕРАЦИЯ УВЕДОМЛЕНИЙ ====================

  // Проверка бюджетов и генерация уведомлений
  async checkBudgets(userId) {
    const settings = await this.getSettings(userId);
    if (!settings.budget_alerts) return [];

    const budgets = await query(
      `SELECT * FROM budgets WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    const notifications = [];

    for (const budget of budgets) {
      const percent = budget.amount > 0 ? (budget.spent / budget.amount) * 100 : 0;

      if (percent >= 100) {
        // Превышен
        const existing = await get(
          `SELECT * FROM notifications
           WHERE user_id = ? AND type = ? AND data LIKE ? AND created_at > date('now', '-1 day')`,
          [userId, this.TYPES.BUDGET_EXCEEDED, `%"budget_id":${budget.id}%`]
        );

        if (!existing) {
          notifications.push({
            user_id: userId,
            type: this.TYPES.BUDGET_EXCEEDED,
            title: `Бюджет "${budget.name}" превышен!`,
            message: `Потрачено ${budget.spent} из ${budget.amount} (${Math.round(percent)}%)`,
            data: { budget_id: budget.id, percent }
          });
        }
      } else if (percent >= budget.notify_at_percent) {
        // Приближение к лимиту
        const existing = await get(
          `SELECT * FROM notifications
           WHERE user_id = ? AND type = ? AND data LIKE ? AND created_at > date('now', '-1 day')`,
          [userId, this.TYPES.BUDGET_WARNING, `%"budget_id":${budget.id}%`]
        );

        if (!existing) {
          notifications.push({
            user_id: userId,
            type: this.TYPES.BUDGET_WARNING,
            title: `Бюджет "${budget.name}" почти исчерпан`,
            message: `Использовано ${Math.round(percent)}% бюджета`,
            data: { budget_id: budget.id, percent }
          });
        }
      }
    }

    if (notifications.length > 0) {
      await this.createMany(notifications);
    }

    return notifications;
  },

  // Проверка регулярных платежей
  async checkRecurringPayments(userId) {
    const settings = await this.getSettings(userId);
    if (!settings.recurring_reminders) return [];

    const today = new Date().toISOString().split('T')[0];
    const threeDaysLater = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const payments = await query(
      `SELECT rp.*, a.name as account_name FROM recurring_payments rp
       INNER JOIN accounts a ON rp.account_id = a.id
       WHERE rp.user_id = ? AND rp.is_active = 1
         AND rp.next_payment_date <= ?`,
      [userId, threeDaysLater]
    );

    const notifications = [];

    for (const payment of payments) {
      const isToday = payment.next_payment_date === today;
      const type = isToday ? this.TYPES.RECURRING_DUE : this.TYPES.RECURRING_REMINDER;

      const existing = await get(
        `SELECT * FROM notifications
         WHERE user_id = ? AND type = ? AND data LIKE ? AND created_at > date('now', '-1 day')`,
        [userId, type, `%"payment_id":${payment.id}%`]
      );

      if (!existing) {
        notifications.push({
          user_id: userId,
          type,
          title: isToday ? `Платёж "${payment.name}" сегодня` : `Скоро платёж "${payment.name}"`,
          message: `${payment.amount} ${payment.account_name} - ${payment.next_payment_date}`,
          data: { payment_id: payment.id, date: payment.next_payment_date }
        });
      }
    }

    if (notifications.length > 0) {
      await this.createMany(notifications);
    }

    return notifications;
  },

  // Проверка долгов
  async checkDebts(userId) {
    const settings = await this.getSettings(userId);
    if (!settings.debt_reminders) return [];

    const today = new Date().toISOString().split('T')[0];
    const sevenDaysLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const debts = await query(
      `SELECT * FROM debts WHERE user_id = ? AND is_active = 1 AND is_paid = 0 AND due_date <= ?`,
      [userId, sevenDaysLater]
    );

    const notifications = [];

    for (const debt of debts) {
      const isOverdue = debt.due_date < today;
      const type = isOverdue ? this.TYPES.DEBT_OVERDUE : this.TYPES.DEBT_DUE;

      const existing = await get(
        `SELECT * FROM notifications
         WHERE user_id = ? AND type = ? AND data LIKE ? AND created_at > date('now', '-1 day')`,
        [userId, type, `%"debt_id":${debt.id}%`]
      );

      if (!existing) {
        const remaining = debt.amount - debt.paid_amount;
        notifications.push({
          user_id: userId,
          type,
          title: isOverdue ? `Долг "${debt.name}" просрочен!` : `Долг "${debt.name}" скоро истекает`,
          message: `Осталось выплатить: ${remaining}. Срок: ${debt.due_date}`,
          data: { debt_id: debt.id, due_date: debt.due_date, remaining }
        });
      }
    }

    if (notifications.length > 0) {
      await this.createMany(notifications);
    }

    return notifications;
  },

  // Запуск всех проверок
  async runAllChecks(userId) {
    const results = {
      budgets: await this.checkBudgets(userId),
      recurring: await this.checkRecurringPayments(userId),
      debts: await this.checkDebts(userId)
    };

    return results;
  }
};

module.exports = Notification;
