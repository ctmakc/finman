const { query, get, run, transaction } = require('../db/database');
const { defaultCurrency: DEFAULT_CURRENCY } = require('../config/config');
const money = require('../lib/money');
const dates = require('../lib/dates');
const fx = require('../lib/fx');

class Budget {
  // Создание бюджета
  static async create(budgetData) {
    try {
      const result = await run(
        `INSERT INTO budgets
         (user_id, name, category, amount, period, start_date, end_date, currency, notify_at_percent, rollover, carryover)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          budgetData.userId,
          budgetData.name,
          budgetData.category || null,
          budgetData.amount,
          budgetData.period || 'monthly',
          budgetData.startDate,
          budgetData.endDate || null,
          budgetData.currency || DEFAULT_CURRENCY,
          budgetData.notifyAtPercent || 80,
          budgetData.rollover ? 1 : 0,
          money.round(budgetData.carryover || 0)
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

  // Сегодняшняя дата в часовом поясе пользователя (users.timezone), не UTC:
  // вечером в Торонто по UTC уже «завтра», а 1-го числа — уже новый месяц.
  static async userToday(userId) {
    let row = null;
    try {
      row = await get('SELECT timezone FROM users WHERE id = ?', [userId]);
    } catch (e) {
      row = null;
    }
    return dates.todayISO(dates.userTz(row));
  }

  // Получение активных бюджетов для текущего периода
  static async getActiveBudgets(userId, today = null) {
    try {
      today = today || await this.userToday(userId);

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
  static async findByCategory(userId, category, today = null) {
    try {
      today = today || await this.userToday(userId);

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
    const spent = money.round(budget.spent || 0);
    const amount = money.round(budget.amount || 0);
    // Envelope/rollover: перенесённый остаток из прошлых периодов (может быть
    // отрицательным при перерасходе). effectiveLimit = amount + carryover.
    const rollover = budget.rollover === 1 || budget.rollover === true;
    const carryover = money.round(budget.carryover || 0);
    const effectiveLimit = money.add(amount, carryover);
    // percent/remaining/over-budget считаем относительно эффективного лимита,
    // чтобы конвертный бюджет с переносом отражал реальный доступный остаток.
    const percentUsed = effectiveLimit > 0 ? Math.round((spent / effectiveLimit) * 100) : 0;
    const remaining = money.sub(effectiveLimit, spent);

    return {
      id: budget.id,
      userId: budget.user_id,
      name: budget.name,
      category: budget.category,
      amount: amount,
      spent: spent,
      rollover: rollover,
      carryover: carryover,
      effectiveLimit: effectiveLimit,
      remaining: remaining,
      percentUsed: percentUsed,
      period: budget.period,
      startDate: budget.start_date,
      endDate: budget.end_date,
      currency: budget.currency,
      lastRolledPeriod: budget.last_rolled_period || null,
      notifyAtPercent: budget.notify_at_percent,
      isActive: budget.is_active === 1,
      isOverBudget: spent > effectiveLimit,
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
      if (budgetData.rollover !== undefined) {
        updates.push('rollover = ?');
        params.push(budgetData.rollover ? 1 : 0);
      }
      if (budgetData.carryover !== undefined) {
        updates.push('carryover = ?');
        params.push(money.round(budgetData.carryover));
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

  // Обновление суммы потраченного (округляем до копеек перед записью)
  static async updateSpent(id, userId, spent) {
    try {
      const result = await run(
        `UPDATE budgets SET spent = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [money.round(spent), id, userId]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Добавление к потраченному.
  // Читаем текущее значение и пересчитываем через money.add, чтобы хранимое
  // spent не накапливало float-дрейф.
  static async addToSpent(id, userId, amount) {
    try {
      const current = await get(
        `SELECT spent FROM budgets WHERE id = ? AND user_id = ?`,
        [id, userId]
      );

      if (!current) {
        return false;
      }

      const newSpent = money.add(current.spent || 0, amount);

      const result = await run(
        `UPDATE budgets SET spent = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [newSpent, id, userId]
      );

      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }

  // Расходы бюджета за [startDate, endDate] в ВАЛЮТЕ БЮДЖЕТА: операция — в
  // валюте своего счёта, поэтому суммы группируются по a.currency и
  // переводятся (lib/fx). conv — общий конвертер (кэш курсов на вызов).
  static async spentInRange(userId, budget, startDate, endDate, conv = null) {
    const converter = conv || fx.createConverter(budget.currency || DEFAULT_CURRENCY);
    const params = [userId];
    let categorySql = '';
    if (budget.category) {
      categorySql = ' AND t.category = ?';
      params.push(budget.category);
    }
    params.push(startDate, endDate);
    const rows = await query(
      `SELECT a.currency AS currency, COALESCE(SUM(ABS(t.amount)), 0) as total
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ?${categorySql} AND t.type = 'expense'
       AND t.date >= ? AND t.date <= ?
       GROUP BY a.currency`,
      params
    );
    const tot = await converter.totals(rows, ['total'], { to: budget.currency || DEFAULT_CURRENCY });
    return money.round(tot.total || 0);
  }

  // Пересчет потраченного на основе транзакций (текущий период, день пользователя)
  static async recalculateSpent(userId, category = null, today = null) {
    try {
      today = today || await this.userToday(userId);
      // Получаем активные бюджеты
      const budgets = category
        ? [await this.findByCategory(userId, category, today)].filter(Boolean)
        : await this.getActiveBudgets(userId, today);
      const conv = fx.createConverter(DEFAULT_CURRENCY);

      for (const budget of budgets) {
        // Определяем даты периода
        const { startDate, endDate } = this.getPeriodDates(budget, today);
        const spent = await this.spentInRange(userId, budget, startDate, endDate, conv);
        await this.updateSpent(budget.id, userId, spent);
      }

      return true;
    } catch (error) {
      throw error;
    }
  }

  // Даты периода, содержащего today ('YYYY-MM-DD' в дне пользователя).
  // Строковая UTC-арифметика (lib/dates): результат не зависит от TZ процесса.
  // Неделя — с понедельника по воскресенье.
  static getPeriodDates(budget, today = null) {
    const day = today || dates.todayISO();
    switch (budget.period) {
      case 'daily':
        return { startDate: day, endDate: day };
      case 'weekly': {
        const dow = dates.parseISO(day).getUTCDay();
        const monday = dates.addDaysISO(day, dow === 0 ? -6 : 1 - dow);
        return { startDate: monday, endDate: dates.addDaysISO(monday, 6) };
      }
      case 'yearly':
        return { startDate: `${day.slice(0, 4)}-01-01`, endDate: `${day.slice(0, 4)}-12-31` };
      case 'custom':
        return {
          startDate: budget.startDate || budget.start_date,
          endDate: budget.endDate || budget.end_date || day
        };
      case 'monthly':
      default:
        return { startDate: dates.startOfMonthISO(day), endDate: dates.endOfMonthISO(day) };
    }
  }

  // Период (daily/weekly/monthly/yearly), начинающийся сразу после периода
  // со стартом startDate.
  static nextPeriodStart(period, startDate) {
    switch (period) {
      case 'daily': return dates.addDaysISO(startDate, 1);
      case 'weekly': return dates.addDaysISO(startDate, 7);
      case 'yearly': return dates.addMonthsISO(startDate, 12, 1);
      case 'monthly':
      default: return dates.addMonthsISO(startDate, 1, 1);
    }
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
      // Итоги по всем бюджетам — в базовой валюте пользователя (каждый бюджет
      // хранит свою валюту).
      const conv = await fx.converterForUser(userId);

      const stats = {
        currency: conv.baseCurrency,
        totalBudgets: budgets.length,
        totalBudgetAmount: 0,
        totalSpent: 0,
        overBudgetCount: 0,
        nearLimitCount: 0,
        budgets: []
      };

      for (const budget of budgets) {
        stats.totalBudgetAmount = money.add(stats.totalBudgetAmount, await conv.convert(budget.amount, budget.currency));
        stats.totalSpent = money.add(stats.totalSpent, await conv.convert(budget.spent, budget.currency));

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
          currency: budget.currency,
          percentUsed: budget.percentUsed,
          status: budget.isOverBudget ? 'over' : (budget.shouldNotify ? 'warning' : 'ok')
        });
      }

      stats.totalRemaining = money.sub(stats.totalBudgetAmount, stats.totalSpent);
      stats.missingRates = conv.missingRates;
      stats.overallPercentUsed = stats.totalBudgetAmount > 0
        ? Math.round((stats.totalSpent / stats.totalBudgetAmount) * 100)
        : 0;

      return stats;
    } catch (error) {
      throw error;
    }
  }

  // Envelope / rollover: перенос остатка ЗАВЕРШЁННОГО периода.
  //
  // Для rollover-бюджетов периода fromPeriod закрывается ПРЕДЫДУЩИЙ период
  // (относительно today в дне пользователя): 1-го ноября закрывается октябрь,
  // а не только что начавшийся ноябрь.
  //   carryover(next) = amount + carryover - spent(закрытый период),
  // где spent считается по транзакциям этого периода в валюте бюджета.
  // budgets.last_rolled_period (миграция 018) хранит старт последнего
  // закрытого периода: повторный вызов в том же периоде ничего не меняет.
  // Если пропущено несколько периодов — они закрываются по очереди (не более
  // 400). Периоды, закончившиеся до start_date бюджета, не закрываются.
  // spent после переноса = расходы текущего периода.
  // custom: закрывается сам диапазон start_date..end_date, когда он закончился.
  // Не-rollover бюджеты не трогаем.
  static async rollForward(userId, fromPeriod, options = {}) {
    try {
      const today = options.today || await this.userToday(userId);
      const rows = await query(
        `SELECT * FROM budgets
         WHERE user_id = ? AND is_active = 1 AND rollover = 1
         AND period = ?`,
        [userId, fromPeriod]
      );
      const conv = fx.createConverter(DEFAULT_CURRENCY);

      // Сначала считаем (чтения + курсы), затем пишем одной транзакцией.
      const plans = [];
      for (const row of rows) {
        const amount = money.round(row.amount || 0);
        let carry = money.round(row.carryover || 0);
        const budgetStart = row.start_date ? String(row.start_date).slice(0, 10) : null;
        let key = null;
        let currentSpent = 0;

        if (fromPeriod === 'custom') {
          const end = row.end_date ? String(row.end_date).slice(0, 10) : null;
          if (!budgetStart || !end || end >= today) continue; // диапазон ещё идёт
          key = budgetStart;
          if (row.last_rolled_period === key) continue;
          const spent = await this.spentInRange(userId, row, budgetStart, end, conv);
          carry = money.sub(money.add(amount, carry), spent);
        } else {
          const current = this.getPeriodDates({ period: fromPeriod }, today);
          const prevStart = this.getPeriodDates({ period: fromPeriod }, dates.addDaysISO(current.startDate, -1)).startDate;
          let p = row.last_rolled_period
            ? this.nextPeriodStart(fromPeriod, String(row.last_rolled_period).slice(0, 10))
            : prevStart;
          if (budgetStart) {
            const firstOwn = this.getPeriodDates({ period: fromPeriod }, budgetStart).startDate;
            if (p < firstOwn) p = firstOwn;
          }
          let closed = 0;
          while (p <= prevStart && closed < 400) {
            const { endDate } = this.getPeriodDates({ period: fromPeriod }, p);
            const spent = await this.spentInRange(userId, row, p, endDate, conv);
            carry = money.sub(money.add(amount, carry), spent);
            key = p;
            closed += 1;
            p = this.nextPeriodStart(fromPeriod, p);
          }
          if (!closed) continue; // уже закрыт или бюджет начался в текущем периоде
          currentSpent = await this.spentInRange(userId, row, current.startDate, current.endDate, conv);
        }

        plans.push({ row, carry, key, currentSpent });
      }

      const rolled = [];
      await transaction(async () => {
        for (const { row, carry, key, currentSpent } of plans) {
          // Условие на last_rolled_period: параллельный вызов, успевший
          // закрыть период раньше, не даст перенести остаток дважды.
          const result = await run(
            `UPDATE budgets SET carryover = ?, spent = ?, last_rolled_period = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ? AND COALESCE(last_rolled_period, '') = ?`,
            [carry, currentSpent, key, row.id, userId, row.last_rolled_period || '']
          );
          if (result.changes > 0) {
            rolled.push({ id: row.id, carryover: carry, period: key });
          }
        }
      });

      return rolled;
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
