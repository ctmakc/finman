// test/digest.test.js — wave-2 "email-digest" stream.
//
// Покрытие:
//   1) emailService — no-op без RESEND_API_KEY (не падает, axios не вызывается);
//      реальная попытка отправки при наличии ключа (axios замокан, сети нет).
//   2) digestService.buildDigest — строит сводку из засеянных данных
//      (income/expense/net/top categories/budget status/upcoming bills).
//   3) digestService.sendDigest — уважает notification_settings.weekly_summary
//      и email_enabled; всегда создаёт in-app уведомление; email no-op без ключа.
//   4) POST /api/notifications/test-digest — отдаёт собранный дайджест,
//      создаёт уведомление в БД, корректно работает без почтового ключа.
//
// ВАЖНО: axios мокается ДО загрузки emailService, чтобы ни один тест не ходил
// в сеть. Resend-ключ выставляется точечно и сбрасывается после.

const { makeApp } = require('./helpers/app');

// --- Мок axios (единственный сетевой выход emailService) -------------------
jest.mock('axios');
const axios = require('axios');

// --- promise-обёртки над raw sqlite3 handle из harness ---------------------
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// Фиксированная «сегодняшняя» дата для детерминизма окна сводки.
// NOW = реальное «сейчас», а даты сидов считаем относительно него, чтобы тест
// был устойчив к смене суток (route-хендлеры используют реальный new Date(),
// а не инъектируемый now — хардкод дат ломался на полночном переходе).
const NOW = new Date();
const dstr = (off) => new Date(NOW.getTime() - off * 86400000).toISOString().slice(0, 10);

// Сеем финансовые данные в окне [NOW-7d, NOW] и предстоящие платежи.
async function seedFinance(db, userId) {
  const acc = await dbRun(
    db,
    `INSERT INTO accounts (user_id, name, currency, balance, account_type, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [userId, 'Main Card', 'UAH', 5000, 'card']
  );
  const accountId = acc.id;

  // Окно [NOW-7d, NOW]: берём offset 1..5 с запасом, чтобы time-of-day не выкинул граничные.
  const txs = [
    [dstr(5), 'Salary', 'Income', 40000, 'income'],
    [dstr(4), 'Silpo', 'Groceries', -1200, 'expense'],
    [dstr(3), 'ATB', 'Groceries', -800, 'expense'],
    [dstr(2), 'Netflix', 'Entertainment', -350, 'expense'],
    [dstr(1), 'Uber', 'Transport', -500, 'expense'],
    // ВНЕ окна (раньше начала) — не должно попасть в сводку.
    [dstr(40), 'Old groceries', 'Groceries', -9999, 'expense'],
  ];
  for (const [date, description, category, amount, type] of txs) {
    await dbRun(
      db,
      `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountId, userId, date, description, category, amount, type]
    );
  }

  // Бюджет: превышен (spent > amount).
  await dbRun(
    db,
    `INSERT INTO budgets (user_id, name, category, amount, spent, period, start_date, notify_at_percent, is_active)
     VALUES (?, 'Groceries Budget', 'Groceries', 1500, 2000, 'monthly', '2026-06-01', 80, 1)`,
    [userId]
  );
  // Бюджет: предупреждение (>= notify_at_percent, < 100).
  await dbRun(
    db,
    `INSERT INTO budgets (user_id, name, category, amount, spent, period, start_date, notify_at_percent, is_active)
     VALUES (?, 'Fun Budget', 'Entertainment', 1000, 900, 'monthly', '2026-06-01', 80, 1)`,
    [userId]
  );

  // Предстоящий платёж в ближайшие 7 дней от NOW.
  await dbRun(
    db,
    `INSERT INTO recurring_payments
       (user_id, account_id, name, amount, type, frequency, start_date, next_payment_date, is_active)
     VALUES (?, ?, 'Rent', 12000, 'expense', 'monthly', '2026-06-01', '${dstr(-3)}', 1)`,
    [userId, accountId]
  );
  // Платёж далеко за окном — не должен попасть.
  await dbRun(
    db,
    `INSERT INTO recurring_payments
       (user_id, account_id, name, amount, type, frequency, start_date, next_payment_date, is_active)
     VALUES (?, ?, 'Insurance', 5000, 'expense', 'yearly', '2026-06-01', '${dstr(-45)}', 1)`,
    [userId, accountId]
  );

  return { accountId };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
});

