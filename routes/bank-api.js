// routes/bank-api.js — bank connectivity: honest catalogue, Monobank token
// connections, and the statement import wizard (CSV / OFX / QFX).
//
//   GET  /banks                      honest list: type 'token' | 'file-import'
//   GET  /supported-banks            legacy alias of /banks (?region=)
//   GET  /banks-by-region            grouped for the UI (+ user's custom banks)
//   GET  /auth-types
//   GET  /connections
//   POST /connect/:bankId            token banks -> { directAuth: true }
//   POST /connect/:bankId/direct     store a personal token (verified against the bank first)
//   POST /disconnect/:connectionId
//   POST /sync-accounts/:connectionId
//   POST /sync-transactions/:accountId   (dedupes by date+amount+description)
//   GET  /import/presets             CSV presets with their `verified` flag
//   POST /import/preview             multipart file -> parsed rows + preset + duplicates
//   POST /import/commit              JSON rows -> inserted inside db.transaction(), balance updated once
//   custom-banks CRUD (user-defined API endpoints) — unchanged API surface

const express = require('express');
const passport = require('passport');
const multer = require('multer');
const path = require('path');

const BankConnection = require('../models/bankConnection');
const Account = require('../models/account');
const CustomBank = require('../models/customBank');
const bankApiConfig = require('../config/bank-api-config');
const bankApiService = require('../services/bankApiService');
const csvImportService = require('../services/csvImportService');
const ofxImportService = require('../services/ofxImportService');
const { query, run, transaction } = require('../db/database');
const money = require('../lib/money');

const router = express.Router();
const authenticate = passport.authenticate('jwt', { session: false });

const MAX_COMMIT_ROWS = 5000;
const IMPORT_EXTS = new Set(['.csv', '.txt', '.tsv', '.ofx', '.qfx', '.qbo']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (IMPORT_EXTS.has(ext)) return cb(null, true);
    cb(new Error('Unsupported file type. Upload a CSV, OFX, QFX or QBO statement.'));
  }
});

function fail(res, status, message) {
  return res.status(status).json({ error: true, message });
}

function bankSummary(bankId) {
  return bankApiConfig.listBanks().find((b) => b.id === bankId) || null;
}

// Fingerprints of what the account already holds (for duplicate detection).
async function loadExistingFingerprints(accountId, userId) {
  const rows = await query(
    `SELECT date, amount, description FROM transactions WHERE account_id = ? AND user_id = ?`,
    [accountId, userId]
  );
  const set = new Set();
  for (const r of rows) set.add(csvImportService.fingerprintOf(r.date, r.amount, r.description));
  return set;
}

// ==================== CATALOGUE ====================

router.get('/banks', authenticate, (req, res) => {
  const { region, type } = req.query;
  res.json(bankApiConfig.listBanks({ region, type }));
});

router.get('/supported-banks', authenticate, (req, res) => {
  res.json(bankApiConfig.listBanks({ region: req.query.region }));
});

router.get('/banks-by-region', authenticate, async (req, res) => {
  try {
    const all = bankApiConfig.listBanks();
    const result = {};
    for (const [regionId, regionData] of Object.entries(bankApiConfig.regions || {})) {
      result[regionId] = {
        name: regionData.name,
        flag: regionData.flag,
        banks: regionData.banks.map((id) => all.find((b) => b.id === id)).filter(Boolean)
      };
    }
    const customBanks = await CustomBank.findByUserId(req.user.id);
    if (customBanks.length > 0) {
      result.custom = {
        name: 'My banks',
        flag: '⚙️',
        banks: customBanks.map((bank) => ({
          id: bank.bankKey,
          name: bank.name,
          country: bank.country,
          type: 'token',
          icon: null,
          authType: bank.authType,
          requiresRedirect: false,
          tokenInstructions: bank.tokenInstructions || null,
          isCustom: true
        }))
      };
    }
    res.json(result);
  } catch (error) {
    console.error('Error fetching banks by region:', error);
    fail(res, 500, 'Failed to get bank list');
  }
});

router.get('/auth-types', authenticate, (req, res) => {
  res.json(bankApiConfig.authTypes || {});
});

