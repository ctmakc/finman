// middleware/activity.js — user action journal.
// After every successful write request of a signed-in user (POST/PUT/PATCH/
// DELETE under /api) one friendly event goes to tracker.track: our
// analytics_events table + self-hosted OpenPanel. Only the route and the
// outcome are recorded; request bodies (amounts, names, notes) never are.
'use strict';

const tracker = require('../services/tracker');

const { VERB, SKIP, eventFor } = require('../lib/activityRules');

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
      if (!ok && res.locals && res.locals.failCode) props.code = String(res.locals.failCode).slice(0, 40);
      if (req.query && req.query.source) props.source = String(req.query.source).slice(0, 40);
      tracker.track(event, { userId: user.id, props, path, req, test: tracker.isTestEmail(user.email) });
      if (ok) require('../services/journey').touch(user.id);
    } catch (_) { /* journal must never break a request */ }
  });
  next();
}

module.exports = { activity, eventFor };