// ==========================================================================
describe('emailService', () => {
  const ORIG_KEY = process.env.RESEND_API_KEY;
  const ORIG_FROM = process.env.MAIL_FROM;

  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIG_KEY;
    if (ORIG_FROM === undefined) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = ORIG_FROM;
  });

  test('isConfigured отражает наличие RESEND_API_KEY', () => {
    const emailService = require('../services/emailService');
    delete process.env.RESEND_API_KEY;
    expect(emailService.isConfigured()).toBe(false);
    process.env.RESEND_API_KEY = 're_test_123';
    expect(emailService.isConfigured()).toBe(true);
  });

  test('getFrom использует MAIL_FROM или дефолт', () => {
    const emailService = require('../services/emailService');
    delete process.env.MAIL_FROM;
    expect(typeof emailService.getFrom()).toBe('string');
    expect(emailService.getFrom().length).toBeGreaterThan(0);
    process.env.MAIL_FROM = 'Me <me@example.com>';
    expect(emailService.getFrom()).toBe('Me <me@example.com>');
  });

  test('sendEmail без ключа — no-op, axios не вызывается, не падает', async () => {
    const emailService = require('../services/emailService');
    delete process.env.RESEND_API_KEY;
    const res = await emailService.sendEmail({
      to: 'user@example.com',
      subject: 'Hi',
      text: 'body',
    });
    expect(res.sent).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('EMAIL_NOT_CONFIGURED');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sendEmail без получателя — no-op, не падает', async () => {
    const emailService = require('../services/emailService');
    process.env.RESEND_API_KEY = 're_test_123';
    const res = await emailService.sendEmail({ subject: 'Hi', text: 'body' });
    expect(res.sent).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('NO_RECIPIENT');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sendEmail с ключом — шлёт через Resend (Bearer + endpoint), axios замокан', async () => {
    const emailService = require('../services/emailService');
    process.env.RESEND_API_KEY = 're_test_abc';
    process.env.MAIL_FROM = 'FinMan <noreply@finman.test>';
    axios.post.mockResolvedValue({ data: { id: 'email_123' } });

    const res = await emailService.sendEmail({
      to: 'user@example.com',
      subject: 'Weekly',
      html: '<b>hi</b>',
      text: 'hi',
    });

    expect(res.sent).toBe(true);
    expect(res.id).toBe('email_123');
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(payload.from).toBe('FinMan <noreply@finman.test>');
    expect(payload.to).toEqual(['user@example.com']);
    expect(payload.subject).toBe('Weekly');
    expect(opts.headers.Authorization).toBe('Bearer re_test_abc');
  });

  test('sendEmail при сетевой ошибке — не падает, возвращает error-флаг', async () => {
    const emailService = require('../services/emailService');
    process.env.RESEND_API_KEY = 're_test_abc';
    axios.post.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 422 } }));

    const res = await emailService.sendEmail({ to: 'u@e.com', subject: 'x', text: 'y' });
    expect(res.sent).toBe(false);
    expect(res.error).toBe(true);
    expect(res.reason).toBe('SEND_FAILED');
    expect(res.status).toBe(422);
  });
});

// ==========================================================================
describe('digestService.buildDigest', () => {
  let ctx;
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  test('строит сводку из данных за окно: income/expense/net/top/budgets/bills', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    const digestService = require('../services/digestService');

    const d = await digestService.buildDigest(ctx.userId, { now: NOW });

    expect(d.period.start).toBe(dstr(7));
    expect(d.period.end).toBe(dstr(0));

    // income = 40000, расходы = 1200+800+350+500 = 2850 (старый -9999 вне окна).
    expect(d.income).toBe(40000);
    expect(d.expense).toBe(2850);
    expect(d.net).toBe(37150);
    expect(d.transactionCount).toBe(5);

    // Топ-категория расходов — Groceries (1200+800=2000).
    expect(d.topCategories[0]).toEqual({ category: 'Groceries', amount: 2000 });
    const cats = d.topCategories.map((c) => c.category);
    expect(cats).toContain('Entertainment');
    expect(cats).toContain('Transport');

    // Бюджеты: один exceeded, один warning.
    const byName = Object.fromEntries(d.budgets.map((b) => [b.name, b]));
    expect(byName['Groceries Budget'].status).toBe('exceeded');
    expect(byName['Groceries Budget'].percent).toBeGreaterThanOrEqual(100);
    expect(byName['Fun Budget'].status).toBe('warning');
    expect(byName['Fun Budget'].percent).toBe(90);

    // Предстоящие платежи: только Rent (Insurance вне окна 7 дней).
    expect(d.upcomingBills).toHaveLength(1);
    expect(d.upcomingBills[0].name).toBe('Rent');
    expect(d.upcomingBills[0].amount).toBe(12000);
    expect(d.upcomingTotal).toBe(12000);
  });

  test('пустой пользователь — корректные нули, без падения', async () => {
    ctx = await makeApp();
    const digestService = require('../services/digestService');
    const d = await digestService.buildDigest(ctx.userId, { now: NOW });
    expect(d.income).toBe(0);
    expect(d.expense).toBe(0);
    expect(d.net).toBe(0);
    expect(d.topCategories).toEqual([]);
    expect(d.budgets).toEqual([]);
    expect(d.upcomingBills).toEqual([]);
  });

  test('renderText/renderHtml детерминированы и содержат ключевые цифры', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    const digestService = require('../services/digestService');
    const d = await digestService.buildDigest(ctx.userId, { now: NOW });

    const text = digestService.renderText(d);
    expect(text).toContain('Еженедельная сводка');
    expect(text).toContain('40000');
    expect(text).toContain('Groceries');

    const html = digestService.renderHtml(d);
    expect(html).toContain('<h2>');
    expect(html).toContain('40000');
  });
});

