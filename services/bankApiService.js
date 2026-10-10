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

function formatDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toISOString().slice(0, 10);
}

// ISO-4217 numeric -> alpha (Monobank returns numeric codes).
const CURRENCY_BY_NUMERIC = {
  980: 'UAH', 840: 'USD', 978: 'EUR', 826: 'GBP', 985: 'PLN', 203: 'CZK',
  756: 'CHF', 124: 'CAD', 392: 'JPY', 156: 'CNY', 949: 'TRY', 348: 'HUF',
  752: 'SEK', 578: 'NOK', 208: 'DKK', 643: 'RUB', 376: 'ILS', 784: 'AED'
};
function currencyFromNumeric(code) {
  return CURRENCY_BY_NUMERIC[code] || 'UAH';
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
        return accounts.map((acc) => ({
          id: acc.id,
          name: acc.maskedPan?.[0] ? `Monobank ${acc.maskedPan[0]}` : `Monobank ${acc.type || 'card'}`,
          accountNumber: acc.id,
          type: mapMonoAccountType(acc.type),
          balance: (Number(acc.balance) || 0) / 100, // kopiykas -> UAH units
          creditLimit: (Number(acc.creditLimit) || 0) / 100,
          currency: currencyFromNumeric(acc.currencyCode),
          iban: acc.iban || null
        }));
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
      const nowSec = Math.floor(Date.now() / 1000);
      const to = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : nowSec;
      let from = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : to - 30 * 24 * 3600;
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
            date: formatDate(new Date(op.time * 1000)),
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
