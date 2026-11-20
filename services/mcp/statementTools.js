// services/mcp/statementTools.js — Statement Agent tools for MCP clients and the in-app assistant.
//
// list_statements / get_statement read what the agent found. import_statement writes, so the
// in-app assistant shows it as a Confirm card and MCP hosts ask before calling it. It imports
// only when the balance proof holds: opening + rows = closing to the cent. An outside AI (ChatGPT,
// Claude…) that read a statement itself can pass the rows; Finman proves them the same way and
// refuses to write when they do not balance.
'use strict';

const svc = require('../statement/service');
const { fmt } = require('../statement/proof');

class StatementToolError extends Error {}

const money = (c, cur) => (c === null || c === undefined ? null : `${fmt(c)}${cur ? ` ${cur}` : ''}`);

function brief(v) {
  return {
    statement_id: v.id, file: v.file_name, status: v.status, check: v.proof && v.proof.line,
    institution: v.institution, account_last4: v.account_last4, currency: v.currency, period: v.period,
    opening: money(v.opening_cents, v.currency), closing: money(v.closing_cents, v.currency),
    rows: v.counts.rows, imported: v.committed ? { account_id: v.committed.account_id, inserted: v.committed.inserted, skipped: v.committed.skipped } : false,
  };
}

function planOut(p, cur) {
  if (!p) return null;
  return {
    note: `Estimate for the next 30 days from this statement (${p.basis_days} days of rows)`,
    income: money(p.income_30d_cents, cur), spending: money(p.spending_30d_cents, cur), net: money(p.net_30d_cents, cur),
    repeating_bills: p.bills.map((b) => ({ payee: b.payee, per_30_days: money(b.cents_30d, cur), times_on_statement: b.times })),
    top_categories: p.top_categories.map((c) => ({ category: c.category, per_30_days: money(c.cents_30d, cur), share_percent: c.share })),
    projected_balance: money(p.projected_balance_cents, cur),
    flexible_per_day: money(p.flexible_per_day_cents, cur),
  };
}

const rowSchema = {
  type: 'object',
  required: ['date', 'amount'],
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' },
    description: { type: 'string' },
    amount: { type: 'number', description: 'Signed, as printed from the holder\'s view: money out negative, money in positive' },
    balance: { type: 'number', description: 'Running balance printed on this row, if any' },
  },
};

const STATEMENT_TOOLS = [
  {
    name: 'list_statements',
    title: 'List read statements',
    description: 'Statements the Finman Statement Agent read from PDF or photo uploads, newest first, with the balance check result (proven or the gap) and whether they are imported.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(userId) {
      const rows = await svc.list(userId);
      return { statements: rows.map((r) => ({ statement_id: r.id, file: r.file_name, status: r.status, check: r.proof_line, currency: r.currency, period: r.period, imported: r.committed })) };
    },
  },
  {
    name: 'get_statement',
    title: 'Get statement',
    description: 'One statement the agent read: the balance check line, the gap and the first row where the running balance breaks (if any), the first 60 rows, and a 30-day estimate (income, spending, repeating bills, projected balance) when the check is proven.',
    inputSchema: { type: 'object', required: ['statement_id'], properties: { statement_id: { type: 'integer' } } },
    annotations: { readOnlyHint: true },
    async run(userId, a) {
      const v = await svc.view(userId, a.statement_id);
      const b = v.proof && v.proof.first_break;
      return {
        ...brief(v),
        first_break: b ? { row: b.index + 1, page: b.page, printed_balance: money(b.printed_balance_cents, v.currency), balance_from_rows: money(b.expected_balance_cents, v.currency) } : null,
        gap: money(v.proof && v.proof.gap_cents, v.currency),
        reads: v.attempts,
        rows_sample: v.rows.slice(0, 60).map((r) => ({ row: r.index + 1, date: r.date, description: r.description, amount: r.amount, page: r.page, unreadable: r.unclear || undefined, derived_from_balances: r.derived || undefined })),
        next_30_days: planOut(v.plan, v.currency),
      };
    },
  },
  {
    name: 'import_statement',
    title: 'Import statement',
    description: 'Imports a statement into an account, only if its balance check is proven (opening + rows = closing, to the cent); otherwise nothing is written and the gap is returned. Either pass statement_id (a PDF/photo the person uploaded to Finman), or pass the rows you read yourself with opening_balance and closing_balance as printed. Never change numbers to make a statement balance. Rows already in the account are skipped.',
    inputSchema: {
      type: 'object',
      required: ['account_id'],
      properties: {
        account_id: { type: 'integer', description: 'Target account (see list_accounts)' },
        statement_id: { type: 'integer', description: 'A statement from list_statements' },
        statement_type: { type: 'string', enum: ['bank', 'card'], description: 'card = credit card statement (balances are amounts owed)' },
        opening_balance: { type: 'number', description: 'As printed (previous balance on a card)' },
        closing_balance: { type: 'number', description: 'As printed (new balance on a card)' },
        currency: { type: 'string', description: 'ISO code, e.g. CAD' },
        rows: { type: 'array', maxItems: 2000, items: rowSchema },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(userId, a) {
      const accountId = parseInt(a.account_id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) throw new StatementToolError('account_id must be a positive number');
      let id = parseInt(a.statement_id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        if (!Array.isArray(a.rows) || !a.rows.length) throw new StatementToolError('Pass statement_id, or rows with opening_balance and closing_balance');
        id = await svc.createFromRows(userId, a);
      }
      const v = await svc.view(userId, id, { accountId });
      if (v.status !== 'proven') {
        throw new StatementToolError(`Nothing imported (statement_id ${id}): ${v.proof && v.proof.line}. Tell the person where the gap is; do not change numbers.`);
      }
      const out = await svc.commit(userId, id, { accountId });
      return { imported: true, statement_id: id, check: v.proof.line, account: out.account, inserted: out.inserted, skipped_as_already_there: out.skipped, new_balance: out.new_balance, next_30_days: planOut(v.plan, v.currency) };
    },
  },
];

module.exports = { STATEMENT_TOOLS, StatementToolError };
