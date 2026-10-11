// services/digestService.js — еженедельная финансовая сводка (wave-2 "email-digest").
//
// Что делает:
//   buildDigest(userId, { now })   -> собирает сводку за последние 7 дней:
//        income / expense / net / top categories / budget status / upcoming bills.
//   renderText(digest)             -> текстовое тело письма (детерминированно).
//   renderHtml(digest)             -> простое html-тело письма.
//   sendDigest(userId, { now, force }) -> уважает notification_settings:
//        weekly_summary (вкл/выкл всей сводки) и email_enabled (слать ли письмо),
//        создаёт in-app уведомление (Notification) и (если email включён +
//        почта настроена) отправляет письмо через emailService. Никогда не падает
//        из-за почты.
//
// Денежная арифметика — через lib/money (float-safe, 2 знака).
// Все SQL — параметризованы, через db-хелперы.

'use strict';

const { query, get } = require('../db/database');
const money = require('../lib/money');
const { isCashflow } = require('../lib/txFilter');
const fx = require('../lib/fx');
const logger = require('../lib/logger');
const Notification = require('../models/notification');
const emailService = require('./emailService');

// --- утилиты дат -----------------------------------------------------------

function toISODate(d) {
  return d.toISOString().split('T')[0];
}

// Возвращает { start, end } строки YYYY-MM-DD для окна [now-7d, now].
function weekWindow(now) {
  const end = now instanceof Date ? new Date(now.getTime()) : new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { start: toISODate(start), end: toISODate(end) };
}

// --- сборка данных ---------------------------------------------------------

