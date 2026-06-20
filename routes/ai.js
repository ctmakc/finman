// routes/ai.js — STUB. Будет заменён feature-стримом F4 (AI-ассистент).
// Аутентификация + requireTier('pro') навешиваются на уровне server.js.
const express = require('express');
const router = express.Router();
const passport = require('passport');
const { fail } = require('../lib/respond');

// Защищаем аутентификацией (как и реальные роуты), чтобы поведение совпало.
router.use(passport.authenticate('jwt', { session: false }));

router.all('*', (req, res) => {
  return fail(res, 501, 'NOT_IMPLEMENTED', 'AI assistant is not implemented yet');
});

module.exports = router;
