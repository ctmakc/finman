// services/mcp/tools.js — the tools Finman offers to MCP clients (Claude and others).
//
// Every tool runs as one signed-in user (userId from the OAuth or personal token) and
// goes through services/invoice/service.js, which scopes every query by user_id.
// Invoice numbers always come from the template counter: the tools have no number
// field, and a number sent anyway is dropped.
'use strict';

const crypto = require('crypto');
const svc = require('../invoice/service');
const core = require('../invoice/core');
const config = require('../../config/config');
const { TX_TOOLS, TxToolError } = require('./txTools');

const PDF_TTL = 7 * 24 * 60 * 60; // seconds

class ToolError extends Error {}

const money = (cents, currency) => (cents === null || cents === undefined ? null : `${core.fmtCents(cents)} ${currency || ''}`.trim());
const id = (v, name = 'invoice_id') => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new ToolError(`${name} must be a positive number`);
  return n;
};

// ---------- signed PDF links (no login needed to open, valid 7 days) ----------
function pdfKey() { return crypto.createHmac('sha256', String(config.jwtSecret)).update('finman-mcp-pdf-v1').digest(); }
function pdfSig(userId, invoiceId, exp) {
  return crypto.createHmac('sha256', pdfKey()).update(`${userId}.${invoiceId}.${exp}`).digest('base64url');
}
function pdfUrl(userId, invoiceId) {
  const exp = Math.floor(Date.now() / 1000) + PDF_TTL;
  return `${svc_base()}/api/mcp/pdf/${invoiceId}?u=${userId}&exp=${exp}&sig=${pdfSig(userId, invoiceId, exp)}`;
}
function checkPdfLink(invoiceId, q) {
  const u = parseInt(q.u, 10);
  const exp = parseInt(q.exp, 10);
  if (!Number.isFinite(u) || !Number.isFinite(exp) || exp < Date.now() / 1000 || typeof q.sig !== 'string') return null;
  const want = Buffer.from(pdfSig(u, invoiceId, exp));
  const got = Buffer.from(q.sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? u : null;
}
function svc_base() { return (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, ''); }

// ---------- shapes the model sees ----------
function brief(inv) {
  return {
    id: inv.id, number: inv.number, status: inv.status, client: inv.client_name,
    issue_date: inv.issue_date, due_date: inv.due_date, currency: inv.currency,
    total: money(inv.total_cents, inv.currency), paid: money(inv.paid_cents, inv.currency),
    balance_due: money(inv.balance_cents, inv.currency),
  };
}

function full(userId, inv, payments) {
  return {
    ...brief(inv),
    template: inv.profile_name,
    client_details: inv.client_details,
    items: (inv.items || []).map((it) => ({
      description: it.description, detail: it.detail, note: it.note,
      qty: it.qty, price: money(it.price_cents, inv.currency), amount: money(it.amount_cents, inv.currency),
    })),
    subtotal: money(inv.subtotal_cents, inv.currency),
    tax: inv.tax_rate === null || inv.tax_rate === undefined ? null
      : { label: inv.tax_label || 'Tax', rate_percent: inv.tax_rate, amount: money(inv.tax_cents, inv.currency) },
    terms: inv.terms, notes: inv.notes,
    pay_online_url: inv.pay_url,
    pdf_url: pdfUrl(userId, inv.id),
    payments: payments ? payments.map((p) => ({ id: p.id, date: p.paid_on, amount: money(p.amount_cents, inv.currency), method: p.method, note: p.note })) : undefined,
  };
}

// Lines in: [{description, detail?, qty|guests, price|price_per_guest}] + delivery fee.
function toItems(args) {
  const lines = Array.isArray(args.items) ? args.items : [];
  if (lines.length > 100) throw new ToolError('Too many lines (max 100)');
  const out = lines.map((it, i) => {
    if (!it || typeof it !== 'object') throw new ToolError(`items[${i}] must be an object`);
    const qty = it.guests !== undefined ? it.guests : it.qty;
    const price = it.price_per_guest !== undefined ? it.price_per_guest : it.price;
    if (price === undefined || price === null || price === '') throw new ToolError(`items[${i}].price is required`);
    if (core.toCents(price) === null) throw new ToolError(`items[${i}].price "${price}" is not a number`);
    return { description: String(it.description || '').trim(), detail: it.detail, qty: qty === undefined ? 1 : qty, price };
  });
  if (args.delivery !== undefined && args.delivery !== null && args.delivery !== '' && core.toCents(args.delivery) !== 0) {
    if (core.toCents(args.delivery) === null) throw new ToolError(`delivery "${args.delivery}" is not a number`);
    out.push({ description: args.delivery_label ? String(args.delivery_label) : 'Delivery', qty: 1, price: args.delivery });
  }
  return out;
}

const dateProp = (d) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: d });
// One JSON type per field: some MCP clients (ChatGPT, Gemini) reject type unions.
// run() still accepts "45.50" strings, which models sometimes send anyway.
const amountProp = (d) => ({ type: 'number', description: d });
const lineSchema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'What is sold, e.g. "Buffet menu, Saturday 22 Nov"' },
    detail: { type: 'string', description: 'Optional second line under the description' },
    guests: { type: 'number', description: 'Number of guests (same as qty)' },
    qty: { type: 'number', description: 'Quantity; default 1' },
    price_per_guest: amountProp('Price per guest (same as price), before tax'),
    price: amountProp('Unit price before tax, e.g. 45 or "45.50"'),
  },
};

