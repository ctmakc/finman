// routes/pdfDrop.js — /p/<id>: an invoice PDF from an AI chat on a vault account, decrypted in the
// browser with the key from the link's #fragment (services/mcp/pdfDrop.js). The server only
// serves the ciphertext and a page with no data in it.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const drops = require('../services/mcp/pdfDrop');

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
router.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

router.get('/:id', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Invoice PDF · Finman</title><link rel="stylesheet" href="/css/invoice-public.css?v=1123"></head>
<body><main class="ip-wrap ip-msg" data-drop="${String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '')}">
<section class="ip-plate"><h1 id="pd-title">Opening the invoice…</h1><p id="pd-text" class="ip-k">The file is decrypted in this browser with the key from the link.</p>
<p class="ip-actions" style="margin-top:16px"><a class="ip-btn ip-btn-primary" id="pd-dl" hidden>Download PDF</a></p></section>
<p class="ip-made">Invoice made with Finman · <a href="https://app.finman.money/?signup&utm_source=invoice&utm_medium=ai_pdf">app.finman.money</a></p>
</main><script src="/js/pdf-drop.js?v=1123" defer></script></body></html>`);
});

router.get('/:id/blob', async (req, res) => {
  const b = await drops.blobOf(req.params.id).catch(() => null);
  if (!b) return res.status(404).type('text/plain').send('This link has expired. Ask the assistant for a new one.');
  res.type('application/octet-stream').send(b);
});

module.exports = router;