// Доходы/расходы за период. amount хранится со знаком (доход +, расход -),
// type in {income, expense}. Считаем по type, abs по сумме, чтобы не зависеть
// от того, как именно записан знак в конкретной строке.
async function buildDigest(userId, { now } = {}) {
  const { start, end } = weekWindow(now);
  // Операция — в валюте своего счёта; сводка — в базовой валюте пользователя.
  const conv = await fx.converterForUser(userId);

  const txRows = await query(
    `SELECT t.type, t.amount, t.category, a.currency AS currency
       FROM transactions t
       INNER JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ?
        AND t.date >= ?
        AND t.date <= ?`,
    [userId, start, end]
  );

  let income = 0;
  let expense = 0;
  const categoryTotals = {}; // category -> сумма расходов (положительная)

  for (const row of txRows) {
    // Transfers and opening balances are not cash flow (lib/txFilter).
    if (!isCashflow(row)) continue;
    const amt = await conv.convert(Math.abs(Number(row.amount) || 0), row.currency);
    if (row.type === 'income') {
      income = money.add(income, amt);
    } else {
      expense = money.add(expense, amt);
      const cat = row.category || 'Uncategorized';
      categoryTotals[cat] = money.add(categoryTotals[cat] || 0, amt);
    }
  }

  const net = money.sub(income, expense);

  // Топ-категории расходов (по убыванию суммы), максимум 5.
  const topCategories = Object.keys(categoryTotals)
    .map((name) => ({ category: name, amount: categoryTotals[name] }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // Статус бюджетов: для каждого активного бюджета — процент использования.
  const budgetRows = await query(
    `SELECT id, name, amount, spent, notify_at_percent, currency
       FROM budgets
      WHERE user_id = ? AND is_active = 1
      ORDER BY id ASC`,
    [userId]
  );

  const budgets = budgetRows.map((b) => {
    const amount = Number(b.amount) || 0;
    const spent = Number(b.spent) || 0;
    const percent = amount > 0 ? money.round((spent / amount) * 100) : 0;
    let status = 'ok';
    if (percent >= 100) status = 'exceeded';
    else if (percent >= (b.notify_at_percent || 80)) status = 'warning';
    return {
      id: b.id,
      name: b.name,
      amount: money.round(amount),
      spent: money.round(spent),
      currency: b.currency || conv.baseCurrency,
      percent,
      status,
    };
  });

  // Предстоящие платежи на ближайшие 7 дней (от end).
  const upcomingEnd = toISODate(
    new Date(new Date(end).getTime() + 7 * 24 * 60 * 60 * 1000)
  );

  const billRows = await query(
    `SELECT rp.id, rp.name, rp.amount, rp.next_payment_date, a.currency AS currency
       FROM recurring_payments rp
       LEFT JOIN accounts a ON a.id = rp.account_id
      WHERE rp.user_id = ? AND rp.is_active = 1
        AND rp.next_payment_date >= ?
        AND rp.next_payment_date <= ?
      ORDER BY rp.next_payment_date ASC`,
    [userId, end, upcomingEnd]
  );

  const upcomingBills = [];
  for (const p of billRows) {
    upcomingBills.push({
      id: p.id,
      name: p.name,
      amount: await conv.convert(Math.abs(Number(p.amount) || 0), p.currency),
      date: p.next_payment_date,
    });
  }

  const upcomingTotal = money.sum(upcomingBills.map((b) => b.amount));

  return {
    userId,
    period: { start, end },
    currency: conv.baseCurrency,
    missingRates: conv.missingRates,
    income: money.round(income),
    expense: money.round(expense),
    net,
    transactionCount: txRows.length,
    topCategories,
    budgets,
    upcomingBills,
    upcomingTotal,
  };
}

// --- рендеры письма --------------------------------------------------------

function renderText(d) {
  const lines = [];
  lines.push(`FinMan weekly summary`);
  lines.push(`Period: ${d.period.start} — ${d.period.end}`);
  if (d.currency) lines.push(`Amounts in ${d.currency}`);
  lines.push('');
  lines.push(`Income:   ${d.income}`);
  lines.push(`Expenses: ${d.expense}`);
  lines.push(`Net:      ${d.net}`);
  lines.push(`Transactions: ${d.transactionCount}`);

  if (d.topCategories.length) {
    lines.push('');
    lines.push('Top expense categories:');
    d.topCategories.forEach((c) => lines.push(`  - ${c.category}: ${c.amount}`));
  }

  if (d.budgets.length) {
    lines.push('');
    lines.push('Budgets:');
    d.budgets.forEach((b) =>
      lines.push(`  - ${b.name}: ${b.spent}/${b.amount} (${b.percent}%, ${b.status})`)
    );
  }

  if (d.upcomingBills.length) {
    lines.push('');
    lines.push('Upcoming payments (7 days):');
    d.upcomingBills.forEach((b) => lines.push(`  - ${b.date} ${b.name}: ${b.amount}`));
    lines.push(`  Total upcoming: ${d.upcomingTotal}`);
  }

  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderHtml(d) {
  const parts = [];
  parts.push('<h2>FinMan weekly summary</h2>');
  parts.push(`<p>Period: ${escapeHtml(d.period.start)} — ${escapeHtml(d.period.end)}</p>`);
  if (d.currency) parts.push(`<p>Amounts in ${escapeHtml(d.currency)}</p>`);
  parts.push('<ul>');
  parts.push(`<li>Income: <b>${d.income}</b></li>`);
  parts.push(`<li>Expenses: <b>${d.expense}</b></li>`);
  parts.push(`<li>Net: <b>${d.net}</b></li>`);
  parts.push(`<li>Transactions: ${d.transactionCount}</li>`);
  parts.push('</ul>');

  if (d.topCategories.length) {
    parts.push('<h3>Top expense categories</h3><ul>');
    d.topCategories.forEach((c) =>
      parts.push(`<li>${escapeHtml(c.category)}: ${c.amount}</li>`)
    );
    parts.push('</ul>');
  }

  if (d.budgets.length) {
    parts.push('<h3>Budgets</h3><ul>');
    d.budgets.forEach((b) =>
      parts.push(
        `<li>${escapeHtml(b.name)}: ${b.spent}/${b.amount} (${b.percent}%, ${escapeHtml(b.status)})</li>`
      )
    );
    parts.push('</ul>');
  }

  if (d.upcomingBills.length) {
    parts.push('<h3>Upcoming payments (7 days)</h3><ul>');
    d.upcomingBills.forEach((b) =>
      parts.push(`<li>${escapeHtml(b.date)} ${escapeHtml(b.name)}: ${b.amount}</li>`)
    );
    parts.push('</ul>');
    parts.push(`<p>Total upcoming: <b>${d.upcomingTotal}</b></p>`);
  }

  return parts.join('\n');
}

function digestSubject(d) {
  return `FinMan: your weekly summary (${d.period.start} — ${d.period.end})`;
}

// --- диспетчеризация --------------------------------------------------------

// Уважает notification_settings.weekly_summary / email_enabled.
// Возвращает подробный результат — что построено/отправлено и почему пропущено.
async function sendDigest(userId, { now, force = false } = {}) {
  const settings = await Notification.getSettings(userId);

  // weekly_summary выключен -> ничего не делаем (если не force).
  if (!force && !settings.weekly_summary) {
    logger.info({ userId }, 'digestService.sendDigest: weekly_summary disabled, skipping');
    return { skipped: true, reason: 'WEEKLY_SUMMARY_DISABLED', notified: false, emailed: false };
  }

  const digest = await buildDigest(userId, { now });
  const subject = digestSubject(digest);
  const text = renderText(digest);
  const html = renderHtml(digest);

  // 1) Всегда создаём in-app уведомление (это «сводка», а не нотификация-алёрт).
  let notification = null;
  try {
    notification = await Notification.create({
      user_id: userId,
      type: Notification.TYPES.WEEKLY_SUMMARY,
      title: 'Weekly summary',
      message: `Income ${digest.income}, expenses ${digest.expense}, net ${digest.net}`,
      data: {
        period: digest.period,
        income: digest.income,
        expense: digest.expense,
        net: digest.net,
        topCategories: digest.topCategories,
        upcomingTotal: digest.upcomingTotal,
      },
    });
  } catch (err) {
    logger.error({ userId, msg: err.message }, 'digestService.sendDigest: failed to create in-app notification');
  }

  // 2) Email — только если email_enabled включён. emailService сам no-op-ит,
  //    если ключ не настроен, и НЕ бросает исключений.
  let email = { sent: false, skipped: true, reason: 'EMAIL_DISABLED' };
  if (settings.email_enabled) {
    const user = await get('SELECT id, email, full_name FROM users WHERE id = ?', [userId]);
    if (user && user.email) {
      email = await emailService.sendEmail({
        to: user.email,
        subject,
        html,
        text,
      });
    } else {
      email = { sent: false, skipped: true, reason: 'NO_USER_EMAIL' };
    }
  }

  return {
    skipped: false,
    digest,
    subject,
    notified: Boolean(notification),
    notificationId: notification ? notification.id : null,
    emailed: Boolean(email && email.sent),
    email,
  };
}

// Прогон по всем пользователям (для опционального weekly-cron).
// Не падает из-за одного пользователя.
async function sendDigestToAll({ now } = {}) {
  const users = await query('SELECT id FROM users', []);
  const results = [];
  for (const u of users) {
    try {
      const r = await sendDigest(u.id, { now });
      results.push({ userId: u.id, skipped: r.skipped, emailed: r.emailed, notified: r.notified });
    } catch (err) {
      logger.error({ userId: u.id, msg: err.message }, 'digestService.sendDigestToAll: error for user');
      results.push({ userId: u.id, error: true });
    }
  }
  return results;
}

module.exports = {
  buildDigest,
  renderText,
  renderHtml,
  digestSubject,
  sendDigest,
  sendDigestToAll,
  weekWindow,
};
