// lib/txFilter.js — single source of truth for what counts as "cash flow".
//
// The transactions table holds more than income/expense rows:
//   - type='transfer'  : the two legs of a transfer between own accounts;
//   - type='opening'   : the opening balance written when an account is created
//                        (models/account.js createWithOpeningBalance).
// Neither is income nor expense. Counting them breaks every aggregate:
// "+658 % vs last month", forecast "+116.8 % in 30 days", an expense category
// called "Opening balance" in the donut chart.
//
// Rules:
//   - The stable marker for an opening balance is transactions.type = OPENING_TYPE.
//     Every SQL aggregate filters type IN ('income','expense'), so opening rows
//     are excluded by construction.
//   - OPENING_CATEGORIES is a safety net for legacy rows written before the
//     explicit type existed (type='income' with category "Начальный баланс").
//   - Account balances still include the opening row: SUM(amount) per account
//     equals accounts.balance (reconcile, Beancount export).

const OPENING_TYPE = 'opening';
const OPENING_CATEGORY = 'Opening balance';
const OPENING_DESCRIPTION = 'Opening balance';

// Legacy spellings (pre-wave3 data) that must never show up as income/expense.
const OPENING_CATEGORIES = [
  OPENING_CATEGORY,
  'Opening Balance',
  'Начальный баланс',
  'Початковий баланс',
];

const CASHFLOW_TYPES = ['income', 'expense'];

// Returns { sql, params } — a WHERE fragment (starts with AND).
// alias — table prefix ('t' -> 't.type'); none by default.
function cashflowOnly(alias) {
  const p = alias ? `${alias}.` : '';
  const placeholders = OPENING_CATEGORIES.map(() => '?').join(', ');
  return {
    sql: ` AND ${p}type IN ('income', 'expense') AND COALESCE(${p}category, '') NOT IN (${placeholders})`,
    params: [...OPENING_CATEGORIES],
  };
}

// JS-side predicates for code paths that aggregate rows after SELECT *.
function isOpening(row) {
  if (!row) return false;
  if (row.type === OPENING_TYPE) return true;
  const cat = String(row.category || '').trim();
  return cat !== '' && OPENING_CATEGORIES.includes(cat);
}

function isCashflow(row) {
  if (!row) return false;
  if (!CASHFLOW_TYPES.includes(row.type)) return false;
  return !isOpening(row);
}

module.exports = {
  OPENING_TYPE,
  OPENING_CATEGORY,
  OPENING_DESCRIPTION,
  OPENING_CATEGORIES,
  CASHFLOW_TYPES,
  cashflowOnly,
  isOpening,
  isCashflow,
};
