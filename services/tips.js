// services/tips.js — three short tips for new Finman users, part of the daily lifecycle run
// (services/lifecycle.js, LIFECYCLE_EMAILS=1).
//
//   tip_invoice  24 h – 5 days after sign-up   how to send the first invoice with a pay link
//   tip_import   3 – 14 days                   how to bring a bank statement in
//   tip_next     7 – 30 days                   what to look at next (money map, budgets, own AI)
//                                              + one line asking what is missing (-> /feedback)
// Windows widened 23.11 (touch map): the 44 h gap pushed tips past their window, and nothing
// reached people on day 14–30. Each tip is still sent once.
//
// Frequency: one email per user per run, never within 2 days of any other Finman email
// (lifecycle_emails), each tip once. A tip whose step the user already took is skipped for
// good (kind `<tip>:skip`): someone who imported a statement never hears "import a statement".
// Never chased: no tip after 3 Finman emails in a row with no visit (app_open / login) after them.
// Who: our own sign-ups only (acquisition tracked from sign-up), not test accounts, not opted
// out (users.lifecycle_opt_out = Settings → Emails "Tips" and the one-click unsubscribe link).
// No money figures in any tip: vault (encrypted) users get the same text.
// Language: the browser language at sign-up (user_acquisition.lang): en / ru / uk.
'use strict';

const { query, get, run } = require('../db/database');
const emailService = require('./emailService');
const tracker = require('./tracker');
const logger = require('../lib/logger');

const APP_URL = () => (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, '');
const SITE = 'https://finman.money';
const GAP_HOURS = 44;
const MAX_UNANSWERED = 3;
// Emails to the person (not the team digest rows kept per user, not skip marks).
const USER_EMAIL_KINDS = "kind NOT LIKE '%:skip' AND kind NOT LIKE 'digest_%' AND kind NOT LIKE 'metrics:%'";

const TIPS = [
  { kind: 'tip_invoice', fromH: 24, toH: 5 * 24, done: ['invoice_created', 'invoice_link_created'], doneInvoices: true },
  { kind: 'tip_import', fromH: 3 * 24, toH: 14 * 24, done: ['import_done', 'vault_import_done', 'onboarding_import_done', 'statement_read'] },
  { kind: 'tip_next', fromH: 7 * 24, toH: 30 * 24, done: [] },
];

