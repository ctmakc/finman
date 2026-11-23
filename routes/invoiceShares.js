// routes/invoiceShares.js — sharing an invoice TEMPLATE by link (server only, JWT).
// Mounted at /api/invoice-shares. Templates live in the user's vault; sharing one is the
// user's explicit choice: the browser sends that template here and gets a ?tpl= link.
//   POST /                 { template } -> { code, url }
//   GET  /:code            the shared template, for "copy into my templates"
//   POST /:code/used       counts an import
// The public preview for the sign-up page stays GET /api/invoices/shared/:code.
'use strict';

const express = require('express');
const passport = require('passport');
const svc = require('../services/invoice/service');
const { get, run } = require('../db/database');

const router = express.Router();
router.use(passport.authenticate('jwt', { session: false }));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof svc.InvoiceError) return res.status(e.status).json({ error: true, message: e.message });
    console.error('invoice-shares:', e);
    return res.status(500).json({ error: true, message: 'Share request failed' });
  }
};
const CODE_RE = /^[a-z0-9]{4,32}$/;

router.post('/', wrap(async (req, res) => {
  const t = svc.cleanProfileInput(req.body && req.body.template, false);
  const code = await svc.insertShare(req.user.id, null, t);
  const invite = await require('../services/referral').codeFor(req.user.id).catch(() => null);
  res.status(201).json({ code, url: svc.shareUrl(code, invite) });
}));

router.get('/:code', wrap(async (req, res) => {
  const c = String(req.params.code || '').toLowerCase();
  if (!CODE_RE.test(c)) return res.status(404).json({ error: true, message: 'Template link not found' });
  const row = await get('SELECT * FROM invoice_template_shares WHERE code = ?', [c]);
  if (!row) return res.status(404).json({ error: true, message: 'Template link not found' });
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch (_) { data = {}; }
  res.json({ template: { code: row.code, name: row.name, layout: row.layout, currency: row.currency, number_format: row.number_format, due_days: row.due_days, data, logo: row.logo || null, signature: row.signature || null } });
}));

router.post('/:code/used', wrap(async (req, res) => {
  const c = String(req.params.code || '').toLowerCase();
  if (CODE_RE.test(c)) await run('UPDATE invoice_template_shares SET uses = uses + 1 WHERE code = ?', [c]);
  res.json({ ok: true });
}));

module.exports = router;
