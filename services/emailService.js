// services/emailService.js — отправка email через Resend, спрятанная за env.
//
// Поведение (wave-2 "email-digest"):
//   - Если RESEND_API_KEY задан -> реально шлём письмо через https://api.resend.com/emails
//     (Bearer RESEND_API_KEY), отправитель — MAIL_FROM.
//   - Если RESEND_API_KEY НЕ задан -> логируем и делаем no-op. НИКОГДА не падаем,
//     не бросаем исключений: возвращаем { sent:false, skipped:true, reason }.
//
// Это сознательно «тихий» сервис: дайджест должен работать (in-app уведомление
// + сборка контента) даже без настроенной почты.
//
// Экспорт:
//   isConfigured()                         -> boolean
//   getFrom()                              -> string (адрес отправителя)
//   sendEmail({ to, subject, html, text, from?, replyTo? }) -> Promise<{ sent, skipped?, id?, reason?, error? }>
//     from/replyTo необязательны: from перекрывает MAIL_FROM для одного письма.

'use strict';

const axios = require('axios');
const logger = require('../lib/logger');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'FinMan <noreply@finman.app>';

// Ключ читаем динамически (на каждый вызов), чтобы тесты могли
// выставлять/сбрасывать env без перезагрузки модуля.
function apiKey() {
  return process.env.RESEND_API_KEY || '';
}

function getFrom() {
  return process.env.MAIL_FROM || DEFAULT_FROM;
}

function isConfigured() {
  return Boolean(apiKey());
}

// Простейшая нормализация получателей в массив непустых строк.
function normalizeRecipients(to) {
  const list = Array.isArray(to) ? to : [to];
  return list
    .map((addr) => (typeof addr === 'string' ? addr.trim() : ''))
    .filter(Boolean);
}

// Отправка письма. Никогда не бросает — всегда резолвится объектом-результатом.
async function sendEmail({ to, subject, html, text, from, replyTo } = {}) {
  const recipients = normalizeRecipients(to);

  if (recipients.length === 0) {
    logger.warn('emailService.sendEmail: no recipient, skipping');
    return { sent: false, skipped: true, reason: 'NO_RECIPIENT' };
  }

  if (!isConfigured()) {
    // Чёткий disabled-режим: ничего не падает, просто no-op.
    logger.info(
      { to: recipients, subject },
      'emailService.sendEmail: RESEND_API_KEY not set, email not sent (no-op)'
    );
    return { sent: false, skipped: true, reason: 'EMAIL_NOT_CONFIGURED' };
  }

  const payload = {
    // Явный from (например, LEAD_NOTIFY_FROM у signupNotify) важнее MAIL_FROM.
    from: from || getFrom(),
    to: recipients,
    subject: subject || '(no subject)',
  };
  if (replyTo) payload.reply_to = replyTo;
  if (html) payload.html = html;
  // Resend требует html или text; если html нет — гарантируем text.
  if (text || !html) payload.text = text || '';

  try {
    const resp = await axios.post(RESEND_ENDPOINT, payload, {
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    const id = (resp.data && resp.data.id) || null;
    logger.info({ to: recipients, id }, 'emailService.sendEmail: email sent');
    return { sent: true, id };
  } catch (err) {
    // Сетевые/HTTP-ошибки НЕ роняют дайджест — логируем и возвращаем флаг.
    const status = err.response && err.response.status;
    logger.error(
      { to: recipients, status, msg: err.message },
      'emailService.sendEmail: Resend send error'
    );
    return { sent: false, error: true, reason: 'SEND_FAILED', status: status || null };
  }
}

module.exports = { isConfigured, getFrom, sendEmail };
