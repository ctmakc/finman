// routes/feedback.js — what people tell the Finman team.
//
//   POST   /api/feedback                 rating | survey | bug | idea | exit (sign-in optional:
//                                        the exit survey is sent right before the account goes)
//   GET    /api/feedback/mine?trigger=   has this person already answered this trigger (dedupe)
//   GET    /api/feedback/admin           list + stats (ADMIN_EMAILS only)
//   PATCH  /api/feedback/admin/:id       { status: new | seen | done }
//   DELETE /api/feedback/admin/:id
//
// The comment is stored for the team and forwarded to the MMIX review inbox
// (review.mmix.biz → Telegram); analytics get only kind / trigger / rating.
// A comment that starts with "test" is a test: is_test=1, never forwarded.
const express = require('express');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const config = require('../config/config');
const { query, get, run } = require('../db/database');
const tracker = require('../services/tracker');

const router = express.Router();
const authenticate = passport.authenticate('jwt', { session: false });

const KINDS = ['rating', 'survey', 'bug', 'idea', 'exit'];
const TRIGGERS = ['menu', 'settings', 'import_done', 'insight_shown', 'day3', 'day7', 'account_delete'];
const STATUSES = ['new', 'seen', 'done'];
const REVIEW_URL = process.env.FEEDBACK_FORWARD_URL || 'https://review.mmix.biz/api/bug-report';

const postLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: true, code: 'rate', message: 'Too many messages, try again in a few minutes' },
});

// Sign-in is optional: a valid token fills req.user, anything else stays anonymous.
function optionalAuth(req, res, next) {
  if (!String(req.headers.authorization || '').startsWith('Bearer ')) return next();
  passport.authenticate('jwt', { session: false }, (err, user) => {
    if (!err && user) req.user = user;
    next();
  })(req, res, next);
}

