// services/ledgerExport.js — anti-lock-in Beancount/Ledger export.
//
// Beancount (https://beancount.github.io) is a plain-text, double-entry
// accounting format consumed by Beancount/Fava and many other tools. Giving
// users a clean Beancount dump of their finman data means their books are
// never trapped inside finman — they can move to Fava, ledger-cli, hledger,
// or any text editor.
//
// toBeancount(userId) produces a valid Beancount document:
//   - a header with operating currencies + an `open` directive per account
//     (Assets:<Account> <CCY>) AND per category leg (Expenses/Income:<Cat>);
//   - one balanced transaction per finman transaction, with a posting PAIR:
//       expense -> Assets:<Account> -amount / Expenses:<Category> +amount
//       income  -> Assets:<Account> +amount / Income:<Category>  -amount
//     Each posting line carries an explicit amount + currency, so every
//     transaction sums to exactly zero (Beancount's balance requirement).
//
// All money math goes through lib/money (2dp, float-safe). The export is
// read-only: it never mutates the DB.

const { query } = require('../db/database');
const money = require('../lib/money');

const DEFAULT_CURRENCY = 'UAH';

// ----- Beancount name/string helpers -------------------------------------

// A Beancount account is colon-separated components; each component must start
// with an uppercase letter or a digit and otherwise contain only letters,
// digits or dashes. We sanitise arbitrary user text into one safe component.
function accountComponent(raw, fallback) {
  const original = String(raw == null ? '' : raw).trim();
  // Replace any run of disallowed chars with a single dash.
  let s = original.replace(/[^A-Za-z0-9]+/g, '-');
  // Collapse leading/trailing dashes.
  s = s.replace(/^-+/, '').replace(/-+$/, '');
  if (!s) {
    // Sanitisation wiped everything (e.g. all-Cyrillic name). Fall back, but
    // keep distinct inputs distinct with a short stable suffix so two unlike
    // non-ASCII names don't collapse into one Beancount account.
    s = String(fallback || 'Unknown');
    if (original) s += '-' + shortHash(original);
  }
  // Component must start with an uppercase letter or a digit.
  if (!/^[A-Z0-9]/.test(s)) {
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  if (!/^[A-Z0-9]/.test(s)) {
    s = 'X-' + s;
  }
  return s;
}

// Tiny deterministic alphanumeric hash (DJB2) for disambiguating components.
function shortHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// A currency in Beancount is 1..24 chars: uppercase letters, digits and a few
// punctuation marks, must start with a capital letter. Fall back to default.
function normalizeCurrency(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (/^[A-Z][A-Z0-9'._-]{0,23}$/.test(s)) return s;
  return DEFAULT_CURRENCY;
}

// Beancount strings are double-quoted; escape backslashes and quotes.
function bcString(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

// Normalise a date to YYYY-MM-DD (Beancount directive date form).
function normalizeDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // Last resort: a deterministic epoch date so the file stays parseable.
  return '1970-01-01';
}

// Format a money amount with a fixed 2 decimals + currency, e.g. "12.50 UAH".
function amountStr(value, currency) {
  return `${money.round(value).toFixed(2)} ${currency}`;
}

// ----- Account/category name builders ------------------------------------

function assetAccount(account) {
  const comp = accountComponent(
    account && (account.name || account.bank_name),
    `Account${account ? account.id : ''}`
  );
  return `Assets:${comp}`;
}

function categoryAccount(type, category) {
  const root = type === 'income' ? 'Income' : 'Expenses';
  const comp = accountComponent(category, 'Uncategorized');
  return `${root}:${comp}`;
}

// ----- Main export --------------------------------------------------------

/**
 * Build a Beancount plain-text document for a user's accounts + transactions.
 * @param {number} userId
 * @returns {Promise<string>} valid Beancount text
 */
async function toBeancount(userId) {
  const accounts = await query(
    `SELECT id, name, bank_name, currency, balance, account_type, created_at
       FROM accounts
      WHERE user_id = ?
      ORDER BY id ASC`,
    [userId]
  );

  const transactions = await query(
    `SELECT t.id, t.account_id, t.date, t.description, t.category, t.amount,
            t.type, a.name AS account_name, a.bank_name AS account_bank,
            a.currency AS account_currency
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ?
      ORDER BY t.date ASC, t.id ASC`,
    [userId]
  );

  const lines = [];
  const generatedAt = new Date().toISOString();

  // --- Header -------------------------------------------------------------
  lines.push(';; Beancount export from finman');
  lines.push(`;; Generated: ${generatedAt}`);
  lines.push(`;; Accounts: ${accounts.length}  Transactions: ${transactions.length}`);
  lines.push('');

  // Operating currencies option (deduped, in stable order).
  const currencies = [];
  const seenCur = new Set();
  for (const a of accounts) {
    const c = normalizeCurrency(a.currency);
    if (!seenCur.has(c)) {
      seenCur.add(c);
      currencies.push(c);
    }
  }
  if (!currencies.length) {
    currencies.push(DEFAULT_CURRENCY);
  }
  for (const c of currencies) {
    lines.push(`option "operating_currency" "${c}"`);
  }
  lines.push('');

  // --- Open directives ----------------------------------------------------
  // Track what we've opened so each account/leg is opened exactly once and
  // before its first use (Beancount rejects postings to unopened accounts).
  const openedAccounts = new Set();
  const openDirectives = [];

  // Earliest sensible open date: account.created_at, else earliest tx date,
  // else today. We keep it simple and deterministic per account.
  function openDate(account) {
    return normalizeDate(account && account.created_at) || generatedAt.slice(0, 10);
  }

  // Asset accounts (one per finman account).
  const accountById = new Map();
  for (const a of accounts) {
    accountById.set(a.id, a);
    const acctName = assetAccount(a);
    if (!openedAccounts.has(acctName)) {
      openedAccounts.add(acctName);
      const ccy = normalizeCurrency(a.currency);
      openDirectives.push(`${openDate(a)} open ${acctName} ${ccy}`);
    }
  }

  // Category legs (Expenses:* / Income:*) — opened at epoch so they always
  // precede any transaction. We open them currency-agnostic (no constraint).
  const categoryLegs = new Set();
  for (const t of transactions) {
    categoryLegs.add(categoryAccount(t.type, t.category));
  }
  // Also make sure every asset account referenced by a tx is opened even if
  // the account row itself was missing (orphan tx -> synthetic account).
  for (const t of transactions) {
    if (!accountById.has(t.account_id)) {
      const synthetic = {
        id: t.account_id,
        name: t.account_name,
        bank_name: t.account_bank,
        currency: t.account_currency,
      };
      const acctName = assetAccount(synthetic);
      if (!openedAccounts.has(acctName)) {
        openedAccounts.add(acctName);
        const ccy = normalizeCurrency(t.account_currency);
        openDirectives.push(`1970-01-01 open ${acctName} ${ccy}`);
      }
      accountById.set(t.account_id, synthetic);
    }
  }

  for (const leg of Array.from(categoryLegs).sort()) {
    openDirectives.push(`1970-01-01 open ${leg}`);
  }

  // Emit open directives sorted by date then text for a stable, valid file.
  openDirectives.sort();
  for (const d of openDirectives) lines.push(d);
  lines.push('');

  // --- Transactions -------------------------------------------------------
  for (const t of transactions) {
    const account = accountById.get(t.account_id) || {
      id: t.account_id,
      name: t.account_name,
      bank_name: t.account_bank,
      currency: t.account_currency,
    };
    const ccy = normalizeCurrency(account.currency || t.account_currency);
    const asset = assetAccount(account);
    const catLeg = categoryAccount(t.type, t.category);
    const date = normalizeDate(t.date);
    const narration = bcString(t.description || t.category || 'Transaction');

    // Amount magnitude (always positive in source); sign by leg below.
    const mag = money.round(Math.abs(Number(t.amount) || 0));

    // Header line: flag '*' (cleared) + narration string.
    lines.push(`${date} * "${narration}"`);

    if (t.type === 'income') {
      // Asset increases; Income leg is negative (credit) -> sums to zero.
      lines.push(`  ${asset}  ${amountStr(mag, ccy)}`);
      lines.push(`  ${catLeg}  ${amountStr(-mag, ccy)}`);
    } else {
      // Expense: asset decreases; Expenses leg positive -> sums to zero.
      lines.push(`  ${asset}  ${amountStr(-mag, ccy)}`);
      lines.push(`  ${catLeg}  ${amountStr(mag, ccy)}`);
    }
    lines.push('');
  }

  // Ensure a trailing newline.
  return lines.join('\n').replace(/\n*$/, '\n');
}

module.exports = {
  toBeancount,
  // Exposed for unit tests / reuse.
  _internal: {
    accountComponent,
    normalizeCurrency,
    bcString,
    normalizeDate,
    amountStr,
    assetAccount,
    categoryAccount,
  },
};
