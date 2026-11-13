// routes/engagement.js — the habit loop inside the app (mounted at
// /api/engagement behind apiAuthMiddleware).
//
//   GET    /journey          checklist + streak + badges + top AI CFO tips + invite + push state
//   POST   /journey/dismiss  hide the checklist on the dashboard
//   GET    /tips             AI CFO tips from the user's own numbers
//   GET    /recap?kind=      "Your week/month in money" (opening it completes the weekly review step)
//   GET    /email-preview?kind=  the recap email as HTML (what Monday's email looks like)
//   GET    /referral         invite code, link and counts
//   POST   /event            whitelisted UI events -> tracker (with the user id)
//   GET    /push/key         VAPID public key (null = push off)
//   POST   /push/subscribe   save this browser's subscription
//   DELETE /push/subscribe   remove one (endpoint in body) or all
//   POST   /push/test        a test notification to this user's devices
'use strict';

const express = require('express');
const { ok, fail } = require('../lib/respond');
const journey = require('../services/journey');
const cfoTips = require('../services/cfoTips');
const moneyRecap = require('../services/moneyRecap');
const referral = require('../services/referral');
const push = require('../services/push');
const tracker = require('../services/tracker');
const logger = require('../lib/logger');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user || !req.user.id) return fail(res, 401, 'UNAUTHORIZED', 'Authentication required');
  return next();
});

const CLIENT_EVENTS = new Set([
  'checklist_shown', 'checklist_step_click', 'invite_link_copied', 'invite_shared',
  'push_enabled', 'push_disabled', 'push_denied', 'push_clicked', 'email_click',
  'empty_state_cta', 'tip_clicked', 'tip_asked', 'weekly_review_shared',
]);

const isTest = (req) => tracker.isTestEmail(req.user.email);

router.get('/journey', async (req, res, next) => {
  try {
    const j = await journey.compute(req.user.id, { record: true });
    if (!j) return fail(res, 404, 'NOT_FOUND', 'User not found');
    const [tips, ref, devices] = await Promise.all([
      cfoTips.tips(req.user.id, { limit: 3 }).catch((e) => { logger.warn({ err: e.message }, '[engagement] tips'); return []; }),
      referral.stats(req.user.id).catch(() => null),
      push.count(req.user.id),
    ]);
    return ok(res, {
      ...j,
      tips,
      referral: ref,
      push: { available: Boolean(push.publicKey()), devices },
    });
  } catch (e) { return next(e); }
});

router.post('/journey/dismiss', async (req, res, next) => {
  try {
    await journey.dismiss(req.user.id);
    return ok(res, { dismissed: true });
  } catch (e) { return next(e); }
});

router.get('/tips', async (req, res, next) => {
  try {
    return ok(res, await cfoTips.tips(req.user.id, { limit: Math.min(8, Number(req.query.limit) || 5) }));
  } catch (e) { return next(e); }
});

router.get('/recap', async (req, res, next) => {
  try {
    const kind = req.query.kind === 'month' ? 'month' : 'week';
    const [r, tips] = await Promise.all([
      moneyRecap.recap(req.user.id, { kind }),
      cfoTips.tips(req.user.id, { limit: 3 }).catch(() => []),
    ]);
    const source = ['email', 'push', 'app'].includes(req.query.source) ? req.query.source : 'app';
    // Opening the recap with own data in it completes the weekly review step.
    if (r.transactions || r.lastDataDate) {
      await journey.markReviewed(req.user.id, journey.weekStart(r.period.end), source);
    }
    return ok(res, { ...r, tips });
  } catch (e) { return next(e); }
});

router.get('/email-preview', async (req, res, next) => {
  try {
    const kind = req.query.kind === 'month' ? 'month' : 'week';
    const m = await require('../services/engagementMail').build(req.user.id, kind);
    if (!m) return fail(res, 404, 'NOT_FOUND', 'User not found');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:");
    return res.send(m.html);
  } catch (e) { return next(e); }
});

router.get('/referral', async (req, res, next) => {
  try {
    return ok(res, await referral.stats(req.user.id));
  } catch (e) { return next(e); }
});

router.post('/event', (req, res) => {
  const event = String((req.body && req.body.event) || '');
  if (!CLIENT_EVENTS.has(event)) return fail(res, 400, 'BAD_EVENT', 'Unknown event');
  const raw = (req.body && req.body.props) || {};
  const props = {};
  for (const [k, v] of Object.entries(raw).slice(0, 8)) {
    if (/^[a-z_]{1,30}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) {
      props[k] = typeof v === 'string' ? v.slice(0, 80) : v;
    }
  }
  tracker.track(event, { userId: req.user.id, props, req, path: req.body && typeof req.body.path === 'string' ? req.body.path.slice(0, 120) : null, test: isTest(req) });
  journey.touch(req.user.id);
  return ok(res, { ok: true });
});

router.get('/push/key', (req, res) => ok(res, { key: push.publicKey() }));

router.post('/push/subscribe', async (req, res, next) => {
  try {
    if (!push.publicKey()) return fail(res, 503, 'PUSH_OFF', 'Push is not configured');
    const sub = req.body && req.body.subscription;
    if (!push.validSub(sub)) return fail(res, 400, 'BAD_SUBSCRIPTION', 'Invalid push subscription');
    await push.subscribe(req.user.id, sub, req.get('user-agent'));
    tracker.track('push_enabled', { userId: req.user.id, req, test: isTest(req) });
    return ok(res, { devices: await push.count(req.user.id) });
  } catch (e) { return next(e); }
});

router.delete('/push/subscribe', async (req, res, next) => {
  try {
    const endpoint = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint : null;
    const removed = await push.unsubscribe(req.user.id, endpoint);
    if (removed) tracker.track('push_disabled', { userId: req.user.id, req, test: isTest(req) });
    return ok(res, { removed, devices: await push.count(req.user.id) });
  } catch (e) { return next(e); }
});

router.post('/push/test', async (req, res, next) => {
  try {
    const r = await push.sendToUser(req.user.id, {
      kind: 'test', title: 'Finman notifications are on',
      body: 'Your weekly money recap will arrive here on Mondays.', url: '/week?fm_src=push&fm_push=test', tag: 'test',
    }, { email: req.user.email });
    return ok(res, r);
  } catch (e) { return next(e); }
});

module.exports = router;
module.exports.CLIENT_EVENTS = CLIENT_EVENTS;
