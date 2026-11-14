// routes/mcp.js — Finman as a remote MCP server (Streamable HTTP, stateless, JSON replies).
//
//   POST /mcp                 JSON-RPC: initialize, ping, tools/list, tools/call, notifications/*
//   GET|DELETE /mcp           405 (no server-sent stream, no sessions)
//   GET  /api/mcp/pdf/:id     invoice PDF by a signed link from the tools (7 days)
//
// Auth: `Authorization: Bearer <token>` — an OAuth access token (claude.ai connector) or a
// personal access token finman_pat_… (Claude Code and scripts). Without a valid token:
// 401 + WWW-Authenticate pointing at the protected-resource metadata, so the client can
// start the OAuth flow by itself.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const oauth = require('../services/mcp/oauth');
const tools = require('../services/mcp/tools');
const patService = require('../services/patService');
const svc = require('../services/invoice/service');
const pkg = require('../package.json');

const router = express.Router();

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Finman money data of the signed-in account: invoices, clients, accounts and transactions. '
  + 'Invoices: start with list_invoice_templates, then create_invoice. Invoice numbers are assigned by Finman; never invent one. '
  + 'Tax comes from the template. Amounts are in the template currency; percent in record_payment is of the invoice total. '
  + 'Transactions: list_accounts gives account_id; add_transaction takes a positive amount and type income or expense. '
  + 'Use get_spending_summary for totals instead of adding up list_transactions yourself.';

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests, slow down' } },
});

function challenge(res, error) {
  const md = `${oauth.baseUrl()}/.well-known/oauth-protected-resource`;
  res.set('WWW-Authenticate', `Bearer resource_metadata="${md}"${error ? `, error="${error}"` : ''}, scope="${oauth.SCOPE}"`);
  return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authorization required: connect your Finman account' } });
}

async function bearerUser(req) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? h.match(/^Bearer\s+(\S+)\s*$/i) : null;
  if (!m) return { token: false };
  const t = m[1];
  if (t.startsWith(patService.TOKEN_PREFIX)) {
    const userId = await patService.verify(t);
    return { token: true, userId, via: 'pat' };
  }
  const a = await oauth.verifyAccess(t);
  return { token: true, userId: a ? a.userId : null, via: 'oauth' };
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

async function handle(msg, userId) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return err(msg && msg.id, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
  if (isNotification) return null; // notifications/initialized, cancelled… nothing to answer
  switch (msg.method) {
    case 'initialize': {
      const want = p.protocolVersion;
      return ok(msg.id, {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'finman', title: 'Finman', version: pkg.version || '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: tools.listTools() });
    case 'tools/call': {
      if (typeof p.name !== 'string') return err(msg.id, -32602, 'Tool name is required');
      const r = await tools.callTool(userId, p.name, p.arguments);
      if (!r) return err(msg.id, -32602, `Unknown tool: ${p.name}`);
      return ok(msg.id, r);
    }
    case 'resources/list':
      return ok(msg.id, { resources: [] });
    case 'prompts/list':
      return ok(msg.id, { prompts: [] });
    default:
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

router.post('/mcp', mcpLimiter, async (req, res, next) => {
  try {
    const auth = await bearerUser(req);
    if (!auth.userId) return challenge(res, auth.token ? 'invalid_token' : null);
    res.set('Cache-Control', 'no-store');
    const body = req.body;
    if (body === undefined || body === null || (typeof body === 'object' && !Array.isArray(body) && !Object.keys(body).length)) {
      return res.status(400).json(err(null, -32700, 'Parse error: send a JSON-RPC message'));
    }
    if (Array.isArray(body)) {
      if (!body.length || body.length > 20) return res.status(400).json(err(null, -32600, 'Invalid batch'));
      const out = [];
      for (const m of body) { const r = await handle(m, auth.userId); if (r) out.push(r); }
      return out.length ? res.json(out) : res.status(202).end();
    }
    const r = await handle(body, auth.userId);
    return r ? res.json(r) : res.status(202).end();
  } catch (e) {
    return next(e);
  }
});

router.all('/mcp', (req, res) => {
  res.set('Allow', 'POST');
  res.status(405).json(err(null, -32000, 'Use POST for MCP messages'));
});

router.get('/api/mcp/pdf/:id', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const invoiceId = parseInt(req.params.id, 10);
  const userId = Number.isFinite(invoiceId) ? tools.checkPdfLink(invoiceId, req.query) : null;
  if (!userId) return res.status(403).type('text/plain').send('This invoice link has expired. Ask for a new one.');
  try {
    const { buffer, filename } = await svc.invoicePdf(userId, invoiceId);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex');
    return res.send(buffer);
  } catch (e) {
    if (e.status === 404) return res.status(404).type('text/plain').send('Invoice not found');
    console.error('MCP pdf error:', e.message);
    return res.status(500).type('text/plain').send('Could not build the PDF');
  }
});

module.exports = router;
