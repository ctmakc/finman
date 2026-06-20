// services/reportService.js — генерация PDF финансовых отчётов (wave-2 pdf-reports).
//
// Собирает данные из БД (summary, разбивка по категориям, бюджеты vs факт,
// net worth) и рендерит их в PDF-буфер через pdfkit. Метаданные отчёта
// сохраняются в таблице reports.
//
// Экспорт:
//   buildReportData(userId, { reportType, periodStart, periodEnd }) -> Promise<object>
//   renderReportPdf(reportData) -> Promise<Buffer>   (буфер, начинается с '%PDF')
//   generateReport(userId, opts) -> Promise<{ id, title, reportType, pdf, data }>
//   getReportPdf(userId, reportId) -> Promise<{ report, pdf }>
//
// Денежная арифметика — строго через lib/money (float-safe, 2dp).
// pdfkit подключается ЛЕНИВО (require внутри функции), чтобы отсутствие
// зависимости не валило загрузку модуля/сервера (Integrator ставит pdfkit).

const { query, get, run } = require('../db/database');
const money = require('../lib/money');
const { AppError } = require('../middleware/error');

const SUPPORTED_TYPES = ['monthly', 'annual'];

// Нормализация типа отчёта: принимаем 'monthly'/'annual' (+ синоним 'yearly').
function normalizeType(reportType) {
  const t = String(reportType || 'monthly').toLowerCase();
  if (t === 'yearly') return 'annual';
  if (SUPPORTED_TYPES.includes(t)) return t;
  throw new AppError(400, 'INVALID_REPORT_TYPE', `Unsupported report type: ${reportType}`);
}

