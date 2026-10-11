const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, get, run } = require('../db/database');
const { cashflowOnly, isCashflow } = require('../lib/txFilter');

// Cash flow only: no transfers, no opening balances (lib/txFilter).
const reportService = require('../services/reportService');
const networthService = require('../services/networthService');
const fx = require('../lib/fx');
const money = require('../lib/money');
const dates = require('../lib/dates');

const CFT = cashflowOnly('t');

// Bad report input -> 400 instead of a 500 with a RangeError.
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

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
    { id: 'monthly', name: 'Monthly report', description: 'Income and expenses for the month' },
    { id: 'yearly', name: 'Yearly report', description: 'Year in review' },
    { id: 'category', name: 'By category', description: 'Expenses by category' },
    { id: 'networth', name: 'Net Worth', description: 'Net worth over time' },
    { id: 'budget', name: 'Budgets', description: 'Budget performance' },
    { id: 'investments', name: 'Investments', description: 'Portfolio and returns' },
    { id: 'tax', name: 'Tax', description: 'Data for tax filing' }
  ]);
});

// Генерация отчёта
router.post('/generate', async (req, res, next) => {
  try {
    const { report_type, period_start, period_end, format = 'json' } = req.body;

    // wave-2 pdf-reports: реальная генерация PDF (monthly/annual) через сервис.
    // Включается ТОЛЬКО при явном format === 'pdf' — старый JSON-контракт для
    // остальных форматов сохраняется без изменений (additive). Возвращает { id };
    // PDF скачивается отдельным эндпоинтом /:id/download.
    if (format === 'pdf') {
      try {
        const generated = await reportService.generateReport(req.user.id, {
          reportType: report_type,
          periodStart: period_start,
          periodEnd: period_end,
        });
        return res.json({
          id: generated.id,
          title: generated.title,
          report_type: generated.reportType,
          format: 'pdf',
          download_url: `/api/reports/${generated.id}/download`,
          data: generated.data,
          generated_at: generated.data.generatedAt,
        });
      } catch (pdfErr) {
        // Если pdfkit ещё не установлен (PDF_ENGINE_UNAVAILABLE) — пробрасываем
        // ошибку в централизованный обработчик (503), не падая молча.
        if (pdfErr && pdfErr.code === 'PDF_ENGINE_UNAVAILABLE') {
          return next(pdfErr);
        }
        // Прочие ошибки PDF-генерации тоже отдаём как операционные.
        return next(pdfErr);
      }
    }

    let reportData;
    let title;

    switch (report_type) {
      case 'monthly':
        reportData = await generateMonthlyReport(req.user.id, period_start, period_end);
        title = `Monthly report ${period_start} - ${period_end}`;
        break;
      case 'yearly':
        reportData = await generateYearlyReport(req.user.id, period_start);
        title = `Yearly report ${period_start}`;
        break;
      case 'category':
        reportData = await generateCategoryReport(req.user.id, period_start, period_end);
        title = `Category report ${period_start} - ${period_end}`;
        break;
      case 'networth':
        reportData = await generateNetWorthReport(req.user.id);
        title = 'Net worth report';
        break;
      case 'budget':
        reportData = await generateBudgetReport(req.user.id, period_start, period_end);
        title = `Budget report ${period_start} - ${period_end}`;
        break;
      case 'investments':
        reportData = await generateInvestmentReport(req.user.id);
        title = 'Investment report';
        break;
      case 'tax':
        reportData = await generateTaxReport(req.user.id, period_start, period_end);
        title = `Tax report ${period_start} - ${period_end}`;
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
    res.status(error.status === 400 ? 400 : 500).json({ message: error.message });
  }
});

// wave-2 pdf-reports: стрим PDF отчёта на скачивание.
// GET /api/reports/:id/download -> application/pdf (буфер начинается с '%PDF').
router.get('/:id/download', async (req, res, next) => {
  try {
    const { report, pdf } = await reportService.getReportPdf(req.user.id, req.params.id);
    const safeTitle = String(report.title || `report-${report.id}`)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 80);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeTitle || 'report'}.pdf"`
    );
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).end(pdf);
  } catch (error) {
    return next(error);
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
//
// Every money total is in the user's base currency: a transaction is in the
// currency of its account, so rows carry a.currency and are converted
// (lib/fx) before they are added up.

// Year from a year (2026, '2026') or a date ('2026-10-01'): the UI sends the
// period start date for the yearly report.
function parseYear(value) {
  const m = /^(\d{4})(?:$|-)/.exec(String(value == null ? '' : value).trim());
  const year = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw badRequest('period_start must be a year (YYYY) or a date (YYYY-MM-DD)');
  }
  return year;
}

