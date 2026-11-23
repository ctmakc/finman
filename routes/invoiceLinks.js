// routes/invoiceLinks.js — the issuer's published invoices (server only, JWT). Mounted at
// /api/invoice-links. The browser builds the snapshot of one invoice (GET /api/invoices/:id/snapshot,
// served by the server or by the vault engine) and publishes it here.
//   GET    /               my live links with client views
//   PUT    /:invoiceId     publish or refresh { snapshot }
//   DELETE /:invoiceId     turn the link off (the published copy is dropped)
'use strict';

const express = require('express');
const passport = require('passport');
const links = require('../services/invoice/links');
const tracker = require('../services/tracker');

const router = express.Router();
router.use(passport.authenticate('jwt', { session: false }));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof links.LinkError) return res.status(e.status).json({ error: true, message: e.message });
    console.error('invoice-links:', e);
    return res.status(500).json({ error: true, message: 'Link request failed' });
  }
};

router.get('/', wrap(async (req, res) => res.json({ links: await links.list(req.user.id) })));
router.put('/:invoiceId', express.json({ limit: '6mb' }), wrap(async (req, res) => {
  const r = await links.publish(req.user.id, req.params.invoiceId, req.body && req.body.snapshot);
  if (r.created) {
    try { tracker.track('invoice_link_created', { userId: req.user.id, req, test: tracker.isTestEmail(req.user.email) }); } catch (_) { /* never breaks */ }
  }
  res.status(r.created ? 201 : 200).json(r);
}));
router.delete('/:invoiceId', wrap(async (req, res) => res.json(await links.revoke(req.user.id, req.params.invoiceId))));

module.exports = router;