// Если период не задан — вычисляем по типу относительно текущей даты.
function resolvePeriod(reportType, periodStart, periodEnd) {
  if (periodStart && periodEnd) {
    return { start: String(periodStart), end: String(periodEnd) };
  }
  const now = new Date();
  const year = now.getUTCFullYear();
  if (reportType === 'annual') {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  // monthly
  const month = now.getUTCMonth(); // 0-based
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return {
    start: first.toISOString().split('T')[0],
    end: last.toISOString().split('T')[0],
  };
}

function periodTitle(reportType, start, end) {
  const label = reportType === 'annual' ? 'Annual' : 'Monthly';
  return `${label} Financial Report (${start} — ${end})`;
}

// ---- Сбор данных отчёта -------------------------------------------------

async function buildReportData(userId, opts = {}) {
  const reportType = normalizeType(opts.reportType);
  const { start, end } = resolvePeriod(reportType, opts.periodStart, opts.periodEnd);

  // 1) Транзакции за период
  const transactions = await query(
    `SELECT date, description, category, amount, type
       FROM transactions
      WHERE user_id = ? AND date >= ? AND date <= ?
      ORDER BY date`,
    [userId, start, end]
  );

  const incomeRows = transactions.filter((t) => t.type === 'income');
  const expenseRows = transactions.filter((t) => t.type === 'expense');

  const income = money.sum(incomeRows.map((t) => t.amount));
  const expenses = money.sum(expenseRows.map((t) => t.amount));
  const net = money.sub(income, expenses);
  const savingsRate = income > 0 ? money.round(money.div(net, income) * 100) : 0;

  // 2) Разбивка расходов по категориям
  const byCategoryMap = {};
  for (const t of expenseRows) {
    const cat = t.category || 'Uncategorized';
    byCategoryMap[cat] = money.add(byCategoryMap[cat] || 0, t.amount);
  }
  const categoryBreakdown = Object.entries(byCategoryMap)
    .map(([category, total]) => ({
      category,
      total: money.round(total),
      percent: expenses > 0 ? money.round(money.div(total, expenses) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // 3) Бюджеты vs факт (по категориям, расходы в периоде)
  const budgets = await query(
    'SELECT name, category, amount FROM budgets WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const budgetVsActual = budgets.map((b) => {
    const spent = money.round(byCategoryMap[b.category] || 0);
    const limit = money.round(b.amount);
    return {
      name: b.name,
      category: b.category,
      limit,
      spent,
      remaining: money.sub(limit, spent),
      percentUsed: limit > 0 ? money.round(money.div(spent, limit) * 100) : 0,
      overBudget: spent > limit,
    };
  });

  // 4) Net worth (счета + ручные активы − долги)
  const accounts = await query(
    'SELECT name, balance FROM accounts WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const manualAssets = await query(
    'SELECT name, value FROM manual_assets WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  const debts = await query(
    'SELECT name, amount, paid_amount FROM debts WHERE user_id = ? AND is_active = 1',
    [userId]
  );

  const totalAccounts = money.sum(accounts.map((a) => a.balance));
  const totalManualAssets = money.sum(manualAssets.map((a) => a.value));
  const totalAssets = money.add(totalAccounts, totalManualAssets);
  const totalLiabilities = money.sum(
    debts.map((d) => money.sub(d.amount, d.paid_amount || 0))
  );
  const netWorth = money.sub(totalAssets, totalLiabilities);

  return {
    reportType,
    title: periodTitle(reportType, start, end),
    period: { start, end },
    generatedAt: new Date().toISOString(),
    summary: {
      income,
      expenses,
      net,
      savingsRate,
      transactionCount: transactions.length,
    },
    categoryBreakdown,
    budgetVsActual,
    netWorth: {
      totalAssets,
      totalLiabilities,
      netWorth,
      breakdown: {
        accounts: totalAccounts,
        manualAssets: totalManualAssets,
        liabilities: totalLiabilities,
      },
    },
  };
}

// ---- Рендер PDF ---------------------------------------------------------

function fmtMoney(n) {
  // Двухзнаковый формат с разделителем тысяч; знак сохраняем.
  const v = money.round(n);
  const parts = Math.abs(v).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0 ? '-' : ''}${parts[0]}.${parts[1]}`;
}

function renderReportPdf(reportData) {
  // Ленивый require: отсутствие pdfkit не должно ронять загрузку модуля.
  let PDFDocument;
  try {
    // eslint-disable-next-line global-require
    PDFDocument = require('pdfkit');
  } catch (e) {
    throw new AppError(
      503,
      'PDF_ENGINE_UNAVAILABLE',
      'PDF engine (pdfkit) is not installed'
    );
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const d = reportData || {};
      const summary = d.summary || {};
      const nw = d.netWorth || {};
      const nwb = (nw.breakdown) || {};

      // Заголовок
      doc.fontSize(20).text(d.title || 'Financial Report', { align: 'left' });
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .fillColor('#666')
        .text(`Generated: ${d.generatedAt || new Date().toISOString()}`);
      doc.fillColor('#000');
      doc.moveDown(1);

      // 1) Summary
      doc.fontSize(14).text('Summary', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(11);
      doc.text(`Income:           ${fmtMoney(summary.income || 0)}`);
      doc.text(`Expenses:         ${fmtMoney(summary.expenses || 0)}`);
      doc.text(`Net:              ${fmtMoney(summary.net || 0)}`);
      doc.text(`Savings rate:     ${money.round(summary.savingsRate || 0)}%`);
      doc.text(`Transactions:     ${summary.transactionCount || 0}`);
      doc.moveDown(1);

      // 2) Category breakdown
      doc.fontSize(14).text('Expenses by Category', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(11);
      const cats = d.categoryBreakdown || [];
      if (cats.length === 0) {
        doc.fillColor('#888').text('No expenses in this period.').fillColor('#000');
      } else {
        for (const c of cats) {
          doc.text(`${c.category}:  ${fmtMoney(c.total)}  (${money.round(c.percent)}%)`);
        }
      }
      doc.moveDown(1);

      // 3) Budget vs actual
      doc.fontSize(14).text('Budget vs Actual', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(11);
      const budgets = d.budgetVsActual || [];
      if (budgets.length === 0) {
        doc.fillColor('#888').text('No active budgets.').fillColor('#000');
      } else {
        for (const b of budgets) {
          const flag = b.overBudget ? '  [OVER]' : '';
          doc.text(
            `${b.name} (${b.category}):  ${fmtMoney(b.spent)} / ${fmtMoney(b.limit)}  ` +
              `(${money.round(b.percentUsed)}%)${flag}`
          );
        }
      }
      doc.moveDown(1);

      // 4) Net worth
      doc.fontSize(14).text('Net Worth', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(11);
      doc.text(`Accounts:         ${fmtMoney(nwb.accounts || 0)}`);
      doc.text(`Manual assets:    ${fmtMoney(nwb.manualAssets || 0)}`);
      doc.text(`Total assets:     ${fmtMoney(nw.totalAssets || 0)}`);
      doc.text(`Liabilities:      ${fmtMoney(nw.totalLiabilities || 0)}`);
      doc.fontSize(12).text(`Net worth:        ${fmtMoney(nw.netWorth || 0)}`, {
        underline: false,
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ---- Высокоуровневые операции ------------------------------------------

// Генерирует отчёт: строит данные, рендерит PDF, сохраняет метаданные.
// Возвращает { id, title, reportType, pdf (Buffer), data }.
async function generateReport(userId, opts = {}) {
  const data = await buildReportData(userId, opts);
  const pdf = await renderReportPdf(data);

  const result = await run(
    `INSERT INTO reports
       (user_id, report_type, title, period_start, period_end, file_data, format, parameters)
     VALUES (?, ?, ?, ?, ?, ?, 'pdf', ?)`,
    [
      userId,
      data.reportType,
      data.title,
      data.period.start,
      data.period.end,
      // file_data хранит JSON-снимок данных отчёта (не бинарь) — PDF
      // перерендерится при скачивании детерминированно из тех же данных.
      JSON.stringify(data),
      JSON.stringify({
        reportType: data.reportType,
        periodStart: data.period.start,
        periodEnd: data.period.end,
      }),
    ]
  );

  return {
    id: result.id,
    title: data.title,
    reportType: data.reportType,
    pdf,
    data,
  };
}

// Возвращает сохранённый отчёт + перерендеренный PDF-буфер для скачивания.
async function getReportPdf(userId, reportId) {
  const report = await get(
    'SELECT * FROM reports WHERE id = ? AND user_id = ?',
    [reportId, userId]
  );
  if (!report) {
    throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
  }

  let data;
  try {
    data = JSON.parse(report.file_data || '{}');
  } catch (e) {
    data = {};
  }

  // Если сохранён старый JSON без структуры pdf-отчёта — пересоберём из БД.
  if (!data || !data.summary) {
    data = await buildReportData(userId, {
      reportType: report.report_type,
      periodStart: report.period_start,
      periodEnd: report.period_end,
    });
  }

  const pdf = await renderReportPdf(data);
  return { report, pdf };
}

module.exports = {
  SUPPORTED_TYPES,
  buildReportData,
  renderReportPdf,
  generateReport,
  getReportPdf,
};
