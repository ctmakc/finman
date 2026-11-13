// routes/track.js — public analytics endpoints of the app itself.
//
//   GET  /api/t/config        client config for public/js/attribution.js
//   POST /api/t               funnel beacon before login (register_view, ...)
//   GET  /api/t/unsubscribe   one-click opt-out from lifecycle emails
//   *    /op/track            same-origin relay to the self-hosted OpenPanel
//                             (no third-party domain in the browser, CSP
//                             stays connect-src 'self', the real client IP
//                             goes along in openpanel-client-ip)
'use strict';

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const tracker = require('../services/tracker');
const { run } = require('../db/database');
const config = require('../config/config');
const logger = require('../lib/logger');

const router = express.Router();

const beaconLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// Events the browser may write before there is an account. Everything else
// is recorded server-side (middleware/activity.js) and cannot be forged.
const PUBLIC_EVENTS = new Set([
  'app_landing', 'register_view', 'register_submit', 'register_error', 'login_view',
  'login_submit', 'google_click', 'pwa_install_prompt', 'pwa_installed',
]);

router.get('/config', (req, res) => {
  const webId = process.env.OPENPANEL_WEB_CLIENT_ID;
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    openpanel: webId && process.env.OPENPANEL_API_URL ? { clientId: webId, apiUrl: '/op' } : null,
  });
});

router.post('/', beaconLimiter, (req, res) => {
  const b = req.body || {};
  const event = String(b.event || '');
  if (!PUBLIC_EVENTS.has(event)) return res.status(204).end();
  const props = {};
  if (b.props && typeof b.props === 'object') {
    for (const [k, v] of Object.entries(b.props).slice(0, 10)) {
      if (/^[a-z_]{1,30}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        props[k] = typeof v === 'string' ? v.slice(0, 200) : v;
      }
    }
  }
  tracker.track(event, {
    anonId: b.anon_id, props, path: typeof b.path === 'string' ? b.path : null, req,
    // OpenPanel already gets these from the web SDK; keep only our copy.
    test: true,
  });
  res.status(204).end();
});

// ---------- unsubscribe (lifecycle emails) ----------

function unsubToken(userId) {
  return crypto.createHmac('sha256', String(config.jwtSecret)).update('unsub:' + userId).digest('hex').slice(0, 32);
}

// GET from the link in the email; POST is the RFC 8058 one-click
// (List-Unsubscribe-Post) that mail apps send on their own.
async function unsubscribe(req, res) {
  const id = parseInt(req.query.u, 10);
  const t = String(req.query.t || '');
  const ok = Number.isInteger(id) && id > 0 && t.length === 32
    && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(unsubToken(id)));
  if (!ok) return res.status(400).type('html').send('<p style="font-family:sans-serif">Link is invalid.</p>');
  try {
    await run('UPDATE users SET lifecycle_opt_out = 1 WHERE id = ?', [id]);
    tracker.track('email_unsubscribe', { userId: id, req });
  } catch (e) {
    logger.warn({ err: e.message }, '[track] unsubscribe failed');
  }
  return res.type('html').send('<p style="font-family:sans-serif">Done. Finman will not send you tips and reminders any more. '
    + 'Account emails (password reset, billing) still arrive.</p>');
}
router.get('/unsubscribe', unsubscribe);
router.post('/unsubscribe', unsubscribe);

// ---------- /op relay to the self-hosted OpenPanel ----------

const opLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });
const FORWARD = ['content-type', 'openpanel-client-id', 'openpanel-sdk-name', 'openpanel-sdk-version', 'user-agent', 'origin'];

const opRelay = express.Router();
opRelay.post('/track', opLimiter, express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const base = (process.env.OPENPANEL_API_URL || '').replace(/\/+$/, '');
  if (!base) return res.status(204).end();
  const headers = {};
  for (const h of FORWARD) if (req.get(h)) headers[h] = req.get(h);
  headers['openpanel-client-ip'] = tracker.clientIp(req);
  try {
    const r = await fetch(`${base}/track`, {
      method: 'POST', headers, body: req.body && req.body.length ? req.body : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
  } catch (e) {
    logger.warn({ err: e.message }, '[op-relay] upstream failed');
    res.status(202).json({ queued: false });
  }
});

module.exports = { router, opRelay, unsubToken, PUBLIC_EVENTS };
