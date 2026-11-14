// services/mcp/txTools.js — accounts and transactions for MCP clients and the in-app assistant.
//
// Same rules as routes/transactions.js: income/expense only (transfers and opening
// balances have their own paths), the sign follows the type, a transaction on a shared
// account belongs to the account owner's ledger and needs can_add_transactions.
// Reads are scoped by user_id; edits and deletes touch only the user's own ledger.
'use strict';

const { get, query } = require('../../db/database');
const Transaction = require('../../models/transaction');
const { AccountPermission } = require('../../models/permission');
const dates = require('../../lib/dates');
const { cashflowOnly } = require('../../lib/txFilter');

class TxToolError extends Error {}

const dateProp = (d) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: d });
const posId = (v, name) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new TxToolError(`${name} must be a positive number`);
  return n;
};
const optDate = (v, name) => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).slice(0, 10);
  if (!dates.isValidYMD(s)) throw new TxToolError(`${name} must be YYYY-MM-DD`);
  return s;
};
const num = (v, name) => {
  const n = typeof v === 'string' ? Number(v.replace(/[\s,]/g, '')) : Number(v);
  if (v === null || v === '' || v === undefined || !Number.isFinite(n)) throw new TxToolError(`${name} must be a number`);
  return n;
};
// «Сегодня» — по часовому поясу человека (users.timezone), как в остальном Finman.
async function today(userId) {
  const u = await get('SELECT timezone FROM users WHERE id = ?', [userId]);
  return dates.todayISO(dates.userTz(u));
}
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const clip = (s, n) => (s === undefined || s === null ? undefined : String(s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n));

function txOut(t) {
  return {
    id: t.id, date: t.date, description: t.description, category: t.category,
    type: t.type, amount: r2(t.amount), currency: t.currency || undefined,
    account_id: t.account_id, account: t.account_name || undefined,
    transfer: t.transfer_id ? true : undefined,
  };
}

async function monthBounds(userId) {
  const end = await today(userId);
  return { start: `${end.slice(0, 7)}-01`, end };
}