// ==================== CONNECTIONS (token banks) ====================

router.get('/connections', authenticate, async (req, res) => {
  try {
    const connections = await BankConnection.findByUserId(req.user.id);
    res.json(
      connections.map((conn) => {
        const bank = bankSummary(conn.bank_id);
        return {
          id: conn.id,
          bankId: conn.bank_id,
          bankName: bank ? bank.name : conn.bank_id,
          bankIcon: bank ? bank.icon : null,
          type: bank ? bank.type : 'token',
          isActive: conn.is_active === 1,
          createdAt: conn.created_at,
          updatedAt: conn.updated_at,
          expiresAt: conn.expires_at,
          accountIds: conn.accountIds
        };
      })
    );
  } catch (error) {
    console.error('Error fetching bank connections:', error);
    fail(res, 500, 'Failed to get bank connections');
  }
});

router.post('/connect/:bankId', authenticate, async (req, res) => {
  const { bankId } = req.params;
  const bank = bankSummary(bankId);
  if (!bank) return fail(res, 400, 'Bank not supported');
  if (bank.type !== 'token') {
    return res.status(400).json({
      error: true,
      code: 'FILE_IMPORT_ONLY',
      message: `${bank.name} has no personal API. Import a statement file instead.`,
      exportHint: bank.exportHint,
      formats: bank.formats
    });
  }
  try {
    res.json(await bankApiService.getAuthorizationUrl(bankId));
  } catch (error) {
    fail(res, 500, error.message || 'Failed to start bank connection');
  }
});

router.post('/connect/:bankId/direct', authenticate, async (req, res) => {
  const { bankId } = req.params;
  const { apiKey, skipVerify } = req.body || {};
  const bank = bankSummary(bankId);
  if (!bank) return fail(res, 400, 'Bank not supported');
  if (bank.type !== 'token') return fail(res, 400, `${bank.name} has no personal API. Import a statement file instead.`);
  const token = String(apiKey || '').trim();
  if (!token) return fail(res, 400, 'Enter the personal token');
  if (token.length > 512) return fail(res, 400, 'Token is too long');

  try {
    let verification = null;
    if (!skipVerify) {
      verification = await bankApiService.verifyToken(bankId, token);
      if (!verification.ok) return fail(res, 400, verification.message || 'The bank rejected this token');
    }
    const connection = await BankConnection.createOrUpdate({ userId: req.user.id, bankId, accessToken: token });
    res.json({
      success: true,
      connectionId: connection.id,
      bankName: bank.name,
      verified: !!(verification && verification.ok),
      clientName: verification ? verification.clientName : null,
      accounts: verification ? verification.accounts : null
    });
  } catch (error) {
    console.error('Error connecting bank:', error);
    fail(res, 500, 'Failed to connect the bank');
  }
});

router.post('/disconnect/:connectionId', authenticate, async (req, res) => {
  try {
    const connection = await BankConnection.findById(req.params.connectionId, req.user.id);
    if (!connection) return fail(res, 404, 'Connection not found');
    await bankApiService.revokeAccess(connection.bank_id, connection);
    await BankConnection.deactivate(connection.id, req.user.id);
    res.json({ success: true, message: 'Bank disconnected' });
  } catch (error) {
    console.error('Error disconnecting bank:', error);
    fail(res, 500, 'Failed to disconnect the bank');
  }
});

