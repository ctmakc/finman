// services/signupNotify.js — уведомление оператора о новой регистрации
// (портировано из прод-линейки app.finman.money, добавлено владельцем 2026-09-28).
//
// Регистрация в приложении — единственный «лид» продукта: оператор получает
// письмо с username, email и способом входа; ничего о финансах человека.
// Fire-and-forget: сбой почты или GA4 никогда не блокирует ответ на /register
// и не мешает входу через Google.
//
// Почта идёт через services/emailService.js (Resend). Env (все необязательные;
// без RESEND_API_KEY письмо только логируется):
//   RESEND_API_KEY        ключ Resend (общий с emailService)
//   LEAD_NOTIFY_TO        получатели через запятую (по умолчанию ctmakc@gmail.com)
//   LEAD_NOTIFY_FROM      отправитель этого письма; имеет приоритет над MAIL_FROM
//                         (по умолчанию "INNOVA Leads <leads@remolda.com>")
//   GA4_MEASUREMENT_ID + GA4_API_SECRET  дополнительно анонимное событие sign_up
//                         в GA4 через Measurement Protocol (без данных пользователя)
//
// Тема письма — формат, который доходит до «Входящих» (англ. тема падала в спам):
//   "Регистрация · finman.money · <email>" от "INNOVA Leads", с Reply-To на юзера.

'use strict';

const https = require('https');
const crypto = require('crypto');
const emailService = require('./emailService');
const logger = require('../lib/logger');

const DEFAULT_TO = 'ctmakc@gmail.com';
const DEFAULT_FROM = 'INNOVA Leads <leads@remolda.com>';
const SITE = 'finman.money';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function recipients() {
  return (process.env.LEAD_NOTIFY_TO || DEFAULT_TO).split(',').map((s) => s.trim()).filter(Boolean);
}

function sender() {
  return process.env.LEAD_NOTIFY_FROM || DEFAULT_FROM;
}

function buildSubject(user) {
  const u = user || {};
  return `Signup · ${SITE} · ${u.email || u.username || 'unknown'}`;
}

function buildMessage(user, method) {
  const u = user || {};
  const when = new Date().toISOString();
  const rows = [
    ['Username', u.username],
    ['Email', u.email],
    ['Name', u.fullName || u.full_name],
    ['Method', method === 'google' ? 'Google' : 'email'],
    ['User id', u.id],
    ['Time (UTC)', when],
    ['Site', SITE],
  ];
  const dash = (v) => (v == null || v === '' ? '-' : v);
  const text = rows.map(([k, v]) => `${k}: ${dash(v)}`).join('\n')
    + `\n\nNew signup in the Finman app (app.${SITE}).`;
  const html = `<p style="font-family:sans-serif">New signup in the Finman app (app.${SITE}).</p>`
    + '<table style="font-family:sans-serif;border-collapse:collapse">'
    + rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(dash(v))}</b></td></tr>`).join('')
    + '</table>';
  return { subject: buildSubject(u), text, html };
}

// Письмо через emailService (Resend). Собственный ретрай: 3 попытки с паузой,
// 4xx (кроме 429) не повторяем — это ошибка данных, а не сети.
async function sendMail(user, method, opts = {}) {
  const msg = buildMessage(user, method);
  if (!emailService.isConfigured()) {
    logger.info({ subject: msg.subject }, '[signup-notify] RESEND_API_KEY not set, skipped');
    return { sent: false, skipped: true, reason: 'EMAIL_NOT_CONFIGURED' };
  }
  const payload = {
    to: recipients(),
    from: sender(),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  };
  if (user && user.email) payload.replyTo = user.email;

  const attempts = opts.attempts || 3;
  const delay = typeof opts.retryDelayMs === 'number' ? opts.retryDelayMs : 2000;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await emailService.sendEmail(payload);
    if (last && last.sent) {
      logger.info({ subject: msg.subject, id: last.id }, '[signup-notify] sent');
      return last;
    }
    if (last && last.skipped) return last;
    const status = last && last.status;
    if (status && status >= 400 && status < 500 && status !== 429) break;
    if (attempt < attempts && delay > 0) await new Promise((r) => setTimeout(r, attempt * delay));
  }
  logger.error({ subject: msg.subject, result: last }, '[signup-notify] FAILED');
  return last || { sent: false, error: true };
}

// Анонимное событие sign_up в GA4 (Measurement Protocol). client_id — хеш
// внутреннего id пользователя, никогда не email.
function sendGa4SignUp(method, userId) {
  const mid = process.env.GA4_MEASUREMENT_ID;
  const secret = process.env.GA4_API_SECRET;
  if (!mid || !secret) return Promise.resolve({ skipped: true });

  const h = crypto.createHash('sha256').update('finman:' + userId).digest('hex');
  const clientId = parseInt(h.slice(0, 8), 16) + '.' + parseInt(h.slice(8, 16), 16);
  const body = JSON.stringify({
    client_id: clientId,
    events: [{ name: 'sign_up', params: { method: method || 'password', engagement_time_msec: 1 } }],
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = https.request({
        method: 'POST',
        hostname: 'www.google-analytics.com',
        path: `/mp/collect?measurement_id=${encodeURIComponent(mid)}&api_secret=${encodeURIComponent(secret)}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => {
        res.resume();
        res.on('end', () => finish({ ok: res.statusCode < 300, status: res.statusCode }));
      });
      req.on('timeout', () => { req.destroy(new Error('GA4 timeout')); });
      req.on('error', (e) => finish({ ok: false, error: e.message }));
      req.write(body);
      req.end();
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

// Незавершённые уведомления — чтобы тесты (и graceful shutdown) могли дождаться.
const inflight = new Set();

// notifySignup(user, method, opts) -> Promise<[mailResult, ga4Result]>
// Возвращает промис, но вызывающий код его НЕ ждёт: ошибки логируются внутри.
// Smoke/QA sign-ups (reserved .test TLD, +smoke aliases) never
// reach the operator's inbox or GA4: a release smoke on production must not
// look like a lead.
function isTestSignup(u) {
  const email = String((u && u.email) || '').toLowerCase();
  return /@[^@]+\.test$/.test(email) || /\+smoke[^@]*@/.test(email);
}

function notifySignup(user, method, opts = {}) {
  const u = user || {};
  if (isTestSignup(u)) {
    logger.info({ method }, '[signup-notify] test sign-up, skipped');
    return Promise.resolve([{ sent: false, skipped: true, reason: 'TEST_SIGNUP' }, { skipped: true }]);
  }
  const work = Promise.all([
    sendMail(u, method, opts),
    opts.skipGa4 ? Promise.resolve({ skipped: true }) : sendGa4SignUp(method, u.id),
  ]).catch((e) => {
    logger.error({ msg: e && e.message }, '[signup-notify] error');
    return [{ sent: false, error: true }, { ok: false }];
  });
  inflight.add(work);
  work.finally(() => inflight.delete(work));
  return work;
}

// Дождаться всех текущих уведомлений (тесты, shutdown).
function flush() {
  return Promise.all(Array.from(inflight));
}

module.exports = { notifySignup, isTestSignup, flush, buildSubject, buildMessage, sendGa4SignUp, sendMail };
