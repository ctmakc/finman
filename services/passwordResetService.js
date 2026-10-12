// services/passwordResetService.js — "Forgot password" flow.
//
//   requestReset({ email, baseUrl }) -> { sent, skipped?, reason? }
//     Always resolves; never reveals whether the email exists. When the email
//     belongs to a user, a single-use token (1 hour) is stored as a SHA-256
//     hash and a link is mailed through services/emailService (Resend).
//   resetPassword({ token, password }) -> { ok, userId } | throws AppError
//     Verifies the token, sets the new password through User.update (which
//     bumps token_version, so every JWT issued before the reset is revoked),
//     marks the token used and voids the user's other outstanding tokens.
//
// The raw token is only ever in the email and the user's browser.

'use strict';

const crypto = require('crypto');
const { query, get, run } = require('../db/database');
const User = require('../models/user');
const emailService = require('./emailService');
const logger = require('../lib/logger');
const { AppError } = require('../middleware/error');

const TOKEN_BYTES = 32;
const TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_PASSWORD = 6;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// Builds the link the email carries. APP_URL wins; otherwise the request origin.
function resetLink(baseUrl, token) {
  const base = String(process.env.APP_URL || baseUrl || '').replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emailBody({ user, link }) {
  const name = user.full_name || user.username || '';
  const text = [
    `Hi ${name},`,
    '',
    'Someone asked to reset the password of your Finman account. Open the link below within one hour to choose a new password:',
    link,
    '',
    'If you did not ask for this, ignore this email — your password stays the same.',
  ].join('\n');
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #10201C; max-width: 520px; margin: 0 auto; padding: 24px;">
      <p style="font-size: 18px; font-weight: 600; margin: 0 0 12px;">Reset your Finman password</p>
      <p style="margin: 0 0 16px; line-height: 1.5;">Hi ${escapeHtml(name)},<br>
      someone asked to reset the password of your Finman account. The link works for <strong>one hour</strong> and can be used once.</p>
      <p style="margin: 0 0 20px;">
        <a href="${escapeHtml(link)}" style="display: inline-block; background: #0E7C6B; color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 600;">Choose a new password</a>
      </p>
      <p style="margin: 0 0 8px; font-size: 13px; color: #4A5C57;">Or paste this address into your browser:<br>
      <a href="${escapeHtml(link)}" style="color: #0E7C6B; word-break: break-all;">${escapeHtml(link)}</a></p>
      <p style="margin: 16px 0 0; font-size: 13px; color: #4A5C57;">If you did not ask for this, ignore this email — your password stays the same.</p>
    </div>`;
  return { text, html };
}

async function requestReset({ email, baseUrl } = {}) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return { sent: false, skipped: true, reason: 'NO_EMAIL' };

  const user = await User.findByEmail(address);
  if (!user) {
    logger.info({ email: address }, 'passwordReset: no account for this email (answering generically)');
    return { sent: false, skipped: true, reason: 'NO_USER' };
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  // One live token per user: older unused tokens stop working now.
  await run(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, [isoNow(), user.id]);
  await run(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [user.id, hashToken(token), isoNow(TTL_MS)]
  );

  const link = resetLink(baseUrl, token);
  const { text, html } = emailBody({ user, link });
  const result = await emailService.sendEmail({
    to: user.email,
    subject: 'Reset your Finman password',
    text,
    html,
  });
  if (!result.sent) {
    logger.warn({ userId: user.id, reason: result.reason }, 'passwordReset: email not sent');
  }
  return result;
}

async function findLiveToken(token) {
  const raw = String(token || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(raw)) return null;
  const row = await get(
    `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`,
    [hashToken(raw)]
  );
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

async function resetPassword({ token, password } = {}) {
  const pwd = String(password == null ? '' : password);
  if (pwd.length < MIN_PASSWORD) {
    throw new AppError(400, 'WEAK_PASSWORD', `Password must be at least ${MIN_PASSWORD} characters`);
  }
  const row = await findLiveToken(token);
  if (!row) {
    throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired. Request a new one.');
  }
  const user = await User.findById(row.user_id);
  if (!user) {
    throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired. Request a new one.');
  }
  // User.update hashes the password and bumps token_version (old JWTs die).
  await User.update(user.id, { password: pwd });
  await run(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, [isoNow(), user.id]);
  logger.info({ userId: user.id }, 'passwordReset: password changed');
  return { ok: true, userId: user.id };
}

// Housekeeping for a cron/CLI: drop rows older than a week.
async function purgeExpired() {
  const cutoff = isoNow(-7 * 24 * 60 * 60 * 1000);
  const result = await run(`DELETE FROM password_resets WHERE expires_at < ?`, [cutoff]);
  return result.changes || 0;
}

module.exports = { requestReset, resetPassword, purgeExpired, hashToken, TTL_MS, _query: query };
