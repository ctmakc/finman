const { query, get, run } = require('../db/database');

class RecurringPayment {
  // Создание регулярного платежа
  static async create(paymentData) {
    const {
      userId,
      accountId,
      name,
      description,
      amount,
      type,
      category,
      frequency,
      dayOfMonth,
      dayOfWeek,
      startDate,
      endDate,
      autoCreate,
      notifyBefore
    } = paymentData;

    const nextPaymentDate = this.calculateNextPaymentDate(
      startDate,
      frequency,
      dayOfMonth,
      dayOfWeek
    );

    const result = await run(
      `INSERT INTO recurring_payments
       (user_id, account_id, name, description, amount, type, category,
        frequency, day_of_month, day_of_week, start_date, end_date,
        next_payment_date, auto_create, notify_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        accountId,
        name,
        description || null,
        amount,
        type || 'expense',
        category || null,
        frequency || 'monthly',
        dayOfMonth || null,
        dayOfWeek || null,
        startDate,
        endDate || null,
        nextPaymentDate,
        autoCreate ? 1 : 0,
        notifyBefore || 3
      ]
    );

    return this.findById(result.id);
  }

  // Поиск по ID
  static async findById(id) {
    return get(
      `SELECT rp.*, a.name as account_name, a.currency as account_currency
       FROM recurring_payments rp
       JOIN accounts a ON rp.account_id = a.id
       WHERE rp.id = ?`,
      [id]
    );
  }

  // Получение всех платежей пользователя
  static async findByUserId(userId, includeInactive = false) {
    const activeCondition = includeInactive ? '' : 'AND rp.is_active = 1';

    return query(
      `SELECT rp.*, a.name as account_name, a.currency as account_currency
       FROM recurring_payments rp
       JOIN accounts a ON rp.account_id = a.id
       WHERE rp.user_id = ? ${activeCondition}
       ORDER BY rp.next_payment_date ASC`,
      [userId]
    );
  }

  // Получение платежей для напоминания (в ближайшие N дней)
  static async getUpcoming(userId, days = 7) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return query(
      `SELECT rp.*, a.name as account_name, a.currency as account_currency
       FROM recurring_payments rp
       JOIN accounts a ON rp.account_id = a.id
       WHERE rp.user_id = ?
         AND rp.is_active = 1
         AND rp.next_payment_date <= ?
         AND (rp.end_date IS NULL OR rp.end_date >= date('now'))
       ORDER BY rp.next_payment_date ASC`,
      [userId, futureDate.toISOString().split('T')[0]]
    );
  }

  // Получение просроченных платежей
  static async getOverdue(userId) {
    const today = new Date().toISOString().split('T')[0];

    return query(
      `SELECT rp.*, a.name as account_name, a.currency as account_currency
       FROM recurring_payments rp
       JOIN accounts a ON rp.account_id = a.id
       WHERE rp.user_id = ?
         AND rp.is_active = 1
         AND rp.next_payment_date < ?
         AND (rp.end_date IS NULL OR rp.end_date >= date('now'))
       ORDER BY rp.next_payment_date ASC`,
      [userId, today]
    );
  }

  // Обновление платежа
  static async update(id, userId, updateData) {
    const payment = await get(
      `SELECT id FROM recurring_payments WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    if (!payment) return false;

    const fields = [];
    const values = [];

    const allowedFields = [
      'name', 'description', 'amount', 'type', 'category',
      'frequency', 'day_of_month', 'day_of_week', 'start_date',
      'end_date', 'auto_create', 'notify_before', 'is_active', 'account_id'
    ];

    const fieldMapping = {
      dayOfMonth: 'day_of_month',
      dayOfWeek: 'day_of_week',
      startDate: 'start_date',
      endDate: 'end_date',
      autoCreate: 'auto_create',
      notifyBefore: 'notify_before',
      isActive: 'is_active',
      accountId: 'account_id'
    };

    for (const [key, value] of Object.entries(updateData)) {
      const dbField = fieldMapping[key] || key;
      if (allowedFields.includes(dbField) && value !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return true;

    // Пересчитать следующую дату платежа если изменилась частота
    if (updateData.frequency || updateData.dayOfMonth || updateData.dayOfWeek) {
      const currentPayment = await this.findById(id);
      const nextDate = this.calculateNextPaymentDate(
        currentPayment.start_date,
        updateData.frequency || currentPayment.frequency,
        updateData.dayOfMonth || currentPayment.day_of_month,
        updateData.dayOfWeek || currentPayment.day_of_week
      );
      fields.push('next_payment_date = ?');
      values.push(nextDate);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, userId);

    await run(
      `UPDATE recurring_payments SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
      values
    );

    return true;
  }

  // Удаление платежа
  static async delete(id, userId) {
    const result = await run(
      `DELETE FROM recurring_payments WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    return result.changes > 0;
  }

  // Отметить платеж как выполненный и вычислить следующую дату
  static async markAsPaid(id, userId, createTransaction = false) {
    const payment = await get(
      `SELECT * FROM recurring_payments WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    if (!payment) return { success: false, message: 'Payment not found' };

    const today = new Date().toISOString().split('T')[0];
    const nextDate = this.calculateNextPaymentDate(
      today,
      payment.frequency,
      payment.day_of_month,
      payment.day_of_week,
      true // skip current
    );

    // Проверка на окончание платежей
    let isActive = 1;
    if (payment.end_date && nextDate > payment.end_date) {
      isActive = 0;
    }

    await run(
      `UPDATE recurring_payments
       SET last_payment_date = ?, next_payment_date = ?, is_active = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [today, nextDate, isActive, id]
    );

    // Создать транзакцию если нужно
    let transaction = null;
    if (createTransaction) {
      const Transaction = require('./transaction');
      transaction = await Transaction.create({
        accountId: payment.account_id,
        userId: payment.user_id,
        date: today,
        description: payment.name,
        category: payment.category || 'Recurring payment',
        amount: payment.type === 'expense' ? -Math.abs(payment.amount) : Math.abs(payment.amount),
        type: payment.type
      });
    }

    return {
      success: true,
      nextPaymentDate: nextDate,
      isActive: !!isActive,
      transaction
    };
  }

  // Пропустить платеж (перенести на следующую дату)
  static async skip(id, userId) {
    const payment = await get(
      `SELECT * FROM recurring_payments WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    if (!payment) return { success: false, message: 'Payment not found' };

    const nextDate = this.calculateNextPaymentDate(
      payment.next_payment_date,
      payment.frequency,
      payment.day_of_month,
      payment.day_of_week,
      true
    );

    await run(
      `UPDATE recurring_payments
       SET next_payment_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextDate, id]
    );

    return { success: true, nextPaymentDate: nextDate };
  }

  // Вычисление следующей даты платежа
  static calculateNextPaymentDate(fromDate, frequency, dayOfMonth, dayOfWeek, skipCurrent = false) {
    const date = new Date(fromDate);

    if (skipCurrent) {
      // Переходим к следующему периоду
      switch (frequency) {
        case 'daily':
          date.setDate(date.getDate() + 1);
          break;
        case 'weekly':
          date.setDate(date.getDate() + 7);
          break;
        case 'biweekly':
          date.setDate(date.getDate() + 14);
          break;
        case 'monthly':
          date.setMonth(date.getMonth() + 1);
          break;
        case 'quarterly':
          date.setMonth(date.getMonth() + 3);
          break;
        case 'yearly':
          date.setFullYear(date.getFullYear() + 1);
          break;
      }
    }

    // Корректировка для конкретного дня
    if (frequency === 'weekly' && dayOfWeek !== null) {
      const currentDay = date.getDay();
      const diff = dayOfWeek - currentDay;
      if (diff <= 0 && skipCurrent) {
        date.setDate(date.getDate() + diff + 7);
      } else if (diff > 0) {
        date.setDate(date.getDate() + diff);
      }
    } else if (['monthly', 'quarterly', 'yearly'].includes(frequency) && dayOfMonth) {
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(Math.min(dayOfMonth, lastDay));
    }

    return date.toISOString().split('T')[0];
  }

  // Автоматическое создание транзакций для платежей с auto_create
  static async processAutoPayments() {
    const today = new Date().toISOString().split('T')[0];

    const duePayments = await query(
      `SELECT * FROM recurring_payments
       WHERE is_active = 1
         AND auto_create = 1
         AND next_payment_date <= ?
         AND (end_date IS NULL OR end_date >= ?)`,
      [today, today]
    );

    const results = [];
    for (const payment of duePayments) {
      const result = await this.markAsPaid(payment.id, payment.user_id, true);
      results.push({ paymentId: payment.id, name: payment.name, ...result });
    }

    return results;
  }

  // Получение статистики
  static async getStats(userId) {
    const stats = await get(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN type = 'expense' AND is_active = 1 THEN amount ELSE 0 END) as monthly_expenses,
         SUM(CASE WHEN type = 'income' AND is_active = 1 THEN amount ELSE 0 END) as monthly_income
       FROM recurring_payments
       WHERE user_id = ?`,
      [userId]
    );

    const upcoming = await this.getUpcoming(userId, 7);
    const overdue = await this.getOverdue(userId);

    return {
      total: stats.total || 0,
      active: stats.active || 0,
      monthlyExpenses: stats.monthly_expenses || 0,
      monthlyIncome: stats.monthly_income || 0,
      upcomingCount: upcoming.length,
      overdueCount: overdue.length
    };
  }

  // Получение частот с названиями
  static getFrequencies() {
    return [
      { value: 'daily', label: 'Daily' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'biweekly', label: 'Every 2 weeks' },
      { value: 'monthly', label: 'Monthly' },
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'yearly', label: 'Yearly' }
    ];
  }
}

module.exports = RecurringPayment;
