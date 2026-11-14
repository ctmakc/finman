// routes/userAi.js — "Your AI": the person's own ChatGPT / Claude / Gemini / … key and the
// assistant that runs on it. Mounted at /api/ai/my behind JWT auth, before the operator
// /api/ai tier gate: the person pays their provider, so every plan can use it.
// Keys go in once and come back only as a mask.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const keys = require('../services/userAi/keys');
const agent = require('../services/userAi/agent');
const providers = require('../services/userAi/providers');
const tracker = require('../services/tracker');
const logger = require('../lib/logger');

const router = express.Router();
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
router.use(noStore);

// Per person (the key is theirs, so the cap only guards Finman itself).
const byUser = (windowMs, max) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `u${req.user.id}`,
  validate: false,
  message: { error: true, code: 'AI_SLOW_DOWN', message: 'Too many requests, wait a minute' },
});
const chatLimiter = byUser(60 * 1000, 30);
const keyLimiter = byUser(15 * 60 * 1000, 30);

const locale = (req) => {
  const l = String((req.body && req.body.locale) || req.query.locale || req.get('accept-language') || '').slice(0, 2).toLowerCase();
  return ['en', 'uk', 'ru'].includes(l) ? l : 'en';
};

function fail(res, e) {
  if (e instanceof providers.UserAiError) {
    return res.status(e.status || 400).json({ error: true, code: e.code, message: e.message, ...(e.threadId ? { thread_id: e.threadId } : {}) });
  }
  // Never log the request body here: it can hold the key.
  logger.error(`[userAi] ${e && e.message}`);
  return res.status(500).json({ error: true, code: 'AI_INTERNAL', message: 'Something went wrong. Try again.' });
}
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e); } };
const testUser = (req) => tracker.isTestEmail(req.user && req.user.email);

router.get('/providers', (req, res) => res.json({ providers: providers.publicProviders() }));

router.get('/keys', wrap(async (req, res) => res.json({ keys: await keys.list(req.user.id) })));

router.post('/keys', keyLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await keys.add(req.user.id, { provider: b.provider, key: b.key, label: b.label, model: b.model, base_url: b.base_url });
  tracker.track('ai_key_added', { userId: req.user.id, props: { provider: out.key.provider }, req, test: testUser(req) });
  res.status(201).json(out);
}));

router.patch('/keys/:id', wrap(async (req, res) => {
  const b = req.body || {};
  res.json({ key: await keys.update(req.user.id, req.params.id, { model: b.model, label: b.label, is_default: b.is_default }) });
}));

router.delete('/keys/:id', wrap(async (req, res) => {
  await keys.remove(req.user.id, req.params.id);
  tracker.track('ai_key_deleted', { userId: req.user.id, req, test: testUser(req) });
  res.json({ ok: true });
}));

router.get('/keys/:id/models', keyLimiter, wrap(async (req, res) => res.json(await keys.models(req.user.id, req.params.id))));

router.get('/threads', wrap(async (req, res) => res.json({ threads: await agent.listThreads(req.user.id) })));
router.get('/threads/:id', wrap(async (req, res) => res.json(await agent.view(req.user.id, req.params.id))));
router.delete('/threads/:id', wrap(async (req, res) => res.json(await agent.deleteThread(req.user.id, req.params.id))));

router.post('/chat', chatLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await agent.chat(req.user.id, { threadId: b.thread_id, message: b.message, keyId: b.key_id, locale: locale(req), retry: b.retry === true });
  tracker.track('ai_own_message', { userId: req.user.id, props: { provider: out.thread.key && out.thread.key.provider }, req, test: testUser(req) });
  res.json(out);
}));

router.post('/actions/:id', chatLimiter, wrap(async (req, res) => {
  const approve = !!(req.body && req.body.approve === true);
  res.json(await agent.resolveAction(req.user.id, req.params.id, approve, locale(req)));
}));

module.exports = router;
