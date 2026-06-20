// ==================== МОДЕЛЬ СПЛИТА РАСХОДОВ ====================

const { query, get, run } = require('../db/database');
const money = require('../lib/money');

const Split = {
  // ==================== ГРУППЫ ====================

  // Создание группы
  async createGroup(data) {
    const result = await run(
      `INSERT INTO split_groups (user_id, name, description, currency)
       VALUES (?, ?, ?, ?)`,
      [data.user_id, data.name, data.description, data.currency || 'UAH']
    );

    // Добавляем создателя как участника
    await this.addMember(result.id, {
      user_id: data.user_id,
      name: data.creator_name || 'Я',
      is_registered: true
    });

    return this.findGroupById(result.id);
  },

  // Получить группу по ID
  async findGroupById(id) {
    const group = await get('SELECT * FROM split_groups WHERE id = ?', [id]);
    if (group) {
      group.members = await this.getMembers(id);
    }
    return group;
  },

  // Получить группы пользователя
  async findGroupsByUser(userId) {
    const groups = await query(
      `SELECT sg.* FROM split_groups sg
       INNER JOIN split_members sm ON sg.id = sm.group_id
       WHERE sm.user_id = ? AND sg.is_active = 1
       ORDER BY sg.updated_at DESC`,
      [userId]
    );

    // Добавляем участников к каждой группе
    for (const group of groups) {
      group.members = await this.getMembers(group.id);
    }

    return groups;
  },

  // Обновить группу
  async updateGroup(id, data) {
    const fields = [];
    const values = [];

    ['name', 'description', 'is_active'].forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    });

    if (fields.length === 0) return this.findGroupById(id);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await run(`UPDATE split_groups SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findGroupById(id);
  },

  // ==================== УЧАСТНИКИ ====================

  // Добавить участника
  async addMember(groupId, data) {
    const result = await run(
      `INSERT INTO split_members (group_id, user_id, name, email, is_registered)
       VALUES (?, ?, ?, ?, ?)`,
      [groupId, data.user_id, data.name, data.email, data.is_registered ? 1 : 0]
    );
    return get('SELECT * FROM split_members WHERE id = ?', [result.id]);
  },

  // Получить участников группы
  async getMembers(groupId) {
    return query('SELECT * FROM split_members WHERE group_id = ?', [groupId]);
  },

  // Удалить участника
  async removeMember(memberId) {
    return run('DELETE FROM split_members WHERE id = ?', [memberId]);
  },

  // ==================== РАСХОДЫ ====================

  // Добавить расход
  async addExpense(data) {
    // Сумма расхода нормализуется до 2 знаков, чтобы балансы не дрейфовали.
    const totalAmount = money.round(data.amount);

    const result = await run(
      `INSERT INTO split_expenses (group_id, paid_by, description, amount, split_type, date, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.group_id, data.paid_by, data.description, totalAmount,
       data.split_type || 'equal', data.date, data.category]
    );

    // Создаём доли для участников
    const members = await this.getMembers(data.group_id);

    const splitType = data.split_type || 'equal';

    if (splitType === 'equal') {
      // Равное разделение с корректным распределением остатка по центам,
      // чтобы сумма долей ТОЧНО совпадала с суммой расхода.
      const shares = this._splitEqually(totalAmount, members.length);
      for (let idx = 0; idx < members.length; idx++) {
        const member = members[idx];
        await run(
          `INSERT INTO split_shares (expense_id, member_id, amount, is_paid)
           VALUES (?, ?, ?, ?)`,
          [result.id, member.id, shares[idx], member.id === data.paid_by ? 1 : 0]
        );
      }
    } else if (splitType === 'custom' && data.shares) {
      // Кастомное разделение
      for (const share of data.shares) {
        await run(
          `INSERT INTO split_shares (expense_id, member_id, amount, is_paid)
           VALUES (?, ?, ?, ?)`,
          [result.id, share.member_id, money.round(share.amount),
           share.member_id === data.paid_by ? 1 : 0]
        );
      }
    }

    return this.getExpense(result.id);
  },

  // Равномерное деление суммы на n частей по 2 знака так, чтобы сумма частей
  // была РОВНО равна total (остаток в центах раскидывается по первым долям).
  // Пример: 10.00 / 3 -> [3.34, 3.33, 3.33].
  _splitEqually(total, n) {
    if (!n || n < 1) return [];
    const totalCents = Math.round(money.round(total) * 100);
    const base = Math.floor(totalCents / n);
    let remainder = totalCents - base * n; // 0..n-1 лишних центов
    const shares = [];
    for (let i = 0; i < n; i++) {
      let cents = base;
      if (remainder > 0) {
        cents += 1;
        remainder -= 1;
      }
      shares.push(money.round(cents / 100));
    }
    return shares;
  },

  // Получить расход
  async getExpense(id) {
    const expense = await get('SELECT * FROM split_expenses WHERE id = ?', [id]);
    if (expense) {
      expense.amount = money.round(expense.amount);
      expense.shares = await query('SELECT * FROM split_shares WHERE expense_id = ?', [id]);
      expense.shares.forEach(s => { s.amount = money.round(s.amount); });
    }
    return expense;
  },

  // Получить расходы группы
  async getGroupExpenses(groupId) {
    const expenses = await query(
      `SELECT se.*, sm.name as paid_by_name
       FROM split_expenses se
       INNER JOIN split_members sm ON se.paid_by = sm.id
       WHERE se.group_id = ?
       ORDER BY se.date DESC`,
      [groupId]
    );

    for (const expense of expenses) {
      expense.amount = money.round(expense.amount);
      expense.shares = await query(
        `SELECT ss.*, sm.name as member_name
         FROM split_shares ss
         INNER JOIN split_members sm ON ss.member_id = sm.id
         WHERE ss.expense_id = ?`,
        [expense.id]
      );
      expense.shares.forEach(s => { s.amount = money.round(s.amount); });
    }

    return expenses;
  },

  // Алиас под имя, используемое в роутах (исправление падения routes/split.js:141).
  async getExpenses(groupId) {
    return this.getGroupExpenses(groupId);
  },

  // Удалить расход
  async deleteExpense(id) {
    return run('DELETE FROM split_expenses WHERE id = ?', [id]);
  },

  // ==================== БАЛАНСЫ И РАСЧЁТЫ ====================

  // Рассчитать балансы в группе.
  // balance > 0  -> участнику должны (он кредитор)
  // balance < 0  -> участник должен (он должник)
  // Сумма всех balance по группе ВСЕГДА = 0 (с точностью до округления).
  async calculateBalances(groupId) {
    const members = await this.getMembers(groupId);
    const expenses = await this.getGroupExpenses(groupId);
    const settlements = await query(
      'SELECT * FROM split_settlements WHERE group_id = ?',
      [groupId]
    );

    // Инициализируем балансы
    const balances = {};
    members.forEach(m => {
      balances[m.id] = {
        member: m,
        paid: 0,      // Сколько заплатил
        owes: 0,      // Сколько должен (его доля)
        balance: 0    // Итоговый баланс (положительный = должны ему)
      };
    });

    // Считаем по расходам
    for (const expense of expenses) {
      if (balances[expense.paid_by]) {
        balances[expense.paid_by].paid = money.add(
          balances[expense.paid_by].paid,
          expense.amount
        );
      }

      for (const share of expense.shares) {
        if (balances[share.member_id]) {
          balances[share.member_id].owes = money.add(
            balances[share.member_id].owes,
            share.amount
          );
        }
      }
    }

    // Базовый баланс = заплатил - его доля
    Object.values(balances).forEach(b => {
      b.paid = money.round(b.paid);
      b.owes = money.round(b.owes);
      b.balance = money.sub(b.paid, b.owes);
    });

    // Учитываем уже проведённые расчёты:
    // from_member заплатил to_member -> долг from_member уменьшился,
    // т.е. его баланс растёт, а у получателя падает.
    for (const settlement of settlements) {
      const amt = money.round(settlement.amount);
      if (balances[settlement.from_member]) {
        balances[settlement.from_member].balance = money.add(
          balances[settlement.from_member].balance,
          amt
        );
      }
      if (balances[settlement.to_member]) {
        balances[settlement.to_member].balance = money.sub(
          balances[settlement.to_member].balance,
          amt
        );
      }
    }

    // Финальное округление
    Object.values(balances).forEach(b => {
      b.balance = money.round(b.balance);
    });

    return balances;
  },

  // Рассчитать оптимальные переводы (жадная минимизация числа переводов).
  // Гарантирует, что после применения всех переводов балансы сходятся к нулю.
  async calculateSettlements(groupId) {
    const balances = await this.calculateBalances(groupId);

    // Работаем в центах (целые числа) — ноль float-дрейфа.
    const debtors = [];   // должники: balance < 0
    const creditors = []; // кредиторы: balance > 0

    Object.entries(balances).forEach(([memberId, data]) => {
      const cents = Math.round(money.round(data.balance) * 100);
      if (cents < 0) {
        debtors.push({ memberId: parseInt(memberId, 10), member: data.member, cents: -cents });
      } else if (cents > 0) {
        creditors.push({ memberId: parseInt(memberId, 10), member: data.member, cents });
      }
    });

    // Сортируем по убыванию суммы — крупные долги гасим первыми (меньше переводов).
    debtors.sort((a, b) => b.cents - a.cents);
    creditors.sort((a, b) => b.cents - a.cents);

    const settlements = [];
    let i = 0, j = 0;

    while (i < debtors.length && j < creditors.length) {
      const transferCents = Math.min(debtors[i].cents, creditors[j].cents);

      if (transferCents > 0) {
        settlements.push({
          from: debtors[i].member,
          to: creditors[j].member,
          amount: money.round(transferCents / 100)
        });
      }

      debtors[i].cents -= transferCents;
      creditors[j].cents -= transferCents;

      if (debtors[i].cents === 0) i++;
      if (creditors[j].cents === 0) j++;
    }

    return settlements;
  },

  // Записать расчёт между участниками (низкоуровневый).
  async recordSettlement(groupId, fromMember, toMember, amount, note = null) {
    const date = new Date().toISOString().split('T')[0];
    return run(
      `INSERT INTO split_settlements (group_id, from_member, to_member, amount, date, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [groupId, fromMember, toMember, money.round(amount), date, note]
    );
  },

  // Записать взаиморасчёт (имя, используемое в роутах routes/split.js:214).
  // Принимает объект { group_id, from_member, to_member, amount, date, note }.
  async addSettlement(data) {
    const date = data.date || new Date().toISOString().split('T')[0];
    const result = await run(
      `INSERT INTO split_settlements (group_id, from_member, to_member, amount, date, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.group_id, data.from_member, data.to_member,
       money.round(data.amount), date, data.note || null]
    );
    const row = await get('SELECT * FROM split_settlements WHERE id = ?', [result.id]);
    if (row) row.amount = money.round(row.amount);
    return row;
  },

  // Получить историю расчётов
  async getSettlements(groupId) {
    const rows = await query(
      `SELECT ss.*,
              sm1.name as from_name,
              sm2.name as to_name
       FROM split_settlements ss
       INNER JOIN split_members sm1 ON ss.from_member = sm1.id
       INNER JOIN split_members sm2 ON ss.to_member = sm2.id
       WHERE ss.group_id = ?
       ORDER BY ss.date DESC`,
      [groupId]
    );
    rows.forEach(r => { r.amount = money.round(r.amount); });
    return rows;
  },

  // ==================== СТАТИСТИКА ====================

  async getGroupStats(groupId) {
    const group = await this.findGroupById(groupId);
    const members = group ? (group.members || []) : await this.getMembers(groupId);
    const expenses = await this.getGroupExpenses(groupId);
    const balances = await this.calculateBalances(groupId);
    const settlements = await this.calculateSettlements(groupId);

    const totalAmount = money.sum(expenses.map(e => e.amount));
    const memberCount = members.length;

    const stats = {
      group,
      memberCount,
      // Поля, используемые фронтендом (public/js/split.js -> openGroup)
      totalSpent: totalAmount,
      averagePerPerson: memberCount > 0 ? money.div(totalAmount, memberCount) : 0,
      // Существующие агрегаты (обратная совместимость)
      totalExpenses: expenses.length,
      totalAmount,
      byCategory: {},
      pendingSettlements: settlements.length,
      pendingAmount: money.sum(settlements.map(s => s.amount))
    };

    expenses.forEach(e => {
      const cat = e.category || 'Другое';
      stats.byCategory[cat] = money.add(stats.byCategory[cat] || 0, e.amount);
    });

    return stats;
  },

  // Сводная статистика пользователя по всем его группам.
  // totalOwed   — сколько в сумме должны пользователю (его кредит)
  // totalOwes   — сколько в сумме должен пользователь
  // netBalance  — итоговый чистый баланс
  async getUserStats(userId) {
    const groups = await this.findGroupsByUser(userId);

    let totalOwed = 0;
    let totalOwes = 0;

    for (const group of groups) {
      const balances = await this.calculateBalances(group.id);
      // Находим участника(ов), привязанных к этому пользователю в группе.
      Object.values(balances).forEach(b => {
        if (b.member && b.member.user_id === userId) {
          if (b.balance > 0) {
            totalOwed = money.add(totalOwed, b.balance);
          } else if (b.balance < 0) {
            totalOwes = money.add(totalOwes, Math.abs(b.balance));
          }
        }
      });
    }

    totalOwed = money.round(totalOwed);
    totalOwes = money.round(totalOwes);

    return {
      groupCount: groups.length,
      totalOwed,
      totalOwes,
      netBalance: money.sub(totalOwed, totalOwes)
    };
  }
};

module.exports = Split;
