// routes/billing.js — STUB. Будет заменён feature-стримом F10 (Stripe billing).
const express = require('express');
const router = express.Router();
const { fail } = require('../lib/respond');

router.all('*', (req, res) => {
  return fail(res, 501, 'NOT_IMPLEMENTED', 'Billing is not implemented yet');
});

module.exports = router;