function isAdmin(user) {
  const email = String((user && user.email) || '').toLowerCase();
  return Boolean(email) && config.adminEmails.includes(email);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(404).json({ error: true, message: 'Not found' });
  next();
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const isTestText = (s) => /^\W*test/i.test(String(s || ''));

function forward(row, extra) {
  if (row.is_test || process.env.NODE_ENV === 'test' || process.env.FEEDBACK_FORWARD === '0') return;
  const stars = row.rating ? ` ★${row.rating}` : '';
  const head = `[Finman ${row.kind}/${row.trigger}${stars}${row.answer ? ' · ' + row.answer : ''}]`;
  const body = {
    description: `${head} ${row.comment || '(no comment)'}`.slice(0, 3900),
    email: '',
    pageUrl: 'https://app.finman.money' + (String(row.page || '/').startsWith('/') ? row.page || '/' : '/' + row.page),
    viewport: clip(extra.viewport, 40) || '',
    lang: row.lang || '',
    userAgent: clip(extra.ua, 300) || '',
    website: '',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  fetch(REVIEW_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

router.post('/', postLimiter, optionalAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const kind = String(b.kind || '');
    const trigger = String(b.trigger || 'menu');
    if (!KINDS.includes(kind)) return res.status(400).json({ error: true, code: 'kind', message: 'Unknown feedback kind' });
    if (!TRIGGERS.includes(trigger)) return res.status(400).json({ error: true, code: 'trigger', message: 'Unknown trigger' });
    let rating = b.rating == null || b.rating === '' ? null : Number(b.rating);
    if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: true, code: 'rating', message: 'Rating is 1 to 5' });
    }
    const answer = b.answer ? String(b.answer).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || null : null;
    const comment = b.comment ? String(b.comment).trim().slice(0, 2000) : '';
    if (rating == null && !answer && !comment) {
      return res.status(400).json({ error: true, code: 'empty', message: 'Pick an answer or write a few words' });
    }
    if ((kind === 'bug' || kind === 'idea') && comment.length < 3) {
      return res.status(400).json({ error: true, code: 'comment', message: 'Write a few words' });
    }
    const userId = req.user && req.user.id ? req.user.id : null;
    // One answer per survey trigger per person (the client hides it too).
    if (userId && kind === 'survey') {
      const dup = await get('SELECT id FROM feedback WHERE user_id = ? AND trigger = ? AND kind = ?', [userId, trigger, kind]);
      if (dup) return res.json({ ok: true, id: dup.id, duplicate: true });
    }
    const row = {
      user_id: userId,
      kind,
      trigger,
      rating,
      answer,
      comment: comment || null,
      page: clip(b.page, 200),
      app_version: clip(b.appVersion, 40),
      lang: clip(b.lang, 8),
      device: tracker.deviceFromUa ? clip(tracker.deviceFromUa(req.headers['user-agent'] || ''), 60) : null,
      is_test: isTestText(comment) || (req.user && tracker.isTestEmail(req.user.email)) ? 1 : 0,
    };
    const r = await run(
      `INSERT INTO feedback (user_id, kind, trigger, rating, answer, comment, page, app_version, lang, device, is_test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.user_id, row.kind, row.trigger, row.rating, row.answer, row.comment, row.page, row.app_version, row.lang, row.device, row.is_test]
    );
    // An anonymous test answer (e.g. an exit survey with a "test…" comment) would sit in the
    // journal with nothing to mark it: on 21.11 one read as a lost real answer. Not journaled.
    if (!(row.is_test && !userId)) {
      tracker.track('feedback_sent', {
        userId,
        props: { kind, trigger, rating },
        req,
        test: Boolean(row.is_test),
      });
    }
    forward(row, { viewport: b.viewport, ua: req.headers['user-agent'] });
    res.status(201).json({ ok: true, id: r.id });
  } catch (error) {
    console.error('feedback post failed:', error.message);
    res.status(500).json({ error: true, message: 'Could not save your message' });
  }
});

// Owner's rule 23.11: no survey in the first session after signing in, and none until the person
// has used Finman on at least 3 different days (days with their own actions, not account age).
const SURVEY_MIN_DAYS = 3;
const FRESH_LOGIN_MIN = 120;
async function surveyGate(userId) {
  const gm = require('../services/growthMetrics');
  const { SYSTEM_EVENTS } = require('../services/journey');
  const skip = [...new Set([...gm.SERVER_ONLY, ...SYSTEM_EVENTS, 'feedback_sent'])];
  const days = await get(
    `SELECT COUNT(DISTINCT date(created_at)) AS n FROM analytics_events
      WHERE user_id = ? AND event NOT IN (${skip.map(() => '?').join(',')})`, [userId, ...skip]).catch(() => ({ n: 0 }));
  const fresh = await get(
    `SELECT 1 AS x FROM analytics_events WHERE user_id = ? AND event IN ('login', 'sign_up')
      AND created_at > datetime('now', ?) LIMIT 1`, [userId, `-${FRESH_LOGIN_MIN} minutes`]).catch(() => null);
  const activeDays = Number(days && days.n) || 0;
  return { activeDays, freshLogin: Boolean(fresh), eligible: activeDays >= SURVEY_MIN_DAYS && !fresh };
}

router.get('/mine', authenticate, async (req, res) => {
  const trigger = String(req.query.trigger || '');
  if (!TRIGGERS.includes(trigger)) return res.status(400).json({ error: true, message: 'Unknown trigger' });
  const row = await get('SELECT id, created_at FROM feedback WHERE user_id = ? AND trigger = ? LIMIT 1', [req.user.id, trigger]);
  const gate = await surveyGate(req.user.id);
  res.json({ answered: Boolean(row), ...gate });
});

// Team: the path of new users and returns, aggregates only (services/growthMetrics.js).
router.get('/admin/metrics', authenticate, requireAdmin, async (req, res) => {
  try {
    const gm = require('../services/growthMetrics');
    const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.since || '')) ? req.query.since : '2026-11-03';
    const m = await gm.load({ query, since });
    res.json({ metrics: m, lines: gm.describe(m) });
  } catch (e) {
    res.status(500).json({ error: true, message: 'Could not count' });
  }
});

router.get('/admin', authenticate, requireAdmin, async (req, res) => {
  const where = [];
  const params = [];
  if (KINDS.includes(req.query.kind)) { where.push('kind = ?'); params.push(req.query.kind); }
  if (TRIGGERS.includes(req.query.trigger)) { where.push('trigger = ?'); params.push(req.query.trigger); }
  if (STATUSES.includes(req.query.status)) { where.push('status = ?'); params.push(req.query.status); }
  if (req.query.tests !== '1') where.push('is_test = 0');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const items = await query(
    `SELECT id, user_id, kind, trigger, rating, answer, comment, page, app_version, lang, device, is_test, status, created_at
       FROM feedback ${w} ORDER BY id DESC LIMIT ${limit}`,
    params
  );
  const stats = await get(
    `SELECT COUNT(*) AS total, ROUND(AVG(rating), 2) AS avg_rating, COUNT(rating) AS rated,
            SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS unread
       FROM feedback ${w}`,
    params
  );
  const answers = await query(
    `SELECT trigger, answer, COUNT(*) AS n FROM feedback ${w ? w + ' AND' : 'WHERE'} answer IS NOT NULL
      GROUP BY trigger, answer ORDER BY n DESC`,
    params
  );
  res.json({ items, stats, answers });
});

router.patch('/admin/:id', authenticate, requireAdmin, async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: true, message: 'Unknown status' });
  const r = await run('UPDATE feedback SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: true, message: 'Not found' });
  res.json({ ok: true });
});

router.delete('/admin/:id', authenticate, requireAdmin, async (req, res) => {
  const r = await run('DELETE FROM feedback WHERE id = ?', [Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: true, message: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
module.exports.isAdmin = isAdmin;
module.exports.surveyGate = surveyGate;
