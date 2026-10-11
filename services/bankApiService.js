// services/bankApiService.js — direct bank API access for `type: 'token'` banks.
//
// Only banks with a real, documented personal API live here. Today that is
// Monobank (https://api.monobank.ua/docs/): a read-only personal token sent in
// the X-Token header. Everything else in config/bank-api-config.js is
// `type: 'file-import'` and is handled by csvImportService / ofxImportService.
//
// Public surface (used by routes/bank-api.js and services/syncScheduler.js):
//   getAuthorizationUrl(bankId)            -> { url: null, state, directAuth: true }
//   verifyToken(bankId, token)             -> { ok, clientName?, accounts? }
//   ensureValidTokens(bankId, connection)  -> connection (tokens never expire)
//   revokeAccess(bankId, connection)       -> true (tokens are revoked in the bank app)
//   getAccounts(bankId, connection)        -> [{ id, name, accountNumber, type, balance, currency }]
//   getTransactions(bankId, connection, accountNumber, { startDate, endDate })
//                                          -> [{ id, date, description, category, amount, type }]

const axios = require('axios');
const crypto = require('crypto');
const bankApiConfig = require('../config/bank-api-config');
const money = require('../lib/money');
const { categorizeByMcc, categorizeByDescription } = require('./importCategorizer');

const HTTP_TIMEOUT_MS = 15000;

function getBankConfig(bankId) {
  return bankApiConfig.isBank(bankId) ? bankApiConfig[bankId] : null;
}

function assertTokenBank(bankId) {
  const cfg = getBankConfig(bankId);
  if (!cfg) throw new Error(`Bank "${bankId}" is not supported`);
  if (cfg.type !== 'token') {
    throw new Error(`${cfg.name} has no personal API. Import a CSV/OFX statement instead.`);
  }
  return cfg;
}

// Monobank works in Kyiv time: an operation at 00:30 Kyiv on the 10th is
// 21:30 UTC on the 9th, so calendar dates are taken in Europe/Kyiv.
const KYIV_TZ = 'Europe/Kyiv';
const kyivDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: KYIV_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const kyivPartsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: KYIV_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

// Unix seconds -> 'YYYY-MM-DD' in Kyiv.
function kyivDate(unixSeconds) {
  return kyivDateFmt.format(new Date(Number(unixSeconds) * 1000));
}

// Kyiv UTC offset (ms) at a given instant.
function kyivOffsetMs(ms) {
  const p = {};
  for (const part of kyivPartsFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// 'YYYY-MM-DD' -> unix seconds of 00:00 Kyiv on that day.
function kyivMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - kyivOffsetMs(guess);
  t = guess - kyivOffsetMs(t); // re-check across a DST switch
  return Math.floor(t / 1000);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// A range bound -> unix seconds. A bare 'YYYY-MM-DD' is a whole Kyiv day:
// the start bound is its first second, the end bound its last one.
function rangeBound(value, which) {
  if (value instanceof Date || typeof value === 'number') {
    const ms = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(ms)) throw new Error(`Invalid ${which} date`);
    return Math.floor(ms / 1000);
  }
  const s = String(value).trim();
  const m = s.match(ISO_DAY);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
      throw new Error(`Invalid ${which} date "${s}"`);
    }
    if (which === 'start') return kyivMidnight(y, mo, d);
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    return kyivMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) - 1;
  }
  const ms = Date.parse(s);
  if (!s || Number.isNaN(ms)) throw new Error(`Invalid ${which} date "${s}"`);
  return Math.floor(ms / 1000);
}

// ISO-4217 numeric -> alpha (Monobank returns numeric codes).
const CURRENCY_BY_NUMERIC = {
  980: 'UAH', 840: 'USD', 978: 'EUR', 826: 'GBP', 985: 'PLN', 203: 'CZK',
  756: 'CHF', 124: 'CAD', 392: 'JPY', 156: 'CNY', 949: 'TRY', 348: 'HUF',
  752: 'SEK', 578: 'NOK', 208: 'DKK', 643: 'RUB', 376: 'ILS', 784: 'AED',
  933: 'BYN', 498: 'MDL', 946: 'RON', 975: 'BGN', 981: 'GEL', 398: 'KZT',
  944: 'AZN', 51: 'AMD', 36: 'AUD', 554: 'NZD', 344: 'HKD', 702: 'SGD',
  410: 'KRW', 356: 'INR', 484: 'MXN', 986: 'BRL', 710: 'ZAR', 764: 'THB',
  860: 'UZS', 941: 'RSD'
};
// Unknown code -> null (never guess UAH: a USD card would be booked as hryvnia).
function currencyFromNumeric(code) {
  return CURRENCY_BY_NUMERIC[Number(code)] || null;
}

// Monobank card types -> app account types.
function mapMonoAccountType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'white' || t === 'eaid') return 'credit';
  if (t === 'fop') return 'checking';
  return 'checking'; // black, platinum, iron, yellow, madeInUkraine
}

function monoErrorMessage(error) {
  const status = error.response?.status;
  const desc = error.response?.data?.errorDescription;
  if (status === 403) return 'Monobank rejected the token (403). Check the token in the Monobank app.';
  if (status === 429) return 'Monobank rate limit: one statement request per account every 60 seconds.';
  if (desc) return `Monobank: ${desc}`;
  return error.message || 'Monobank request failed';
}

