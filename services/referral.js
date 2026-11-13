// services/referral.js — "invite a friend".
//
// Each user gets a short personal code (users.ref_code, created on first use).
// The invite link opens the sign-up form with fm_ref=invite-<code>; the app's
// attribution script keeps fm_ref as touch.site_referrer, so at sign-up
// attach() finds the inviter, stores users.referred_by and sends two events:
// referral_signup (new user) and friend_joined (inviter). No rewards in money:
// the inviter gets the "friend" badge (user_milestones).
'use strict';

const crypto = require('crypto');
const { query, get, run } = require('../db/database');
const tracker = require('./tracker');
const logger = require('../lib/logger');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_RE = /^invite-([a-z0-9]{6,12})$/i;

function newCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

async function codeFor(userId) {
  const row = await get('SELECT ref_code FROM users WHERE id = ?', [userId]);
  if (!row) return null;
  if (row.ref_code) return row.ref_code;
  for (let i = 0; i < 5; i += 1) {
    const code = newCode();
    try {
      const r = await run('UPDATE users SET ref_code = ? WHERE id = ? AND ref_code IS NULL', [code, userId]);
      if (r && r.changes) return code;
      const again = await get('SELECT ref_code FROM users WHERE id = ?', [userId]);
      if (again && again.ref_code) return again.ref_code;
    } catch (e) {
      if (!/UNIQUE/i.test(e.message)) throw e; // collision: try another code
    }
  }
  throw new Error('could not allocate a referral code');
}

function linkFor(code) {
  const base = (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, '');
  return `${base}/?signup&fm_ref=invite-${code}&utm_source=invite&utm_medium=referral&utm_campaign=friend`;
}

// Invite code from the sign-up attribution (first or last touch).
function codeFromAcquisition(acq) {
  if (!acq) return null;
  let last = {};
  try { last = acq.last_touch ? JSON.parse(acq.last_touch) : {}; } catch (_) { last = {}; }
  for (const v of [acq.site_referrer, last.site_referrer, acq.utm_content, last.utm_content]) {
    const m = CODE_RE.exec(String(v || '').trim());
    if (m) return m[1].toLowerCase();
  }
  return null;
}

async function attach(user, acq) {
  const code = codeFromAcquisition(acq);
  if (!code || !user || !user.id) return null;
  const inviter = await get('SELECT id, email FROM users WHERE ref_code = ?', [code]).catch(() => null);
  if (!inviter || inviter.id === user.id) return null;
  const r = await run('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL', [inviter.id, user.id]);
  if (!r || !r.changes) return null;
  const test = tracker.isTestEmail(user.email) || tracker.isTestEmail(inviter.email);
  tracker.track('referral_signup', { userId: user.id, props: { inviter: inviter.id }, test });
  tracker.track('friend_joined', { userId: inviter.id, props: { friend: user.id }, test });
  try {
    const journey = require('./journey');
    const inv = await journey.userRow(inviter.id);
    if (inv) await journey.mark(inv, 'badge_friend');
  } catch (e) { logger.warn({ err: e.message }, '[referral] badge failed'); }
  return inviter.id;
}

async function stats(userId) {
  const code = await codeFor(userId);
  const friends = await query(
    `SELECT u.id, u.created_at,
            EXISTS (SELECT 1 FROM user_milestones m WHERE m.user_id = u.id AND m.key = 'activated') AS activated
       FROM users u WHERE u.referred_by = ?`, [userId],
  ).catch(() => []);
  return {
    code,
    link: linkFor(code),
    joined: friends.length,
    activated: friends.filter((f) => Number(f.activated)).length,
  };
}

module.exports = { codeFor, linkFor, codeFromAcquisition, attach, stats, newCode };
