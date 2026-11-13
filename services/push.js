// services/push.js — Web Push for the PWA (VAPID, the `web-push` package).
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…). Without
// them push is off and every call is a quiet no-op.
// A subscription that answers 404/410 is gone (browser data cleared, permission
// revoked) and is deleted; other failures count up and drop after 5.
'use strict';

const { query, get, run } = require('../db/database');
const logger = require('../lib/logger');
const tracker = require('./tracker');

let webpush = null;
let configured = null;

function config() {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { configured = false; return false; }
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hello@finman.money', pub, priv);
    configured = true;
  } catch (e) {
    logger.warn({ err: e.message }, '[push] web-push unavailable');
    configured = false;
  }
  return configured;
}

function publicKey() {
  return config() ? process.env.VAPID_PUBLIC_KEY : null;
}

function validSub(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string'
    && sub.keys.p256dh.length < 200 && sub.keys.auth.length < 100;
}

async function subscribe(userId, sub, ua) {
  if (!validSub(sub)) return false;
  // The same browser may switch accounts: the endpoint follows the last user.
  await run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, user_agent = excluded.user_agent, fail_count = 0`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(ua || '').slice(0, 300)],
  );
  return true;
}

async function unsubscribe(userId, endpoint) {
  const r = endpoint
    ? await run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint])
    : await run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
  return (r && r.changes) || 0;
}

async function count(userId) {
  const r = await get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [userId]).catch(() => null);
  return (r && r.n) || 0;
}

// payload: { title, body, url, tag, kind }
async function sendToUser(userId, payload, { email } = {}) {
  if (!config()) return { sent: 0, skipped: 'NOT_CONFIGURED' };
  const subs = await query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
  let sent = 0;
  const body = JSON.stringify({
    title: String(payload.title || 'Finman').slice(0, 80),
    body: String(payload.body || '').slice(0, 200),
    url: payload.url || '/',
    tag: payload.tag || payload.kind || 'finman',
    kind: payload.kind || 'generic',
  });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 60 * 60 * 24 });
      await run(`UPDATE push_subscriptions SET last_ok_at = datetime('now'), fail_count = 0 WHERE id = ?`, [s.id]);
      sent += 1;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) await run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
      else {
        await run('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?', [s.id]);
        await run('DELETE FROM push_subscriptions WHERE id = ? AND fail_count >= 5', [s.id]);
        logger.warn({ code, err: e.message }, '[push] send failed');
      }
    }
  }
  if (sent) tracker.track('push_sent', { userId, props: { kind: payload.kind || 'generic', devices: sent }, test: tracker.isTestEmail(email) });
  return { sent };
}

module.exports = { config, publicKey, subscribe, unsubscribe, count, sendToUser, validSub };