router.post('/sync-accounts/:connectionId', authenticate, async (req, res) => {
  try {
    const connection = await BankConnection.findById(req.params.connectionId, req.user.id);
    if (!connection) return fail(res, 404, 'Connection not found');
    const bank = bankSummary(connection.bank_id);
    const bankName = bank ? bank.name : connection.bank_id;

    const bankAccounts = await bankApiService.getAccounts(connection.bank_id, connection);
    const existing = await Account.findByUserId(req.user.id);
    const byNumber = new Map(existing.map((a) => [a.account_number, a]));

    const result = [];
    for (const ba of bankAccounts) {
      const found = byNumber.get(ba.accountNumber);
      if (found) {
        await Account.update(found.id, req.user.id, {
          name: found.name || ba.name,
          bankName,
          currency: ba.currency,
          balance: ba.balance,
          accountType: ba.type
        });
        result.push({ ...found, name: found.name || ba.name, balance: ba.balance, currency: ba.currency, updated: true });
      } else {
        const created = await Account.create({
          userId: req.user.id,
          name: ba.name,
          accountNumber: ba.accountNumber,
          bankName,
          currency: ba.currency,
          balance: ba.balance,
          accountType: ba.type
        });
        result.push({ ...created, updated: false });
      }
    }
    // The row comes back snake_case; createOrUpdate reads camelCase (bankId/accessToken/...).
    await BankConnection.createOrUpdate({
      userId: req.user.id,
      bankId: connection.bank_id,
      accessToken: connection.access_token,
      refreshToken: connection.refresh_token || null,
      expiresAt: connection.expires_at || null,
      accountIds: result.map((a) => a.id)
    });
    res.json({ success: true, accounts: result });
  } catch (error) {
    console.error('Error syncing accounts:', error);
    fail(res, 502, error.message || 'Failed to sync accounts');
  }
});