class BankApiService {
  // Token banks never redirect: the UI shows a token field.
  async getAuthorizationUrl(bankId) {
    assertTokenBank(bankId);
    return { url: null, state: crypto.randomBytes(16).toString('hex'), directAuth: true };
  }

  getAuthHeaders(bankId, connection) {
    if (bankId === 'monobank') return { 'X-Token': connection.access_token };
    return { Authorization: `Bearer ${connection.access_token}` };
  }

  // Personal tokens have no expiry/refresh; return the connection unchanged.
  async ensureValidTokens(bankId, connection) {
    assertTokenBank(bankId);
    return connection;
  }

  // Personal tokens are revoked by the user inside the bank app; nothing to call.
  async revokeAccess(bankId) {
    getBankConfig(bankId); // validates nothing else; keeps the call site simple
    return true;
  }

  // Check a token before storing it. Never throws: returns { ok:false, message }.
  async verifyToken(bankId, token) {
    const cfg = assertTokenBank(bankId);
    if (!token) return { ok: false, message: 'Token is empty' };
    if (bankId === 'monobank') {
      try {
        const res = await axios.get(`${cfg.apiUrl}${cfg.endpoints.clientInfo}`, {
          headers: { 'X-Token': token },
          timeout: HTTP_TIMEOUT_MS
        });
        return {
          ok: true,
          clientName: res.data?.name || null,
          accounts: Array.isArray(res.data?.accounts) ? res.data.accounts.length : 0
        };
      } catch (error) {
        return { ok: false, message: monoErrorMessage(error) };
      }
    }
    return { ok: false, message: 'Unsupported bank' };
  }

  async getAccounts(bankId, connection) {
    const cfg = assertTokenBank(bankId);
    const headers = this.getAuthHeaders(bankId, connection);

    if (bankId === 'monobank') {
      try {
        const res = await axios.get(`${cfg.apiUrl}${cfg.endpoints.clientInfo}`, { headers, timeout: HTTP_TIMEOUT_MS });
        const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
        const out = [];
        for (const acc of accounts) {
          const currency = currencyFromNumeric(acc.currencyCode);
          // An account in a currency we cannot name would be created in the
          // app's default currency; leave it out instead of mislabelling it.
          if (!currency) continue;
          const balanceMinor = Number(acc.balance) || 0;
          const limitMinor = Number(acc.creditLimit) || 0;
          out.push({
            id: acc.id,
            name: acc.maskedPan?.[0] ? `Monobank ${acc.maskedPan[0]}` : `Monobank ${acc.type || 'card'}`,
            accountNumber: acc.id,
            type: mapMonoAccountType(acc.type),
            // Monobank's `balance` includes the credit limit: own money = balance - creditLimit.
            balance: money.round((balanceMinor - limitMinor) / 100),
            creditLimit: money.round(limitMinor / 100),
            currency,
            iban: acc.iban || null
          });
        }
        return out;
      } catch (error) {
        throw new Error(monoErrorMessage(error));
      }
    }
    throw new Error(`No account reader for ${cfg.name}`);
  }

  async getTransactions(bankId, connection, accountNumber, options = {}) {
    const cfg = assertTokenBank(bankId);
    const headers = this.getAuthHeaders(bankId, connection);
    const { startDate, endDate } = options;

    if (bankId === 'monobank') {
      // Unix seconds; the API caps a single request at 31 days + 1 hour.
      // A bare 'YYYY-MM-DD' end date includes that whole (Kyiv) day.
      const nowSec = Math.floor(Date.now() / 1000);
      let to = endDate ? rangeBound(endDate, 'end') : nowSec;
      if (to > nowSec) to = nowSec;
      let from = startDate ? rangeBound(startDate, 'start') : to - 30 * 24 * 3600;
      if (from > to) throw new Error('Start date is after the end date');
      const maxSpan = 31 * 24 * 3600;
      if (to - from > maxSpan) from = to - maxSpan;

      const url = `${cfg.apiUrl}/personal/statement/${encodeURIComponent(accountNumber)}/${from}/${to}`;
      try {
        const res = await axios.get(url, { headers, timeout: HTTP_TIMEOUT_MS });
        const ops = Array.isArray(res.data) ? res.data : [];
        return ops.map((op) => {
          const amount = (Number(op.amount) || 0) / 100;
          const description = op.description || op.comment || 'Transaction';
          return {
            id: op.id,
            date: kyivDate(op.time),
            description,
            category: op.mcc ? categorizeByMcc(op.mcc) : categorizeByDescription(description),
            amount,
            type: amount >= 0 ? 'income' : 'expense',
            externalId: op.id,
            mcc: op.mcc || null,
            balanceAfter: op.balance != null ? Number(op.balance) / 100 : null
          };
        });
      } catch (error) {
        throw new Error(monoErrorMessage(error));
      }
    }
    throw new Error(`No statement reader for ${cfg.name}`);
  }
}

module.exports = new BankApiService();
module.exports.currencyFromNumeric = currencyFromNumeric;
module.exports.kyivDate = kyivDate;
module.exports.rangeBound = rangeBound;