const TOOLS = [
  {
    name: 'list_invoice_templates',
    title: 'List invoice templates',
    description: 'Invoice templates of this Finman account: seller block, currency, tax rate, payment terms and the number the next invoice will get. Use the id as template_id in create_invoice.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(userId) {
      const list = await svc.listProfiles(userId);
      const out = [];
      for (const p of list) {
        const d = p.data || {};
        out.push({
          id: p.id, name: p.name, is_default: !!p.is_default, currency: p.currency,
          seller: d.seller && d.seller.name ? d.seller.name : undefined,
          tax: d.tax && d.tax.rate !== undefined && d.tax.rate !== null && d.tax.rate !== '' ? { label: d.tax.label || 'Tax', rate_percent: Number(d.tax.rate) } : null,
          due_days: p.due_days,
          next_number: await svc.nextNumber(userId, p.id, core.today()),
          pay_online: !!(d.pay_online && d.pay_online.url),
        });
      }
      return { templates: out };
    },
  },
  {
    name: 'create_invoice',
    title: 'Create invoice',
    description: 'Creates an invoice from a template. The invoice number is assigned automatically from the template counter. Tax comes from the template. Lines: description, guests (or qty) and price per guest; a delivery fee becomes its own line. Saved as a draft unless status "sent" is given. Returns the invoice with a PDF link.',
    inputSchema: {
      type: 'object',
      required: ['client_name', 'items'],
      properties: {
        template_id: { type: 'integer', description: 'Template id from list_invoice_templates; default template when omitted' },
        client_name: { type: 'string', description: 'Bill to: client or company name' },
        client_details: { type: 'string', description: 'Client address, email, phone — one per line' },
        items: { type: 'array', minItems: 1, items: lineSchema },
        delivery: amountProp('Delivery fee before tax (optional)'),
        delivery_label: { type: 'string', description: 'Label for the delivery line, default "Delivery"' },
        issue_date: dateProp('Invoice date YYYY-MM-DD, default today'),
        due_date: dateProp('Due date YYYY-MM-DD, default from the template payment terms'),
        notes: { type: 'string', description: 'Note printed on the invoice, e.g. event date and venue' },
        status: { type: 'string', enum: ['draft', 'sent'], description: 'draft (default) or sent' },
      },
    },
    async run(userId, a) {
      if (!a.client_name || !String(a.client_name).trim()) throw new ToolError('client_name is required');
      const items = toItems(a);
      if (!items.length) throw new ToolError('At least one line is required');
      const body = {
        profile_id: a.template_id, client_name: a.client_name, client_details: a.client_details,
        items, issue_date: a.issue_date, due_date: a.due_date, notes: a.notes,
        number: '', // always the template counter
      };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      let inv = await svc.createInvoice(userId, body);
      if (a.status === 'sent') inv = await svc.setStatus(userId, inv.id, 'sent');
      return { invoice: full(userId, inv, []) };
    },
  },
  {
    name: 'list_invoices',
    title: 'List or search invoices',
    description: 'Invoices of this account, newest first, with totals, paid and balance due. Filter by status and search by number or client name.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'sent', 'paid', 'void'] },
        search: { type: 'string', description: 'Part of the invoice number or client name' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(userId, a) {
      const r = await svc.listInvoices(userId, { status: a.status, q: a.search });
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 50, 1), 200);
      const totals = {};
      for (const [cur, t] of Object.entries(r.totals)) totals[cur] = { outstanding: money(t.outstanding_cents, cur), paid: money(t.paid_cents, cur) };
      return { count: r.invoices.length, invoices: r.invoices.slice(0, limit).map(brief), totals_all_invoices: totals };
    },
  },
  {
    name: 'get_invoice',
    title: 'Get invoice',
    description: 'One invoice with lines, tax, totals, payments and a PDF link. Give invoice_id or the invoice number.',
    inputSchema: { type: 'object', properties: { invoice_id: { type: 'integer' }, number: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    async run(userId, a) {
      const inv = await findInvoice(userId, a);
      return { invoice: full(userId, inv, await svc.listPayments(userId, inv.id)) };
    },
  },
  {
    name: 'get_invoice_pdf',
    title: 'Invoice PDF link',
    description: 'A link to the invoice PDF that opens without signing in, valid for 7 days. Give invoice_id or the invoice number.',
    inputSchema: { type: 'object', properties: { invoice_id: { type: 'integer' }, number: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    async run(userId, a) {
      const inv = await findInvoice(userId, a);
      return { number: inv.number, pdf_url: pdfUrl(userId, inv.id), valid_days: 7 };
    },
  },
  {
    name: 'record_payment',
    title: 'Record payment',
    description: 'Records money received for an invoice: the full balance, an amount, or a percent of the total (e.g. a 30% deposit). The invoice becomes paid when payments cover the total.',
    inputSchema: {
      type: 'object',
      required: ['invoice_id'],
      properties: {
        invoice_id: { type: 'integer' },
        amount: amountProp('Amount received; omit together with percent to record the whole balance'),
        percent: { type: 'number', minimum: 0, maximum: 100, description: 'Percent of the invoice total, e.g. 30' },
        paid_on: dateProp('Date received YYYY-MM-DD, default today'),
        method: { type: 'string', description: 'e.g. e-Transfer, card, cash' },
        note: { type: 'string' },
      },
    },
    async run(userId, a) {
      if (a.amount !== undefined && a.percent !== undefined) throw new ToolError('Give amount or percent, not both');
      const r = await svc.recordPayment(userId, id(a.invoice_id), { amount: a.amount, percent: a.percent, paid_on: a.paid_on, method: a.method, note: a.note });
      return { invoice: full(userId, r.invoice, r.payments) };
    },
  },
  {
    name: 'set_invoice_status',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    title: 'Mark invoice sent or void',
    description: 'Marks an invoice as sent (given to the client) or void (cancelled), or back to draft. Payments are recorded with record_payment.',
    inputSchema: { type: 'object', required: ['invoice_id', 'status'], properties: { invoice_id: { type: 'integer' }, status: { type: 'string', enum: ['draft', 'sent', 'void'] } } },
    async run(userId, a) {
      if (!['draft', 'sent', 'void'].includes(a.status)) throw new ToolError('status must be draft, sent or void');
      const inv = await svc.setStatus(userId, id(a.invoice_id), a.status);
      return { invoice: brief(inv) };
    },
  },
  {
    name: 'delete_draft_invoice',
    title: 'Delete draft invoice',
    description: 'Deletes an invoice that is still a draft. Sent, paid and void invoices stay; void a sent one instead.',
    inputSchema: { type: 'object', required: ['invoice_id'], properties: { invoice_id: { type: 'integer' } } },
    annotations: { destructiveHint: true, idempotentHint: true },
    async run(userId, a) {
      const inv = await svc.getInvoice(userId, id(a.invoice_id));
      if (inv.status !== 'draft') throw new ToolError(`Invoice ${inv.number} is ${inv.status}; only drafts can be deleted`);
      if (inv.paid_cents > 0) throw new ToolError(`Invoice ${inv.number} has payments recorded; it cannot be deleted`);
      await svc.deleteInvoice(userId, inv.id);
      return { deleted: true, number: inv.number };
    },
  },
  {
    name: 'list_clients',
    title: 'List clients',
    description: 'Clients billed from this account (from the invoices so far) with their details, number of invoices, billed totals and last invoice.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Part of the client name or details' } } },
    annotations: { readOnlyHint: true },
    async run(userId, a) {
      const list = await svc.listClients(userId, { q: a.search });
      return {
        clients: list.map((c) => ({
          name: c.client_name, details: c.client_details, invoices: c.invoices,
          billed: Object.entries(c.billed_cents).map(([cur, cents]) => money(cents, cur)),
          last_invoice: c.last_invoice,
        })),
      };
    },
  },
];