async function generateMonthlyReport(userId, start, end) {
  const conv = await fx.converterForUser(userId);
  const transactions = await query(
    `SELECT t.*, a.currency AS currency
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? ORDER BY t.date`,
    [userId, start, end]
  );

  const cashflow = transactions.filter(isCashflow);
  let income = 0;
  let expenses = 0;
  const byCategory = {};
  const expenseRows = [];
  for (const t of cashflow) {
    const amountBase = await conv.convert(Math.abs(Number(t.amount) || 0), t.currency);
    if (t.type === 'income') {
      income = money.add(income, amountBase);
    } else {
      expenses = money.add(expenses, amountBase);
      byCategory[t.category] = money.add(byCategory[t.category] || 0, amountBase);
      expenseRows.push({ ...t, amountBase });
    }
  }

  const accounts = await query('SELECT name, balance, currency FROM accounts WHERE user_id = ?', [userId]);
  const savings = money.sub(income, expenses);

  return {
    period: { start, end },
    currency: conv.baseCurrency,
    summary: { income, expenses, savings, savingsRate: income > 0 ? (savings / income * 100).toFixed(1) : 0 },
    transactionCount: cashflow.length,
    expensesByCategory: byCategory,
    accountBalances: accounts,
    topExpenses: expenseRows.sort((a, b) => b.amountBase - a.amountBase).slice(0, 10),
    missingRates: conv.missingRates
  };
}

async function generateYearlyReport(userId, yearInput) {
  const year = parseYear(yearInput);
  const conv = await fx.converterForUser(userId);

  const monthlyData = [];
  for (let m = 1; m <= 12; m++) {
    const monthStart = `${year}-${String(m).padStart(2, '0')}-01`;
    const monthEnd = dates.endOfMonthISO(monthStart);

    const rows = await query(
      `SELECT a.currency AS currency,
              SUM(CASE WHEN t.type = 'income' THEN ABS(t.amount) ELSE 0 END) AS income,
              SUM(CASE WHEN t.type = 'expense' THEN ABS(t.amount) ELSE 0 END) AS expenses
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ?${CFT.sql}
       GROUP BY a.currency`,
      [userId, monthStart, monthEnd, ...CFT.params]
    );
    const tot = await conv.totals(rows, ['income', 'expenses']);

    monthlyData.push({
      month: m,
      income: tot.income || 0,
      expenses: tot.expenses || 0,
      savings: money.sub(tot.income || 0, tot.expenses || 0)
    });
  }

  const totalIncome = money.sum(monthlyData.map((m) => m.income));
  const totalExpenses = money.sum(monthlyData.map((m) => m.expenses));

  return {
    year,
    currency: conv.baseCurrency,
    summary: {
      totalIncome,
      totalExpenses,
      totalSavings: money.sub(totalIncome, totalExpenses),
      avgMonthlyIncome: money.round(totalIncome / 12),
      avgMonthlyExpenses: money.round(totalExpenses / 12)
    },
    monthlyData,
    missingRates: conv.missingRates
  };
}

async function generateCategoryReport(userId, start, end) {
  const conv = await fx.converterForUser(userId);
  const rows = await query(
    `SELECT t.category AS category, a.currency AS currency, SUM(ABS(t.amount)) as total, COUNT(*) as count
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.type = 'expense' AND t.date >= ? AND t.date <= ?${CFT.sql}
     GROUP BY t.category, a.currency`,
    [userId, start, end, ...CFT.params]
  );
  const expenses = (await conv.regroup(rows, { keys: ['category'], amounts: ['total'], counts: ['count'] }))
    .sort((a, b) => b.total - a.total);

  const total = money.sum(expenses.map((e) => e.total));

  return {
    period: { start, end },
    currency: conv.baseCurrency,
    totalExpenses: total,
    categories: expenses.map(e => ({ ...e, percent: total > 0 ? (e.total / total * 100).toFixed(1) : 0 })),
    missingRates: conv.missingRates
  };
}

