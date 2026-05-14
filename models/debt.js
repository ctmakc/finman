// ==================== МОДЕЛЬ ДОЛГОВ И КРЕДИТОВ ====================

const { query, get, run } = require('../db/database');

const Debt = {
  // Типы долгов
  TYPES: {
    I_OWE: 'i_owe',         // Я должен кому-то
    OWE_ME: 'owe_me',       // Мне должны
    CREDIT: 'credit',       // Кредит в банке
    MORTGAGE: 'mortgage',   // Ипотека
    LOAN: 'loan'            // Займ
  },

  // Создание долга
  async create(data) {
    const result = await run(
      `INSERT INTO debts (user_id, name, description, type, amount, interest_rate, currency, counterparty, start_date, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.user_id, data.name, data.description, data.type, data.amount,
       data.interest_rate || 0, data.currency || 'USD', data.counterparty,
       data.start_date, data.due_date]
    );
    return this.findById(result.id);
  },

  // Получение долга по ID
  async findById(id) {
    return get('SELECT * FROM debts WHERE id = ?', [id]);
  },

  // Получение всех долгов пользователя
  async findByUser(userId, includePaid = false) {
    const sql = includePaid
      ? 'SELECT * FROM debts WHERE user_id = ? AND is_active = 1 ORDER BY due_date ASC, created_at DESC'
      : 'SELECT * FROM debts WHERE user_id = ? AND is_active = 1 AND is_paid = 0 ORDER BY due_date ASC, created_at DESC';
    return query(sql, [userId]);
  },

  // Получение долгов по типу
  async findByType(userId, type) {
    return query(
      'SELECT * FROM debts WHERE user_id = ? AND type = ? AND is_active = 1 ORDER BY due_date ASC',
      [userId, type]
    );
  },

  // Обновление долга
  async update(id, data) {
    const fields = [];
    const values = [];

    ['name', 'description', 'amount', 'interest_rate', 'counterparty', 'due_date', 'is_active'].forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    });

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await run(`UPDATE debts SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  },

  // Добавить платёж по долгу
  async addPayment(debtId, amount, paymentType = 'principal', note = null, transactionId = null) {
    const debt = await this.findById(debtId);
    if (!debt) throw new Error('Debt not found');

    const paymentDate = new Date().toISOString().split('T')[0];

    const newPaid = debt.paid_amount + amount;
    const isPaid = newPaid >= debt.amount;

    await run('BEGIN TRANSACTION');
    try {
      await run(
        `INSERT INTO debt_payments (debt_id, amount, payment_type, note, transaction_id, payment_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [debtId, amount, paymentType, note, transactionId, paymentDate]
      );
      await run(
        `UPDATE debts SET paid_amount = ?, is_paid = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [newPaid, isPaid ? 1 : 0, isPaid ? new Date().toISOString() : null, debtId]
      );
      await run('COMMIT');
    } catch (err) {
      try { await run('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
      throw err;
    }

    return this.findById(debtId);
  },

  // Получить историю платежей
  async getPayments(debtId) {
    return query(
      `SELECT dp.*, t.description as transaction_description
       FROM debt_payments dp
       LEFT JOIN transactions t ON dp.transaction_id = t.id
       WHERE dp.debt_id = ?
       ORDER BY dp.payment_date DESC`,
      [debtId]
    );
  },

  // Расчёт с учётом процентов
  async calculateTotal(debtId) {
    const debt = await this.findById(debtId);
    if (!debt) return null;

    const remaining = debt.amount - debt.paid_amount;

    // Простой расчёт процентов
    let interestAmount = 0;
    if (debt.interest_rate > 0 && debt.start_date) {
      const startDate = new Date(debt.start_date);
      const now = new Date();
      const years = (now - startDate) / (1000 * 60 * 60 * 24 * 365);
      interestAmount = debt.amount * (debt.interest_rate / 100) * years;
    }

    return {
      ...debt,
      remaining,
      interestAmount: Math.round(interestAmount * 100) / 100,
      totalWithInterest: Math.round((debt.amount + interestAmount) * 100) / 100,
      remainingWithInterest: Math.round((remaining + interestAmount) * 100) / 100
    };
  },

  // Статистика по долгам
  async getStats(userId) {
    const debts = await this.findByUser(userId, true);

    const stats = {
      totalDebts: debts.length,
      activeDebts: 0,
      paidDebts: 0,
      iOwe: 0,          // Общая сумма моих долгов
      oweMe: 0,         // Общая сумма долгов мне
      credits: 0,       // Сумма кредитов
      remainingToPayMe: 0,
      remainingIPay: 0
    };

    debts.forEach(debt => {
      if (debt.is_paid) {
        stats.paidDebts++;
      } else {
        stats.activeDebts++;
        const remaining = debt.amount - debt.paid_amount;

        switch (debt.type) {
          case 'i_owe':
          case 'credit':
          case 'mortgage':
          case 'loan':
            stats.iOwe += debt.amount;
            stats.remainingIPay += remaining;
            if (debt.type !== 'i_owe') stats.credits += debt.amount;
            break;
          case 'owe_me':
            stats.oweMe += debt.amount;
            stats.remainingToPayMe += remaining;
            break;
        }
      }
    });

    stats.balance = stats.oweMe - stats.iOwe;

    return stats;
  },

  // Получить просроченные долги
  async getOverdue(userId) {
    const today = new Date().toISOString().split('T')[0];
    return query(
      `SELECT * FROM debts
       WHERE user_id = ? AND is_active = 1 AND is_paid = 0 AND due_date < ?
       ORDER BY due_date ASC`,
      [userId, today]
    );
  },

  // Получить скоро истекающие долги (в течение N дней)
  async getUpcoming(userId, days = 7) {
    const today = new Date();
    const futureDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);

    return query(
      `SELECT * FROM debts
       WHERE user_id = ? AND is_active = 1 AND is_paid = 0
         AND due_date >= ? AND due_date <= ?
       ORDER BY due_date ASC`,
      [userId, today.toISOString().split('T')[0], futureDate.toISOString().split('T')[0]]
    );
  },

  // Удаление долга
  async delete(id) {
    return run('UPDATE debts SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }
};

module.exports = Debt;