router.post('/sync-transactions/:accountId', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.body || {};
    const account = await Account.findById(req.params.accountId, req.user.id);
    if (!account) return fail(res, 404, 'Account not found');

    const connections = await BankConnection.findByUserId(req.user.id);
    const connection = connections.find((c) => {
      const bank = bankSummary(c.bank_id);
      return (bank && bank.name === account.bank_name) || (c.accountIds || []).includes(account.id);
    });
    if (!connection) return fail(res, 404, 'No bank connection for this account');

    const bankTx = await bankApiService.getTransactions(connection.bank_id, connection, account.account_number, { startDate, endDate });
    const existing = await loadExistingFingerprints(account.id, req.user.id);

    let inserted = 0;
    let skipped = 0;
    await transaction(async () => {
      for (const tr of bankTx) {
        const amount = money.round(tr.amount);
        const fp = csvImportService.fingerprintOf(tr.date, amount, tr.description);
        if (existing.has(fp)) {
          skipped++;
          continue;
        }
        existing.add(fp);
        await run(
          `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [account.id, req.user.id, tr.date, tr.description || '', tr.category || 'Other', amount, tr.type || (amount >= 0 ? 'income' : 'expense')]
        );
        inserted++;
      }
      // Balance is not touched: the bank balance is written by sync-accounts.
    });
    res.json({ success: true, count: inserted, inserted, skipped, fetched: bankTx.length });
  } catch (error) {
    console.error('Error syncing transactions:', error);
    fail(res, 502, error.message || 'Failed to sync transactions');
  }
});

// ==================== STATEMENT IMPORT (CSV / OFX / QFX) ====================

router.get('/import/presets', authenticate, (req, res) => {
  res.json({
    presets: csvImportService.listPresets(),
    formats: ['csv', 'ofx', 'qfx', 'qbo'],
    banks: bankApiConfig.listBanks({ type: 'file-import' })
  });
});

function parseBoolean(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

// multipart/form-data: file + optional accountId, presetId, hasHeader, delimiter, dateOrder, mapping (JSON)
router.post('/import/preview', authenticate, (req, res) => {
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) return fail(res, 400, uploadError.message || 'Upload failed');
    if (!req.file) return fail(res, 400, 'No file uploaded');
    try {
      const body = req.body || {};
      let account = null;
      if (body.accountId) {
        account = await Account.findById(body.accountId, req.user.id);
        if (!account) return fail(res, 404, 'Account not found');
      }
      const existing = account ? await loadExistingFingerprints(account.id, req.user.id) : new Set();

      const text = req.file.buffer.toString('utf8');
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      let preview;
      if (ofxImportService.isOfx(text) || ['.ofx', '.qfx', '.qbo'].includes(ext)) {
        preview = ofxImportService.previewOfx(text, { existingFingerprints: existing });
      } else {
        let mapping;
        if (body.mapping) {
          try {
            mapping = typeof body.mapping === 'string' ? JSON.parse(body.mapping) : body.mapping;
          } catch (_) {
            return fail(res, 400, 'mapping must be JSON');
          }
        }
        let delimiter = body.delimiter;
        if (delimiter === '\\t' || delimiter === 'tab') delimiter = '\t';
        preview = csvImportService.previewCsv(text, {
          presetId: body.presetId || undefined,
          hasHeader: parseBoolean(body.hasHeader),
          delimiter: delimiter || undefined,
          dateOrder: body.dateOrder || undefined,
          mapping,
          existingFingerprints: existing
        });
      }
      // Trim bulky raw payloads for very large files; keep the first 2000 rows in full.
      if (preview.rows.length > 2000) {
        preview.truncated = preview.rows.length;
        preview.rows = preview.rows.slice(0, 2000);
      }
      res.json({
        success: true,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        accountId: account ? account.id : null,
        accountCurrency: account ? account.currency : null,
        ...preview
      });
    } catch (error) {
      fail(res, 400, error.message || 'Could not parse this file');
    }
  });
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// V8 turns "2026-02-31" into March 2nd, so check the calendar, not just the shape.
function isCalendarDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

// JSON: { accountId, rows:[{date, description, amount, category, type}], skipDuplicates=true, updateBalance=true }
router.post('/import/commit', authenticate, async (req, res) => {
  try {
    const body = req.body || {};
    const { accountId } = body;
    const rows = Array.isArray(body.rows) ? body.rows : null;
    const skipDuplicates = body.skipDuplicates !== false;
    const updateBalance = body.updateBalance !== false;

    if (!accountId) return fail(res, 400, 'accountId is required');
    if (!rows || rows.length === 0) return fail(res, 400, 'rows must be a non-empty array');
    if (rows.length > MAX_COMMIT_ROWS) return fail(res, 400, `At most ${MAX_COMMIT_ROWS} rows per import`);

    const account = await Account.findById(accountId, req.user.id);
    if (!account) return fail(res, 404, 'Account not found');

    // Validate before touching the DB.
    const prepared = [];
    const errors = [];
    rows.forEach((r, i) => {
      const date = String(r.date || '').trim();
      const amount = Number(r.amount);
      if (!ISO_DATE.test(date) || !isCalendarDate(date)) {
        errors.push({ index: i, message: `Row ${i + 1}: invalid date "${r.date}"` });
        return;
      }
      if (!Number.isFinite(amount)) {
        errors.push({ index: i, message: `Row ${i + 1}: invalid amount "${r.amount}"` });
        return;
      }
      const description = String(r.description || 'Transaction').replace(/\s+/g, ' ').trim().slice(0, 500);
      const category = String(r.category || 'Other').trim().slice(0, 100) || 'Other';
      const rounded = money.round(amount);
      const type = r.type === 'income' || r.type === 'expense' ? r.type : rounded >= 0 ? 'income' : 'expense';
      prepared.push({ date, description, category, amount: rounded, type, fingerprint: csvImportService.fingerprintOf(date, rounded, description) });
    });
    if (errors.length && prepared.length === 0) return res.status(400).json({ error: true, message: errors[0].message, errors });

    const existing = await loadExistingFingerprints(account.id, req.user.id);
    let inserted = 0;
    let skipped = 0;
    let delta = 0;
    await transaction(async () => {
      for (const tx of prepared) {
        if (skipDuplicates && existing.has(tx.fingerprint)) {
          skipped++;
          continue;
        }
        existing.add(tx.fingerprint);
        await run(
          `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [account.id, req.user.id, tx.date, tx.description, tx.category, tx.amount, tx.type]
        );
        inserted++;
        delta = money.add(delta, tx.amount);
      }
      if (updateBalance && inserted > 0 && delta !== 0) {
        await run(
          `UPDATE accounts SET balance = ROUND(balance + ?, 2), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
          [delta, account.id, req.user.id]
        );
      }
    });

    const refreshed = await Account.findById(account.id, req.user.id);
    res.json({
      success: true,
      accountId: account.id,
      inserted,
      skipped,
      rejected: errors.length,
      errors,
      balanceDelta: updateBalance ? delta : 0,
      newBalance: refreshed ? refreshed.balance : null
    });
  } catch (error) {
    console.error('Error committing import:', error);
    fail(res, 500, 'Import failed; nothing was written');
  }
});

// ==================== CUSTOM BANKS (user-defined API endpoints) ====================

router.get('/custom-banks', authenticate, async (req, res) => {
  try {
    res.json(await CustomBank.findByUserId(req.user.id));
  } catch (error) {
    console.error('Error fetching custom banks:', error);
    fail(res, 500, 'Failed to get custom banks');
  }
});

router.post('/custom-banks', authenticate, async (req, res) => {
  try {
    const { name, country, apiUrl, authType, scopes, endpoints, tokenInstructions } = req.body || {};
    if (!name || !name.trim()) return fail(res, 400, 'Bank name is required');
    if (!country || !country.trim()) return fail(res, 400, 'Country is required');
    if (!apiUrl || !apiUrl.trim()) return fail(res, 400, 'API URL is required');
    try {
      new URL(apiUrl); // eslint-disable-line no-new
    } catch {
      return fail(res, 400, 'Invalid API URL');
    }
    const validAuthTypes = ['api_key', 'bearer'];
    if (authType && !validAuthTypes.includes(authType)) return fail(res, 400, 'Invalid auth type');

    const customBank = await CustomBank.create({
      userId: req.user.id,
      name: name.trim(),
      country: country.trim().toUpperCase(),
      apiUrl: apiUrl.trim(),
      authType: authType || 'api_key',
      scopes: scopes || ['accounts', 'transactions'],
      endpoints: endpoints || {},
      tokenInstructions: tokenInstructions || ''
    });
    res.status(201).json({ success: true, bank: customBank });
  } catch (error) {
    console.error('Error creating custom bank:', error);
    if (/уже существует|already exists/i.test(error.message)) return fail(res, 400, 'A bank with this name already exists');
    fail(res, 500, 'Failed to create custom bank');
  }
});

router.put('/custom-banks/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, country, apiUrl, authType, scopes, endpoints, tokenInstructions } = req.body || {};
    const existingBank = await CustomBank.findById(id, req.user.id);
    if (!existingBank) return fail(res, 404, 'Custom bank not found');
    if (apiUrl) {
      try {
        new URL(apiUrl); // eslint-disable-line no-new
      } catch {
        return fail(res, 400, 'Invalid API URL');
      }
    }
    const updated = await CustomBank.update(id, req.user.id, {
      name: name?.trim(),
      country: country?.trim().toUpperCase(),
      apiUrl: apiUrl?.trim(),
      authType,
      scopes,
      endpoints,
      tokenInstructions
    });
    if (!updated) return fail(res, 400, 'Failed to update bank');
    res.json({ success: true, bank: await CustomBank.findById(id, req.user.id) });
  } catch (error) {
    console.error('Error updating custom bank:', error);
    fail(res, 500, 'Failed to update custom bank');
  }
});

router.delete('/custom-banks/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const existingBank = await CustomBank.findById(id, req.user.id);
    if (!existingBank) return fail(res, 404, 'Custom bank not found');
    const deleted = await CustomBank.delete(id, req.user.id);
    if (!deleted) return fail(res, 400, 'Failed to delete bank');
    res.json({ success: true, message: 'Custom bank deleted' });
  } catch (error) {
    console.error('Error deleting custom bank:', error);
    fail(res, 500, 'Failed to delete custom bank');
  }
});

router.post('/connect-custom/:bankKey/direct', authenticate, async (req, res) => {
  try {
    const { bankKey } = req.params;
    const { apiKey } = req.body || {};
    const customBank = await CustomBank.findByKey(bankKey, req.user.id);
    if (!customBank) return fail(res, 404, 'Custom bank not found');
    if (!apiKey) return fail(res, 400, 'Enter the API token');
    const connection = await BankConnection.createOrUpdate({ userId: req.user.id, bankId: bankKey, accessToken: apiKey });
    res.json({ success: true, connectionId: connection.id, bankName: customBank.name });
  } catch (error) {
    console.error('Error connecting custom bank:', error);
    fail(res, 500, 'Failed to connect custom bank');
  }
});

module.exports = router;