// Net worth: totals come from networthService (every component converted into
// the base currency); the lists keep each item's own currency.
async function generateNetWorthReport(userId) {
  const snapshots = await query(
    'SELECT * FROM networth_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 12',
    [userId]
  );

  const accounts = await query(
    'SELECT name, account_type, balance, currency FROM accounts WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const debts = await query(
    'SELECT name, type, amount, paid_amount, currency FROM debts WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const assets = await query(
    'SELECT name, type, value, currency FROM manual_assets WHERE user_id = ? AND is_active = 1',
    [userId]
  );

  const nw = await networthService.computeNetWorth(userId);

  return {
    currency: nw.baseCurrency,
    currentNetWorth: nw.netWorth,
    totalAssets: nw.totalAssets,
    totalLiabilities: nw.totalLiabilities,
    breakdown: {
      accounts: nw.assetsBreakdown.accounts,
      investments: nw.assetsBreakdown.investments,
      savings: nw.assetsBreakdown.savings,
      manualAssets: nw.assetsBreakdown.manual,
      debts: nw.liabilitiesBreakdown.debts
    },
    accountsList: accounts,
    debtsList: debts,
    assetsList: assets,
    history: snapshots.reverse(),
    missingRates: nw.missingRates
  };
}

// Spending per budget is counted in the budget's own currency.
async function generateBudgetReport(userId, start, end) {
  const budgets = await query('SELECT * FROM budgets WHERE user_id = ?', [userId]);
  const conv = await fx.converterForUser(userId);

  const budgetStatus = [];
  for (const b of budgets) {
    const rows = await query(
      `SELECT a.currency AS currency, SUM(ABS(t.amount)) as total
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.type = 'expense' AND t.category = ? AND t.date >= ? AND t.date <= ?${CFT.sql}
       GROUP BY a.currency`,
      [userId, b.category, start, end, ...CFT.params]
    );
    const spent = (await conv.totals(rows, ['total'], { to: b.currency || conv.baseCurrency })).total || 0;

    budgetStatus.push({
      name: b.name,
      category: b.category,
      currency: b.currency || conv.baseCurrency,
      limit: b.amount,
      spent,
      remaining: money.sub(b.amount, spent),
      percentUsed: b.amount > 0 ? (spent / b.amount * 100).toFixed(1) : '0.0'
    });
  }

  return {
    period: { start, end },
    budgets: budgetStatus,
    overBudget: budgetStatus.filter(b => b.spent > b.limit),
    underBudget: budgetStatus.filter(b => b.spent <= b.limit),
    missingRates: conv.missingRates
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
  const conv = await fx.converterForUser(userId);
  const income = await query(
    `SELECT t.*, a.currency AS currency
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.type = 'income' AND t.date >= ? AND t.date <= ?${CFT.sql} ORDER BY t.date`,
    [userId, start, end, ...CFT.params]
  );

  let totalIncome = 0;
  const byMonth = {};
  for (const t of income) {
    const amountBase = await conv.convert(Math.abs(Number(t.amount) || 0), t.currency);
    t.amountBase = amountBase;
    totalIncome = money.add(totalIncome, amountBase);
    const month = String(t.date).substring(0, 7);
    byMonth[month] = money.add(byMonth[month] || 0, amountBase);
  }

  return {
    period: { start, end },
    currency: conv.baseCurrency,
    totalIncome,
    transactionCount: income.length,
    incomeByMonth: Object.entries(byMonth).map(([month, amount]) => ({ month, amount })),
    transactions: income,
    taxEstimates: {
      fop3: totalIncome * 0.05,
      fop2: totalIncome * 0.18 + totalIncome * 0.22 * 0.22,
      esv: Math.min(totalIncome * 0.22, 1474 * 22 * 12)
    },
    missingRates: conv.missingRates
  };
}

module.exports = router;
module.exports._internals = {
  parseYear,
  generateMonthlyReport,
  generateYearlyReport,
  generateNetWorthReport,
  generateBudgetReport
};
