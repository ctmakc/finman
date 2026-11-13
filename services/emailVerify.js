// services/emailVerify.js — email confirmation for password sign-ups.
//
// Non-blocking by design: the user keeps working right after sign-up; the app
// shows a banner with "Resend" until the link is opened. Google sign-ins are
// verified by Google (migration 022 back-fills them, createFromGoogle sets it).
//
// The one-time token lives only in the email; the DB keeps its sha-256.
//
// Test sign-ups (isTestSignup: *.test domains, +smoke) never reach a real inbox:
// the letter goes to VERIFY_TEST_SINK when it is set (Resend's
// delivered@resend.dev proves delivery end to end), otherwise it is skipped.
// For test sign-ups only, the link is written to the server log so a smoke run
// can open it.
//
// Env (all optional):
//   VERIFY_MAIL_FROM   sender; default "Finman <noreply@<domain of LEAD_NOTIFY_FROM>>"
//                      (the Resend key can only send from a verified domain), then MAIL_FROM
//   VERIFY_TEST_SINK   where letters to test sign-ups go (e.g. delivered@resend.dev)
//   APP_URL            public origin for the link; default: the request's origin

'use strict';

const crypto = require('crypto');
const { get, run } = require('../db/database');
const emailService = require('./emailService');
const { isTestSignup } = require('./signupNotify');
const logger = require('../lib/logger');

const RESEND_COOLDOWN_MS = 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sender() {
  if (process.env.VERIFY_MAIL_FROM) return process.env.VERIFY_MAIL_FROM;
  const lead = process.env.LEAD_NOTIFY_FROM || '';
  const m = lead.match(/@([A-Za-z0-9.-]+)>?\s*$/);
  if (m) return `Finman <noreply@${m[1]}>`;
  return emailService.getFrom();
}

function appOrigin(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (!req) return 'https://app.finman.money';
  return `${req.protocol}://${req.get('host')}`;
}

function buildLetter(link) {
  const subject = 'Confirm your email for Finman';
  const text = [
    'Hi,',
    '',
    'Confirm your email so we can reach you about your Finman account (password resets, security notices):',
    link,
    '',
    'The link works once. If you did not create a Finman account, ignore this letter.',
    '',
    'Finman · app.finman.money',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#EDF7F6;font-family:Arial,Helvetica,sans-serif;color:#0B2A2E">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #9CC3C6">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:bold;letter-spacing:-0.01em">Finman</td></tr>
<tr><td style="padding:8px 28px 0;font-size:15px;line-height:1.55">Confirm your email so we can reach you about your Finman account: password resets and security notices.</td></tr>
<tr><td style="padding:22px 28px"><a href="${link}" style="display:inline-block;background:#0B2A2E;color:#ffffff;text-decoration:none;padding:12px 20px;font-size:15px;font-weight:bold">Confirm email</a></td></tr>
<tr><td style="padding:0 28px 26px;font-size:12px;line-height:1.5;color:#3D5A5E">The link works once. If you did not create a Finman account, ignore this letter.<br>${link}</td></tr>
</table></body></html>`;
  return { subject, text, html };
}

// Issue a fresh token and send the letter.
// Returns { sent, skipped?, reason?, retryAfter? } — never throws for mail errors.
async function sendVerification(userId, req, { force = false } = {}) {
  const user = await get(
    'SELECT id, email, username, email_verified_at, email_verify_sent_at FROM users WHERE id = ?',
    [userId]
  );
  if (!user) return { sent: false, reason: 'NO_USER' };
  if (user.email_verified_at) return { sent: false, reason: 'ALREADY_VERIFIED' };

  if (!force && user.email_verify_sent_at) {
    const last = new Date(String(user.email_verify_sent_at).replace(' ', 'T') + (String(user.email_verify_sent_at).endsWith('Z') ? '' : 'Z')).getTime();
    const wait = last + RESEND_COOLDOWN_MS - Date.now();
    if (Number.isFinite(wait) && wait > 0) {
      return { sent: false, reason: 'COOLDOWN', retryAfter: Math.ceil(wait / 1000) };
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  await run(
    `UPDATE users SET email_verify_hash = ?, email_verify_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [hashToken(token), user.id]
  );
  const link = `${appOrigin(req)}/api/auth/verify-email?token=${token}`;
  const letter = buildLetter(link);

  let to = user.email;
  if (isTestSignup(user)) {
    logger.info({ userId: user.id, link }, '[email-verify] test sign-up: verification link');
    if (!process.env.VERIFY_TEST_SINK) return { sent: false, skipped: true, reason: 'TEST_SIGNUP' };
    to = process.env.VERIFY_TEST_SINK;
  }

  const result = await emailService.sendEmail({ to, from: sender(), ...letter });
  return { sent: Boolean(result && result.sent), reason: result && result.reason, test: to !== user.email };
}

// Fire-and-forget variant for the register handler.
const inflight = new Set();
function sendVerificationLater(userId, req) {
  const work = sendVerification(userId, req, { force: true }).catch((e) => {
    logger.error({ msg: e && e.message }, '[email-verify] send failed');
    return { sent: false, error: true };
  });
  inflight.add(work);
  work.finally(() => inflight.delete(work));
  return work;
}

// Wait for letters still being sent (tests, graceful shutdown).
function flush() {
  return Promise.all([...inflight]);
}

// Consume a token. Returns the user id on success, null otherwise.
async function verifyToken(token) {
  if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const user = await get('SELECT id FROM users WHERE email_verify_hash = ?', [hashToken(token)]);
  if (!user) return null;
  await run(
    `UPDATE users SET email_verified_at = CURRENT_TIMESTAMP, email_verify_hash = NULL WHERE id = ?`,
    [user.id]
  );
  return user.id;
}

module.exports = { sendVerification, sendVerificationLater, flush, verifyToken, hashToken, buildLetter, sender, RESEND_COOLDOWN_MS };