const TEXT = {
  en: {
    hi: (n) => `Hi ${n},`,
    hiAnon: 'Hi,',
    tip_invoice: {
      subject: 'Send your first invoice from Finman in 3 minutes',
      body: (app) => [
        'Finman makes invoices as clean PDFs from your own template: your company, bank details, tax line and logo.',
        `1. Open Invoices and pick a layout: ${app}/invoices\n2. Fill in your details once; every next invoice takes them.\n3. Add the client and the lines, save, and press "Client link".`,
        'The client opens the invoice in a browser, downloads the PDF and pays with your own card link, PayPal.me, e-Transfer or bank details. You see when they open it, and late invoices turn red in your list.',
      ],
    },
    tip_import: {
      subject: 'Your bank statement in Finman: about a minute',
      body: (app) => [
        'The fastest way to see where the money goes is one statement from your bank.',
        `1. In online banking, download the last 2–3 months as CSV or OFX (a PDF works too).\n2. Drop the file into Finman: ${app}/transactions\n3. Categories fill in by themselves; fix one and Finman remembers the rule.`,
        `Step-by-step for your bank: ${SITE}/banks/`,
      ],
    },
    tip_next: {
      subject: 'Three things to try in Finman this week',
      body: (app) => [
        `Money map: where each dollar went last month, on one screen. ${app}/money-map`,
        `Budgets: set a limit for the 2–3 categories that surprise you most; Finman shows the rest of the month as you spend. ${app}/budgets`,
        `Your own AI: connect ChatGPT, Claude or Gemini and ask questions about your money in plain words. ${app}/my-ai`,
        `What is missing in Finman for you? Two clicks, and the people who build it read every answer: ${app}/feedback`,
      ],
    },
    sign: 'Finman',
    reply: 'Questions? Reply to this email.',
    stop: 'Stop tips and reminders',
  },
  ru: {
    hi: (n) => `Здравствуйте, ${n}!`,
    hiAnon: 'Здравствуйте!',
    tip_invoice: {
      subject: 'Первый счёт из Finman за 3 минуты',
      body: (app) => [
        'Finman делает счета аккуратным PDF по вашему шаблону: компания, реквизиты, налог и логотип.',
        `1. Откройте «Счета» и выберите вид: ${app}/invoices\n2. Один раз заполните свои данные — дальше каждый счёт берёт их сам.\n3. Укажите клиента и строки, сохраните и нажмите «Ссылка для клиента».`,
        'Клиент открывает счёт в браузере, скачивает PDF и платит по вашей ссылке на оплату картой, PayPal.me, e-Transfer или банковским реквизитам. Вы видите, когда он открыл счёт, а просроченные счета подсвечиваются красным.',
      ],
    },
    tip_import: {
      subject: 'Выписка банка в Finman: около минуты',
      body: (app) => [
        'Быстрее всего увидеть, куда уходят деньги, по одной выписке из банка.',
        `1. В интернет-банке скачайте последние 2–3 месяца в CSV или OFX (PDF тоже подойдёт).\n2. Перетащите файл в Finman: ${app}/transactions\n3. Категории расставятся сами; поправьте одну — Finman запомнит правило.`,
        `Пошагово для вашего банка: ${SITE}/banks/`,
      ],
    },
    tip_next: {
      subject: 'Три вещи, которые стоит попробовать в Finman на этой неделе',
      body: (app) => [
        `Карта денег: куда ушёл каждый доллар в прошлом месяце, на одном экране. ${app}/money-map`,
        `Бюджеты: поставьте лимит на 2–3 категории, которые удивляют сильнее всего; Finman покажет остаток месяца по ходу трат. ${app}/budgets`,
        `Свой ИИ: подключите ChatGPT, Claude или Gemini и спрашивайте о своих деньгах обычными словами. ${app}/my-ai`,
        `Чего вам не хватает в Finman? Два клика, и каждый ответ читают те, кто его делает: ${app}/feedback`,
      ],
    },
    sign: 'Finman',
    reply: 'Вопросы? Ответьте на это письмо.',
    stop: 'Отписаться от подсказок и напоминаний',
  },
  uk: {
    hi: (n) => `Вітаємо, ${n}!`,
    hiAnon: 'Вітаємо!',
    tip_invoice: {
      subject: 'Перший рахунок із Finman за 3 хвилини',
      body: (app) => [
        'Finman робить рахунки охайним PDF за вашим шаблоном: компанія, реквізити, податок і логотип.',
        `1. Відкрийте «Рахунки» й оберіть вигляд: ${app}/invoices\n2. Один раз заповніть свої дані — далі кожен рахунок бере їх сам.\n3. Вкажіть клієнта й рядки, збережіть і натисніть «Посилання для клієнта».`,
        'Клієнт відкриває рахунок у браузері, завантажує PDF і платить за вашим посиланням на оплату карткою, PayPal.me, e-Transfer або банківськими реквізитами. Ви бачите, коли він відкрив рахунок, а прострочені рахунки підсвічуються червоним.',
      ],
    },
    tip_import: {
      subject: 'Виписка банку у Finman: близько хвилини',
      body: (app) => [
        'Найшвидше побачити, куди йдуть гроші, — за однією випискою з банку.',
        `1. В інтернет-банку завантажте останні 2–3 місяці у CSV або OFX (PDF теж підійде).\n2. Перетягніть файл у Finman: ${app}/transactions\n3. Категорії розставляться самі; виправте одну — Finman запам’ятає правило.`,
        `Покроково для вашого банку: ${SITE}/banks/`,
      ],
    },
    tip_next: {
      subject: 'Три речі, які варто спробувати у Finman цього тижня',
      body: (app) => [
        `Карта грошей: куди пішов кожен долар минулого місяця, на одному екрані. ${app}/money-map`,
        `Бюджети: поставте ліміт на 2–3 категорії, які дивують найбільше; Finman покаже залишок місяця по ходу витрат. ${app}/budgets`,
        `Свій ШІ: підключіть ChatGPT, Claude або Gemini і питайте про свої гроші звичайними словами. ${app}/my-ai`,
        `Чого вам бракує у Finman? Два кліки, і кожну відповідь читають ті, хто його робить: ${app}/feedback`,
      ],
    },
    sign: 'Finman',
    reply: 'Питання? Відповідайте на цей лист.',
    stop: 'Відписатися від підказок і нагадувань',
  },
};

function langOf(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.startsWith('uk')) return 'uk';
  if (s.startsWith('ru')) return 'ru';
  return 'en';
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(kind, u, unsubUrl) {
  const L = TEXT[langOf(u.lang)];
  const t = L[kind];
  const first = String(u.full_name || '').trim().split(/\s+/)[0];
  const hi = first ? L.hi(first) : L.hiAnon;
  const paras = [hi, ...t.body(APP_URL()), L.reply, L.sign];
  const text = `${paras.join('\n\n')}\n\n${L.stop}: ${unsubUrl}`;
  const link = (p) => esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2B50F0">$1</a>').replace(/\n/g, '<br>');
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;line-height:1.55;color:#121A2E">'
    + paras.map((p) => `<p>${link(p)}</p>`).join('')
    + `<p style="font-size:12px;color:#6b7390"><a href="${esc(unsubUrl)}" style="color:#6b7390">${esc(L.stop)}</a></p></div>`;
  return { subject: t.subject, text, html };
}

