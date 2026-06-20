// routes/anomalies.js — STUB. Будет заменён feature-стримом F7 (детектор аномалий).
const express = require('express');
const router = express.Router();
const passport = require('passport');
const { fail } = require('../lib/respond');

router.use(passport.authenticate('jwt', { session: false }));

router.all('*', (req, res) => {
  return fail(res, 501, 'NOT_IMPLEMENTED', 'Anomaly detection is not implemented yet');
});

module.exports = router;