// ==========================================================================
describe('digestService.sendDigest — настройки уведомлений', () => {
  let ctx;
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  async function setSettings(db, userId, fields) {
    // Гарантируем строку настроек.
    await dbRun(db, `INSERT OR IGNORE INTO notification_settings (user_id) VALUES (?)`, [userId]);
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    const vals = Object.values(fields).map((v) => (v ? 1 : 0));
    vals.push(userId);
    await dbRun(db, `UPDATE notification_settings SET ${sets} WHERE user_id = ?`, vals);
  }

  test('weekly_summary выключен -> пропуск (без force)', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    await setSettings(ctx.db, ctx.userId, { weekly_summary: 0, email_enabled: 1 });
    const digestService = require('../services/digestService');

    const r = await digestService.sendDigest(ctx.userId, { now: NOW });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('WEEKLY_SUMMARY_DISABLED');
    expect(r.notified).toBe(false);

    const notes = await dbAll(ctx.db, 'SELECT * FROM notifications WHERE user_id = ?', [ctx.userId]);
    expect(notes).toHaveLength(0);
  });

  test('weekly_summary включён -> создаёт in-app уведомление; email no-op без ключа', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    await setSettings(ctx.db, ctx.userId, { weekly_summary: 1, email_enabled: 1 });
    delete process.env.RESEND_API_KEY;
    const digestService = require('../services/digestService');

    const r = await digestService.sendDigest(ctx.userId, { now: NOW });
    expect(r.skipped).toBe(false);
    expect(r.notified).toBe(true);
    expect(r.emailed).toBe(false);
    // email включён в настройках, но ключа нет -> no-op (EMAIL_NOT_CONFIGURED).
    expect(r.email.reason).toBe('EMAIL_NOT_CONFIGURED');
    expect(axios.post).not.toHaveBeenCalled();

    const notes = await dbAll(
      ctx.db,
      'SELECT * FROM notifications WHERE user_id = ? AND type = ?',
      [ctx.userId, 'weekly_summary']
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Еженедельная сводка');
  });

  test('email_enabled выключен -> уведомление есть, письмо не шлётся', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    await setSettings(ctx.db, ctx.userId, { weekly_summary: 1, email_enabled: 0 });
    process.env.RESEND_API_KEY = 're_test_abc'; // даже с ключом — не шлём
    const digestService = require('../services/digestService');

    const r = await digestService.sendDigest(ctx.userId, { now: NOW });
    expect(r.notified).toBe(true);
    expect(r.emailed).toBe(false);
    expect(r.email.reason).toBe('EMAIL_DISABLED');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('email_enabled + ключ -> письмо уходит через Resend (axios замокан)', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    await setSettings(ctx.db, ctx.userId, { weekly_summary: 1, email_enabled: 1 });
    process.env.RESEND_API_KEY = 're_test_abc';
    // makeApp() вызывает jest.resetModules(), поэтому emailService получает СВЕЖИЙ
    // mock-инстанс axios. Берём axios ПОСЛЕ makeApp — тот же инстанс, что и сервис.
    const axiosLive = require('axios');
    axiosLive.post.mockResolvedValue({ data: { id: 'email_999' } });
    const digestService = require('../services/digestService');

    const r = await digestService.sendDigest(ctx.userId, { now: NOW });
    expect(r.emailed).toBe(true);
    expect(r.email.id).toBe('email_999');
    expect(axiosLive.post).toHaveBeenCalledTimes(1);
    const [, payload] = axiosLive.post.mock.calls[0];
    expect(payload.to).toEqual(['test@example.com']);
    expect(payload.subject).toContain('сводка за неделю');
  });
});

// ==========================================================================
describe('POST /api/notifications/test-digest', () => {
  let ctx;
  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  test('требует авторизацию', async () => {
    ctx = await makeApp();
    const res = await ctx.request.post('/api/notifications/test-digest');
    expect(res.status).toBe(401);
  });

  test('отдаёт собранный дайджест и создаёт in-app уведомление (без почтового ключа)', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    delete process.env.RESEND_API_KEY;

    const res = await ctx.request
      .post('/api/notifications/test-digest')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.digest.income).toBe(40000);
    expect(res.body.digest.expense).toBe(2850);
    expect(res.body.notified).toBe(true);
    expect(res.body.emailed).toBe(false);

    const notes = await dbAll(
      ctx.db,
      'SELECT * FROM notifications WHERE user_id = ? AND type = ?',
      [ctx.userId, 'weekly_summary']
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('force=true: работает даже при weekly_summary=0', async () => {
    ctx = await makeApp();
    await seedFinance(ctx.db, ctx.userId);
    await dbRun(ctx.db, `INSERT OR IGNORE INTO notification_settings (user_id) VALUES (?)`, [ctx.userId]);
    await dbRun(
      ctx.db,
      `UPDATE notification_settings SET weekly_summary = 0 WHERE user_id = ?`,
      [ctx.userId]
    );

    const res = await ctx.request
      .post('/api/notifications/test-digest')
      .set('Authorization', `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(true);
    expect(res.body.digest).toBeDefined();
  });
});