async function eventsOf(userId) {
  const rows = await query('SELECT event, COUNT(*) AS n FROM analytics_events WHERE user_id = ? GROUP BY event', [userId]).catch(() => []);
  const by = {};
  for (const r of rows) by[r.event] = r.n;
  return by;
}

async function alreadyDone(tip, userId) {
  const ev = await eventsOf(userId);
  if (tip.done.some((e) => ev[e])) return true;
  if (tip.doneInvoices) {
    const r = await get('SELECT COUNT(*) AS n FROM invoices WHERE user_id = ?', [userId]).catch(() => ({ n: 0 }));
    if (r && r.n > 0) return true;
  }
  return false;
}

async function recentEmail(userId) {
  const r = await get(
    `SELECT 1 AS x FROM lifecycle_emails WHERE user_id = ? AND ${USER_EMAIL_KINDS} AND sent_at > datetime('now', ?) LIMIT 1`,
    [userId, `-${GAP_HOURS} hours`]).catch(() => null);
  return !!r;
}

// Finman emails sent to the person since they last opened Finman.
async function unanswered(userId) {
  const last = await get(
    `SELECT MAX(created_at) AS at FROM analytics_events WHERE user_id = ? AND event IN ('app_open', 'login')`, [userId],
  ).catch(() => null);
  const r = await get(
    `SELECT COUNT(*) AS n FROM lifecycle_emails WHERE user_id = ? AND ${USER_EMAIL_KINDS} AND sent_at > COALESCE(?, '1970-01-01')`,
    [userId, last && last.at],
  ).catch(() => ({ n: 0 }));
  return Number(r && r.n) || 0;
}

async function candidates(tip) {
  return query(
    `SELECT u.id, u.email, u.full_name, u.lifecycle_opt_out, a.backfilled, a.lang
       FROM users u JOIN user_acquisition a ON a.user_id = u.id
      WHERE u.created_at <= datetime('now', ?) AND u.created_at > datetime('now', ?)
        AND COALESCE(u.lifecycle_opt_out, 0) = 0 AND a.backfilled = 0
        AND NOT EXISTS (SELECT 1 FROM lifecycle_emails l WHERE l.user_id = u.id AND (l.kind = ? OR l.kind = ?))
      ORDER BY u.id`,
    [`-${tip.fromH} hours`, `-${tip.toH} hours`, tip.kind, `${tip.kind}:skip`]);
}

async function runTips({ dryRun = false } = {}) {
  if (process.env.LIFECYCLE_EMAILS !== '1' && !dryRun) return { skipped: true };
  const from = process.env.LIFECYCLE_FROM;
  if (!from && !dryRun) return { skipped: true, reason: 'NO_LIFECYCLE_FROM' };
  const { unsubscribeUrl } = require('./lifecycle');
  const touched = new Set();
  const out = { sent: 0, skipped_done: 0, waiting: 0, quiet: 0, planned: [] };
  for (const tip of TIPS) {
    for (const u of await candidates(tip)) {
      if (touched.has(u.id)) continue;
      if (tracker.isTestEmail(u.email)) continue;
      if (await alreadyDone(tip, u.id)) {
        if (!dryRun) await run('INSERT OR IGNORE INTO lifecycle_emails (user_id, kind) VALUES (?, ?)', [u.id, `${tip.kind}:skip`]);
        out.skipped_done++;
        continue;
      }
      if (await recentEmail(u.id)) { out.waiting++; continue; }
      if (await unanswered(u.id) >= MAX_UNANSWERED) { out.quiet++; continue; }
      touched.add(u.id);
      if (dryRun) { out.planned.push({ user_id: u.id, kind: tip.kind, lang: langOf(u.lang) }); continue; }
      const unsub = unsubscribeUrl(u.id);
      const m = render(tip.kind, u, unsub);
      const r = await emailService.sendEmail({
        to: [u.email], from, subject: m.subject, text: m.text, html: m.html,
        replyTo: process.env.LIFECYCLE_REPLY_TO || undefined,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      if (r && r.sent) {
        await run('INSERT OR IGNORE INTO lifecycle_emails (user_id, kind) VALUES (?, ?)', [u.id, tip.kind]);
        tracker.track('email_sent', { userId: u.id, props: { kind: tip.kind } });
        out.sent++;
      }
    }
  }
  logger.info({ sent: out.sent, skipped_done: out.skipped_done, waiting: out.waiting }, '[tips] run');
  return out;
}

module.exports = { runTips, render, unanswered, TIPS, TEXT, langOf, MAX_UNANSWERED };
