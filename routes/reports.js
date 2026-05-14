const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

// Список отчётов
router.get('/', async (req, res) => {
  try {
    const reports = await query(
      'SELECT id, report_type, title, period_start, period_end, format, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(reports);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Типы отчётов
router.get('/types', (req, res) => {
  res.json([
    { id: 'monthly', name: 'Monthly Report', description: 'Income and expenses for the month' },
    { id: 'yearly', name: 'Annual Report', description: 'Annual summary' },
    { id: 'category', name: 'By Category', description: 'Expenses by category' },
    { id: 'networth', name: 'Net Worth', description: 'Net worth dynamics' },
    { id: 'budget', name: 'Budgets', description: 'Budget performance' },
    { id: 'investments', name: 'Investments', description: 'Portfolio and returns' },
    { id: 'tax', name: 'Tax', description: 'Data for tax reporting' }
  ]);
});

// Генерация отчёта
router.post('/generate', async (req, res) => {
  try {
    const { report_type, period_start, period_end, format = 'json' } = req.body;

    let reportData;
    let title;

    switch (report_type) {
      case 'monthly':
        reportData = await generateMonthlyReport(req.user.id, period_start, period_end);
        title = `Месячный отчёт ${period_start} - ${period_end}`;
        break;
      case 'yearly':
        reportData = await generateYearlyReport(req.user.id, period_start);
        title = `Годовой отчёт ${period_start}`;
        break;
      case 'category':
        reportData = await generateCategoryReport(req.user.id, period_start, period_end);
        title = `Отчёт по категориям ${period_start} - ${period_end}`;
        break;
      case 'networth':
        reportData = await generateNetWorthReport(req.user.id);
        title = 'Net Worth Report';
        break;
      case 'budget':
        reportData = await generateBudgetReport(req.user.id, period_start, period_end);
        title = `Отчёт по бюджетам ${period_start} - ${period_end}`;
        break;
      case 'investments':
        reportData = await generateInvestmentReport(req.user.id);
        title = 'Investment Report';
        break;
      case 'tax':
        reportData = await generateTaxReport(req.user.id, period_start, period_end);
        title = `Налоговый отчёт ${period_start} - ${period_end}`;
        break;
      default:
        return res.status(400).json({ message: 'Unknown report type' });
    }

    // Сохраняем отчёт
    const result = await run(
      `INSERT INTO reports (user_id, report_type, title, period_start, period_end, file_data, format, parameters)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, report_type, title, period_start, period_end, JSON.stringify(reportData), format, JSON.stringify(req.body)]
    );

    res.json({
      id: result.id,
      title,
      report_type,
      data: reportData,
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Получить отчёт
router.get('/:id', async (req, res) => {
  try {
    const report = await get('SELECT * FROM reports WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!report) return res.status(404).json({ message: 'Report not found' });

    res.json({
      ...report,
      data: JSON.parse(report.file_data || '{}'),
      parameters: JSON.parse(report.parameters || '{}')
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Удалить отчёт
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM reports WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Report deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Генераторы отчётов
async function generateMonthlyReport(userId, start, end) {
  const transactions = await query(
    `SELECT * FROM transactions WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`,
    [userId, start, end]
  );

  const income = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expenses = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

  const byCategory = {};
  transactions.filter(t => t.type === 'expense').forEach(t => {
    byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
  });

  const accounts = await query('SELECT name, balance FROM accounts WHERE user_id = ?', [userId]);

  return {
    period: { start, end },
    summary: { income, expenses, savings: income - expenses, savingsRate: income > 0 ? ((income - expenses) / income * 100).toFixed(1) : 0 },
    transactionCount: transactions.length,
    expensesByCategory: byCategory,
    accountBalances: accounts,
    topExpenses: transactions.filter(t => t.type === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 10)
  };
}

async function generateYearlyReport(userId, year) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  const monthlyData = [];
  for (let m = 1; m <= 12; m++) {
    const monthStart = `${year}-${String(m).padStart(2, '0')}-01`;
    const monthEnd = new Date(year, m, 0).toISOString().split('T')[0];

    const income = await get(
      `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'income' AND date >= ? AND date <= ?`,
      [userId, monthStart, monthEnd]
    );
    const expenses = await get(
      `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`,
      [userId, monthStart, monthEnd]
    );

    monthlyData.push({
      month: m,
      income: income.total || 0,
      expenses: expenses.total || 0,
      savings: (income.total || 0) - (expenses.total || 0)
    });
  }

  const totalIncome = monthlyData.reduce((s, m) => s + m.income, 0);
  const totalExpenses = monthlyData.reduce((s, m) => s + m.expenses, 0);

  return {
    year,
    summary: { totalIncome, totalExpenses, totalSavings: totalIncome - totalExpenses, avgMonthlyIncome: totalIncome / 12, avgMonthlyExpenses: totalExpenses / 12 },
    monthlyData
  };
}

async function generateCategoryReport(userId, start, end) {
  const expenses = await query(
    `SELECT category, SUM(amount) as total, COUNT(*) as count
     FROM transactions WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
     GROUP BY category ORDER BY total DESC`,
    [userId, start, end]
  );

  const total = expenses.reduce((s, e) => s + e.total, 0);

  return {
    period: { start, end },
    totalExpenses: total,
    categories: expenses.map(e => ({ ...e, percent: total > 0 ? (e.total / total * 100).toFixed(1) : 0 }))
  };
}

async function generateNetWorthReport(userId) {
  const snapshots = await query(
    'SELECT * FROM networth_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 12',
    [userId]
  );

  const accounts = await query('SELECT name, type, balance FROM accounts WHERE user_id = ?', [userId]);
  const debts = await query(
    'SELECT name, type, amount, paid_amount FROM debts WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const assets = await query('SELECT name, type, value FROM manual_assets WHERE user_id = ? AND is_active = 1', [userId]);

  const totalAccounts = accounts.reduce((s, a) => s + a.balance, 0);
  const totalDebts = debts.reduce((s, d) => s + (d.amount - d.paid_amount), 0);
  const totalAssets = assets.reduce((s, a) => s + a.value, 0);

  return {
    currentNetWorth: totalAccounts + totalAssets - totalDebts,
    breakdown: { accounts: totalAccounts, manualAssets: totalAssets, debts: totalDebts },
    accountsList: accounts,
    debtsList: debts,
    assetsList: assets,
    history: snapshots.reverse()
  };
}

async function generateBudgetReport(userId, start, end) {
  const budgets = await query('SELECT * FROM budgets WHERE user_id = ?', [userId]);

  const budgetStatus = await Promise.all(budgets.map(async b => {
    const spent = await get(
      `SELECT SUM(amount) as total FROM transactions
       WHERE user_id = ? AND type = 'expense' AND category = ? AND date >= ? AND date <= ?`,
      [userId, b.category, start, end]
    );

    return {
      name: b.name,
      category: b.category,
      limit: b.amount,
      spent: spent.total || 0,
      remaining: b.amount - (spent.total || 0),
      percentUsed: ((spent.total || 0) / b.amount * 100).toFixed(1)
    };
  }));

  return {
    period: { start, end },
    budgets: budgetStatus,
    overBudget: budgetStatus.filter(b => b.spent > b.limit),
    underBudget: budgetStatus.filter(b => b.spent <= b.limit)
  };
}

async function generateInvestmentReport(userId) {
  const portfolios = await query('SELECT * FROM investment_portfolios WHERE user_id = ? AND is_active = 1', [userId]);

  const portfolioData = await Promise.all(portfolios.map(async p => {
    const investments = await query('SELECT * FROM investments WHERE portfolio_id = ? AND is_active = 1', [p.id]);

    const totalCost = investments.reduce((s, i) => s + (i.quantity * i.buy_price), 0);
    const totalValue = investments.reduce((s, i) => s + (i.quantity * (i.current_price || i.buy_price)), 0);

    return {
      name: p.name,
      currency: p.currency,
      holdings: investments.length,
      totalCost,
      totalValue,
      profitLoss: totalValue - totalCost,
      profitLossPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100).toFixed(2) : 0,
      investments: investments.map(i => ({
        symbol: i.symbol,
        name: i.name,
        quantity: i.quantity,
        buyPrice: i.buy_price,
        currentPrice: i.current_price || i.buy_price,
        value: i.quantity * (i.current_price || i.buy_price),
        profitLoss: i.quantity * ((i.current_price || i.buy_price) - i.buy_price)
      }))
    };
  }));

  const totalValue = portfolioData.reduce((s, p) => s + p.totalValue, 0);
  const totalCost = portfolioData.reduce((s, p) => s + p.totalCost, 0);

  return {
    summary: { totalValue, totalCost, totalProfitLoss: totalValue - totalCost, totalProfitLossPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100).toFixed(2) : 0 },
    portfolios: portfolioData
  };
}

async function generateTaxReport(userId, start, end) {
  const income = await query(
    `SELECT * FROM transactions WHERE user_id = ? AND type = 'income' AND date >= ? AND date <= ? ORDER BY date`,
    [userId, start, end]
  );

  const totalIncome = income.reduce((s, t) => s + t.amount, 0);

  // Группировка по месяцам
  const byMonth = {};
  income.forEach(t => {
    const month = t.date.substring(0, 7);
    byMonth[month] = (byMonth[month] || 0) + t.amount;
  });

  return {
    period: { start, end },
    totalIncome,
    transactionCount: income.length,
    incomeByMonth: Object.entries(byMonth).map(([month, amount]) => ({ month, amount })),
    transactions: income,
    taxEstimates: {
      fop3: totalIncome * 0.05,
      fop2: totalIncome * 0.18 + totalIncome * 0.22 * 0.22,
      esv: Math.min(totalIncome * 0.22, 1474 * 22 * 12)
    }
  };
}

module.exports = router;
