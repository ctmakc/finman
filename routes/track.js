// routes/track.js — public analytics endpoints of the app itself.
//
//   GET  /api/t/config        client config for public/js/attribution.js
//   POST /api/t               funnel beacon before login (register_view, ...)
//   POST /api/t/me            signed-in journal beacon: actions done inside the
//                             encrypted vault (the server never sees those
//                             requests) and screen milestones — event name only
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
const passport = require('passport');
const { isActivityEvent } = require('../lib/activityRules');

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
    // Microsoft Clarity (click / scroll maps): strict masking in the project, data-clarity-mask on <body>.
    clarity: /^[a-z0-9]{6,16}$/.test(process.env.CLARITY_PROJECT_ID || '') ? { id: process.env.CLARITY_PROJECT_ID } : null,
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

// ---------- signed-in journal beacon ----------
// Encrypted (vault) users run the app's routes in their browser, so
// middleware/activity.js never sees their writes. vault.js reports the same
// event name eventFor() would have produced; screens report milestones.
// Only a name and a few short flags are accepted — never amounts or text.
const ME_EVENTS = new Set([
  'vault_prompt_shown', 'vault_key_shown', 'vault_key_saved',
  'report_viewed',
  'onboarding_firstrun_shown', 'onboarding_bank_picked', 'onboarding_import_started', 'onboarding_import_done', 'onboarding_import_failed',
  'onboarding_demo_loaded', 'onboarding_demo_removed', 'onboarding_scratch_started', 'onboarding_insight_shown',
  'onboarding_example_opened', 'onboarding_ai_question', 'onboarding_verify_resent', 'onboarding_email_verified',
  'summary_viewed', 'summary_shared_to_ai',
]);
const ME_PROPS = new Set(['code', 'ext', 'page', 'source', 'mode', 'bank', 'rows', 'local', 'kind', 'step', 'sinceStart', 'emailVerified', 'demo']);
// Once per user, event and page per day: page views and summaries are
// milestones for the funnel, not a clickstream.
const DAILY = new Set(['report_viewed', 'summary_viewed', 'onboarding_firstrun_shown']);
const meLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const jwtAuth = passport.authenticate('jwt', { session: false });

function meEventAllowed(event) {
  return ME_EVENTS.has(event) || isActivityEvent(event);
}

function cleanProps(raw) {
  const props = {};
  if (!raw || typeof raw !== 'object') return props;
  for (const [k, v] of Object.entries(raw).slice(0, 12)) {
    if (!ME_PROPS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) props[k] = Math.round(v);
    else if (typeof v === 'boolean') props[k] = v;
    else if (typeof v === 'string' && /^[\w .:/-]{0,40}$/.test(v)) props[k] = v;
  }
  return props;
}

router.post('/me', meLimiter, jwtAuth, async (req, res) => {
  const b = req.body || {};
  const event = String(b.event || '');
  if (!meEventAllowed(event)) return res.status(204).end();
  const props = cleanProps(b.props);
  try {
    if (DAILY.has(event)) {
      const { get } = require('../db/database');
      const seen = await get(
        `SELECT 1 AS x FROM analytics_events WHERE user_id = ? AND event = ? AND created_at >= date('now')
           AND COALESCE(json_extract(props, '$.page'), '') = ? LIMIT 1`,
        [req.user.id, event, props.page || ''],
      );
      if (seen) return res.status(204).end();
    }
    tracker.track(event, {
      userId: req.user.id, props, req,
      path: typeof b.path === 'string' ? b.path.slice(0, 120) : null,
      test: tracker.isTestEmail(req.user.email),
    });
    if (isActivityEvent(event) && event !== 'import_failed') require('../services/journey').touch(req.user.id);
  } catch (e) {
    logger.warn({ err: e.message }, '[track] me beacon failed');
  }
  return res.status(204).end();
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

module.exports = { router, opRelay, unsubToken, PUBLIC_EVENTS, ME_EVENTS, meEventAllowed, cleanProps };