async function findInvoice(userId, a) {
  if (a.invoice_id !== undefined && a.invoice_id !== null && a.invoice_id !== '') return svc.getInvoice(userId, id(a.invoice_id));
  const num = String(a.number || '').trim();
  if (!num) throw new ToolError('Give invoice_id or number');
  const r = await svc.listInvoices(userId, { q: num });
  const hit = r.invoices.find((i) => i.number === num) || (r.invoices.length === 1 ? r.invoices[0] : null);
  if (!hit) throw new ToolError(`Invoice ${num} not found`);
  return svc.getInvoice(userId, hit.id);
}

TOOLS.push(...TX_TOOLS);
// Write tools say so explicitly: hosts treat a missing readOnlyHint as "may change data".
for (const t of TOOLS) {
  if (!t.annotations) t.annotations = { readOnlyHint: false, destructiveHint: false };
  else if (t.annotations.readOnlyHint === undefined) t.annotations = { readOnlyHint: false, ...t.annotations };
}
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function listTools() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema, ...(annotations ? { annotations: { title, ...annotations } } : {}),
  }));
}

// For the in-app assistant: does this tool change data (and so needs the person's OK)?
function isReadOnly(name) {
  const t = BY_NAME.get(name);
  return !!(t && t.annotations && t.annotations.readOnlyHint === true);
}

// -> MCP CallToolResult. Problems the model can fix come back as isError results.
async function callTool(userId, name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return null;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  delete a.number_override; delete a.invoice_number;
  try {
    const data = await tool.run(userId, a);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false };
  } catch (e) {
    if (e instanceof ToolError || e instanceof TxToolError || e instanceof svc.InvoiceError) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    throw e;
  }
}

module.exports = { listTools, callTool, isReadOnly, checkPdfLink, pdfUrl, ToolError };