const TX_TOOLS = [
  {
    name: 'list_accounts',
    title: 'List accounts',
    description: 'Accounts of this Finman account (own and shared with me): id, name, type, currency and current balance. Use the id as account_id for transactions.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(userId) {
      const acc = await AccountPermission.getAccessibleAccounts(userId);
      return {
        accounts: acc.all.map((a) => ({
          id: a.id, name: a.name, type: a.type, currency: a.currency, balance: r2(a.balance || 0),
          shared_by: a.is_owner ? undefined : (a.owner_username || 'another user'),
          can_add_transactions: !!a.can_add_transactions,
        })),
      };
    },
  },
  {
    name: 'list_transactions',
    title: 'List or search transactions',
    description: 'Transactions of this account, newest first. Filter by account, dates, type, category, amount range, or search in description and category. Amounts are signed: expenses negative, income positive, in the account currency.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'integer' },
        start_date: dateProp('From date YYYY-MM-DD (inclusive)'),
        end_date: dateProp('To date YYYY-MM-DD (inclusive)'),
        type: { type: 'string', enum: ['income', 'expense', 'transfer'] },
        category: { type: 'string', description: 'Exact category name, see list_categories' },
        search: { type: 'string', description: 'Part of the description or category' },
        min_amount: { type: 'number', description: 'Minimum absolute amount' },
        max_amount: { type: 'number', description: 'Maximum absolute amount' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
        page: { type: 'integer', minimum: 1, description: 'Page number, default 1' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(userId, a) {
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 50, 1), 200);
      const page = Math.max(parseInt(a.page, 10) || 1, 1);
      let sql = `SELECT t.*, a.name AS account_name, a.currency AS currency
        FROM transactions t JOIN accounts a ON t.account_id = a.id WHERE t.user_id = ?`;
      const params = [userId];
      const add = (cond, ...v) => { sql += ` AND ${cond}`; params.push(...v); };
      if (a.account_id) add('t.account_id = ?', posId(a.account_id, 'account_id'));
      const sd = optDate(a.start_date, 'start_date'); if (sd) add('t.date >= ?', sd);
      const ed = optDate(a.end_date, 'end_date'); if (ed) add('t.date <= ?', ed);
      if (a.type) {
        if (!['income', 'expense', 'transfer'].includes(a.type)) throw new TxToolError('type must be income, expense or transfer');
        add('t.type = ?', a.type);
      }
      if (clip(a.category, 100)) add('t.category = ?', clip(a.category, 100));
      if (clip(a.search, 100)) { const q = `%${clip(a.search, 100)}%`; add('(t.description LIKE ? OR t.category LIKE ?)', q, q); }
      if (a.min_amount !== undefined && a.min_amount !== null && a.min_amount !== '') add('ABS(t.amount) >= ?', Math.abs(num(a.min_amount, 'min_amount')));
      if (a.max_amount !== undefined && a.max_amount !== null && a.max_amount !== '') add('ABS(t.amount) <= ?', Math.abs(num(a.max_amount, 'max_amount')));
      sql += ' ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?';
      params.push(limit, (page - 1) * limit);
      const rows = await query(sql, params);
      return { count: rows.length, page, transactions: rows.map(txOut), more: rows.length === limit ? `page ${page + 1}` : undefined };
    },
  },
  {
    name: 'get_spending_summary',
    title: 'Income and spending summary',
    description: 'Income and expenses for a period, by category or by month, converted to the base currency of the account. Transfers between own accounts and opening balances are left out. Default period: this month.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: dateProp('From YYYY-MM-DD, default first day of this month'),
        end_date: dateProp('To YYYY-MM-DD, default today'),
        group_by: { type: 'string', enum: ['category', 'month'], description: 'Default category' },
        account_id: { type: 'integer' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(userId, a) {
      const def = await monthBounds(userId);
      const start = optDate(a.start_date, 'start_date') || def.start;
      const end = optDate(a.end_date, 'end_date') || def.end;
      const groupBy = a.group_by === 'month' ? 'month' : 'category';
      const stats = await Transaction.getStats(userId, { startDate: start, endDate: end, groupBy, accountId: a.account_id ? posId(a.account_id, 'account_id') : undefined });
      const currency = stats[0] ? stats[0].currency : undefined;
      if (groupBy === 'category') {
        let income = 0; let expense = 0;
        const rows = stats.map((s) => {
          if (s.type === 'income') income += Number(s.total_amount); else if (s.type === 'expense') expense += Number(s.total_amount);
          return { category: s.category, type: s.type, total: r2(s.total_amount), count: s.count };
        });
        return { start_date: start, end_date: end, currency, income: r2(income), expenses: r2(expense), net: r2(income - expense), by_category: rows };
      }
      const months = new Map();
      for (const s of stats) {
        const m = months.get(s.period) || { month: s.period, income: 0, expenses: 0 };
        m.income += Number(s.income || 0); m.expenses += Number(s.expense || 0);
        months.set(s.period, m);
      }
      return {
        start_date: start, end_date: end, currency,
        by_month: [...months.values()].map((m) => ({ month: m.month, income: r2(m.income), expenses: r2(m.expenses), net: r2(m.income - m.expenses) })),
      };
    },
  },
  {
    name: 'list_categories',
    title: 'List categories',
    description: 'Categories already used in this account, with the number of transactions and type. Reuse these names when adding transactions.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(userId) {
      const CFT = cashflowOnly('t');
      const rows = await query(
        `SELECT t.category AS name, t.type AS type, COUNT(*) AS n FROM transactions t WHERE t.user_id = ?${CFT.sql}
         GROUP BY t.category, t.type ORDER BY n DESC LIMIT 200`,
        [userId, ...CFT.params],
      );
      return { categories: rows.map((r) => ({ name: r.name, type: r.type, transactions: r.n })) };
    },
  },
  {
    name: 'add_transaction',
    title: 'Add transaction',
    description: 'Adds an income or expense to an account. Give the amount as a positive number; the type decides the sign. Date defaults to today, category to "Other". Use list_accounts for account_id and list_categories for category names.',
    inputSchema: {
      type: 'object',
      required: ['account_id', 'amount', 'type'],
      properties: {
        account_id: { type: 'integer' },
        amount: { type: 'number', description: 'Positive amount in the account currency, e.g. 42.5' },
        type: { type: 'string', enum: ['income', 'expense'] },
        date: dateProp('Date YYYY-MM-DD, default today'),
        description: { type: 'string', description: 'e.g. "Groceries, Metro"' },
        category: { type: 'string', description: 'Category name, default "Other"' },
        client_tx_id: { type: 'string', description: 'Optional idempotency key: the same key never adds twice' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async run(userId, a) {
      const accountId = posId(a.account_id, 'account_id');
      if (!['income', 'expense'].includes(a.type)) throw new TxToolError('type must be income or expense');
      const amount = Math.abs(num(a.amount, 'amount'));
      if (amount === 0) throw new TxToolError('amount must not be zero');
      if (amount > 1e12) throw new TxToolError('amount is too large');
      const date = optDate(a.date, 'date') || (await today(userId));
      const perm = await AccountPermission.getPermissions(accountId, userId);
      if (!perm || !(perm.isOwner || perm.canView)) throw new TxToolError(`Account ${accountId} not found; see list_accounts`);
      if (!perm.isOwner && !perm.canAddTransactions) throw new TxToolError('No permission to add transactions to this shared account');
      const acc = await get('SELECT user_id, name, currency FROM accounts WHERE id = ?', [accountId]);
      const key = clip(a.client_tx_id, 100) || null;
      if (key) {
        const ex = await get('SELECT * FROM transactions WHERE user_id = ? AND client_tx_id = ?', [acc.user_id, key]);
        if (ex) return { transaction: txOut({ ...ex, account_name: acc.name, currency: acc.currency }), already_added: true };
      }
      const t = await Transaction.create({
        accountId, userId: acc.user_id, date, amount, type: a.type,
        description: clip(a.description, 500) || '', category: clip(a.category, 100) || 'Other', clientTxId: key,
      });
      return { transaction: txOut({ id: t.id, date, description: t.description, category: t.category, type: t.type, amount: t.amount, account_id: accountId, account_name: acc.name, currency: acc.currency }) };
    },
  },
  {
    name: 'update_transaction',
    title: 'Edit transaction',
    description: 'Changes the date, description, category, amount or type of one transaction. Only the fields given change. For a transfer both legs change together; its type stays.',
    inputSchema: {
      type: 'object',
      required: ['transaction_id'],
      properties: {
        transaction_id: { type: 'integer' },
        date: dateProp('New date YYYY-MM-DD'),
        description: { type: 'string' },
        category: { type: 'string' },
        amount: { type: 'number', description: 'New positive amount' },
        type: { type: 'string', enum: ['income', 'expense'] },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(userId, a) {
      const id = posId(a.transaction_id, 'transaction_id');
      const cur = await Transaction.findById(id, userId);
      if (!cur) throw new TxToolError(`Transaction ${id} not found`);
      const data = {};
      if (a.date !== undefined) data.date = optDate(a.date, 'date');
      if (a.description !== undefined) data.description = clip(a.description, 500);
      if (a.category !== undefined && clip(a.category, 100)) data.category = clip(a.category, 100);
      if (a.amount !== undefined) {
        const n = Math.abs(num(a.amount, 'amount'));
        if (n === 0) throw new TxToolError('amount must not be zero');
        data.amount = n;
      }
      if (a.type !== undefined) {
        if (!['income', 'expense'].includes(a.type)) throw new TxToolError('type must be income or expense');
        if (cur.transfer_id || cur.type === 'opening') throw new TxToolError('The type of a transfer or opening balance cannot be changed');
        data.type = a.type;
      }
      if (!Object.keys(data).length) throw new TxToolError('Nothing to change');
      try {
        await Transaction.update(id, userId, data);
      } catch (e) {
        if (e && e.name === 'AppError') throw new TxToolError(e.message);
        throw e;
      }
      return { transaction: txOut(await Transaction.findById(id, userId)) };
    },
  },
  {
    name: 'delete_transaction',
    title: 'Delete transaction',
    description: 'Deletes one transaction and corrects the account balance. Deleting a transfer leg deletes both legs.',
    inputSchema: { type: 'object', required: ['transaction_id'], properties: { transaction_id: { type: 'integer' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(userId, a) {
      const id = posId(a.transaction_id, 'transaction_id');
      const cur = await Transaction.findById(id, userId);
      if (!cur) throw new TxToolError(`Transaction ${id} not found`);
      await Transaction.delete(id, userId);
      return { deleted: true, transaction: txOut(cur) };
    },
  },
];

module.exports = { TX_TOOLS, TxToolError };
