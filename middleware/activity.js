// middleware/activity.js — user action journal.
// After every successful write request of a signed-in user (POST/PUT/PATCH/
// DELETE under /api) one friendly event goes to tracker.track: our
// analytics_events table + self-hosted OpenPanel. Only the route and the
// outcome are recorded; request bodies (amounts, names, notes) never are.
'use strict';

const tracker = require('../services/tracker');

const VERB = { POST: 'created', PUT: 'updated', PATCH: 'updated', DELETE: 'deleted' };
const SKIP = /^\/api\/(auth|t|billing\/webhook|health|sync\/run)(\/|$)/;

// [regex on path (no query), method or '*', event name or fn(match, ok)]
const RULES = [
  [/^\/api\/transactions\/?$/, 'POST', 'transaction_added'],
  [/^\/api\/transactions\/transfer$/, 'POST', 'transfer_added'],
  [/^\/api\/transactions\/import$/, 'POST', (ok) => (ok ? 'import_done' : 'import_failed')],
  [/^\/api\/bank-api\/import\/preview$/, 'POST', (ok) => (ok ? 'import_preview' : 'import_failed')],
  [/^\/api\/bank-api\/import\/commit$/, 'POST', (ok) => (ok ? 'import_done' : 'import_failed')],
  [/^\/api\/bank-api\/connect/, 'POST', 'bank_connect'],
  [/^\/api\/ai\//, 'POST', 'ai_used'],
  [/^\/api\/onboarding\/quickstart$/, 'POST', 'onboarding_quickstart'],
  [/^\/api\/onboarding\/complete-step$/, 'POST', 'onboarding_step'],
  [/^\/api\/billing\/checkout$/, 'POST', 'checkout_started'],
  [/^\/api\/receipts/, 'POST', 'receipt_scanned'],
];

function eventFor(method, path, ok) {
  for (const [re, m, ev] of RULES) {
    if ((m === '*' || m === method) && re.test(path)) return typeof ev === 'function' ? ev(ok) : (ok ? ev : null);
  }
  if (!ok) return null;
  const area = (path.split('/')[2] || '').replace(/[^a-z0-9]+/gi, '_').replace(/s$/, '');
  if (!area) return null;
  return `${area}_${VERB[method] || 'action'}`;
}

function activity(req, res, next) {
  if (!VERB[req.method]) return next();
  res.on('finish', () => {
    try {
      const user = req.user;
      if (!user || !user.id) return;
      const path = (req.originalUrl || '').split('?')[0];
      if (!path.startsWith('/api/') || SKIP.test(path)) return;
      const ok = res.statusCode < 400;
      const event = eventFor(req.method, path, ok);
      if (!event) return;
      const props = { status: res.statusCode };
      if (event === 'ai_used') props.feature = path.split('/')[3] || null;
      if (req.query && req.query.source) props.source = String(req.query.source).slice(0, 40);
      tracker.track(event, { userId: user.id, props, path, req, test: tracker.isTestEmail(user.email) });
    } catch (_) { /* journal must never break a request */ }
  });
  next();
}

module.exports = { activity, eventFor };
