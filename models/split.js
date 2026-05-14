// ==================== МОДЕЛЬ СПЛИТА РАСХОДОВ ====================

const { query, get, run } = require('../db/database');

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
      name: data.creator_name || 'Me',
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
    const result = await run(
      `INSERT INTO split_expenses (group_id, paid_by, description, amount, split_type, date, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.group_id, data.paid_by, data.description, data.amount,
       data.split_type || 'equal', data.date, data.category]
    );

    // Создаём доли для участников
    const members = await this.getMembers(data.group_id);

    if (data.split_type === 'equal') {
      // Равное разделение
      const shareAmount = data.amount / members.length;
      for (const member of members) {
        await run(
          `INSERT INTO split_shares (expense_id, member_id, amount, is_paid)
           VALUES (?, ?, ?, ?)`,
          [result.id, member.id, shareAmount, member.id === data.paid_by ? 1 : 0]
        );
      }
    } else if (data.split_type === 'custom' && data.shares) {
      // Кастомное разделение
      for (const share of data.shares) {
        await run(
          `INSERT INTO split_shares (expense_id, member_id, amount, is_paid)
           VALUES (?, ?, ?, ?)`,
          [result.id, share.member_id, share.amount, share.member_id === data.paid_by ? 1 : 0]
        );
      }
    }

    return this.getExpense(result.id);
  },

  // Получить расход
  async getExpense(id) {
    const expense = await get('SELECT * FROM split_expenses WHERE id = ?', [id]);
    if (expense) {
      expense.shares = await query('SELECT * FROM split_shares WHERE expense_id = ?', [id]);
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
      expense.shares = await query(
        `SELECT ss.*, sm.name as member_name
         FROM split_shares ss
         INNER JOIN split_members sm ON ss.member_id = sm.id
         WHERE ss.expense_id = ?`,
        [expense.id]
      );
    }

    return expenses;
  },

  // Удалить расход
  async deleteExpense(id) {
    return run('DELETE FROM split_expenses WHERE id = ?', [id]);
  },

  // ==================== БАЛАНСЫ И РАСЧЁТЫ ====================

  // Рассчитать балансы в группе
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
        owes: 0,      // Сколько должен
        balance: 0    // Итоговый баланс (положительный = должны ему)
      };
    });

    // Считаем по расходам
    for (const expense of expenses) {
      balances[expense.paid_by].paid += expense.amount;

      for (const share of expense.shares) {
        balances[share.member_id].owes += share.amount;
      }
    }

    // Учитываем расчёты
    for (const settlement of settlements) {
      balances[settlement.from_member].balance += settlement.amount;
      balances[settlement.to_member].balance -= settlement.amount;
    }

    // Итоговый баланс
    Object.values(balances).forEach(b => {
      b.balance += b.paid - b.owes;
    });

    return balances;
  },

  // Рассчитать оптимальные переводы
  async calculateSettlements(groupId) {
    const balances = await this.calculateBalances(groupId);

    // Разделяем на должников и кредиторов
    const debtors = [];  // Те кто должен (отрицательный баланс)
    const creditors = []; // Те кому должны (положительный баланс)

    Object.entries(balances).forEach(([memberId, data]) => {
      if (data.balance < -0.01) {
        debtors.push({ memberId: parseInt(memberId), ...data });
      } else if (data.balance > 0.01) {
        creditors.push({ memberId: parseInt(memberId), ...data });
      }
    });

    // Сортируем
    debtors.sort((a, b) => a.balance - b.balance);
    creditors.sort((a, b) => b.balance - a.balance);

    // Алгоритм минимизации транзакций
    const settlements = [];
    let i = 0, j = 0;

    while (i < debtors.length && j < creditors.length) {
      const debt = Math.abs(debtors[i].balance);
      const credit = creditors[j].balance;
      const amount = Math.min(debt, credit);

      if (amount > 0.01) {
        settlements.push({
          from: debtors[i].member,
          to: creditors[j].member,
          amount: Math.round(amount * 100) / 100
        });
      }

      debtors[i].balance += amount;
      creditors[j].balance -= amount;

      if (Math.abs(debtors[i].balance) < 0.01) i++;
      if (creditors[j].balance < 0.01) j++;
    }

    return settlements;
  },

  // Записать расчёт между участниками
  async recordSettlement(groupId, fromMember, toMember, amount, note = null) {
    const date = new Date().toISOString().split('T')[0];
    return run(
      `INSERT INTO split_settlements (group_id, from_member, to_member, amount, date, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [groupId, fromMember, toMember, amount, date, note]
    );
  },

  // Получить историю расчётов
  async getSettlements(groupId) {
    return query(
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
  },

  // ==================== СТАТИСТИКА ====================

  async getGroupStats(groupId) {
    const expenses = await this.getGroupExpenses(groupId);
    const balances = await this.calculateBalances(groupId);
    const settlements = await this.calculateSettlements(groupId);

    const stats = {
      totalExpenses: expenses.length,
      totalAmount: expenses.reduce((sum, e) => sum + e.amount, 0),
      byCategory: {},
      pendingSettlements: settlements.length,
      pendingAmount: settlements.reduce((sum, s) => sum + s.amount, 0)
    };

    expenses.forEach(e => {
      const cat = e.category || 'Other';
      stats.byCategory[cat] = (stats.byCategory[cat] || 0) + e.amount;
    });

    return stats;
  }
};

module.exports = Split;
