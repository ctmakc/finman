// services/importCommit.js — writes imported statement rows into one account (shared by the
// CSV/OFX import wizard and the Statement Agent).
//
// Rows: [{ date: 'YYYY-MM-DD', description, amount (signed or by type), category?, type? }].
// The type fixes the sign (expense < 0, income > 0), same rule as models/transaction.js.
// Dedupe is a multiset over (date, amount, description): each stored copy matches ONE incoming
// row, so two real identical coffees both import and a re-import of the same file skips both.
// Everything is inside one db transaction; the account balance moves once by the inserted sum.
'use strict';

const Transaction = require('../models/transaction');
const csvImportService = require('./csvImportService');
const { query, run, transaction } = require('../db/database');
const money = require('../lib/money');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// V8 turns "2026-02-31" into March 2nd, so check the calendar, not just the shape.
function isCalendarDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

async function loadExistingFingerprints(accountId, userId) {
  const rows = await query(
    `SELECT date, amount, description FROM transactions WHERE account_id = ? AND user_id = ?`,
    [accountId, userId]
  );
  return csvImportService.fingerprintCounts(rows.map((r) => csvImportService.fingerprintOf(r.date, r.amount, r.description)));
}

function consumeExisting(counts, fp) {
  const left = counts.get(fp) || 0;
  if (left <= 0) return false;
  counts.set(fp, left - 1);
  return true;
}

// -> { prepared, errors }
function prepareRows(rows) {
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
    const signed = Transaction.signedAmount(rounded, type) || 0;
    prepared.push({ date, description, category, amount: signed, type, fingerprint: csvImportService.fingerprintOf(date, signed, description) });
  });
  return { prepared, errors };
}

// -> { inserted, skipped, delta }
async function commitPrepared(account, userId, prepared, { skipDuplicates = true, updateBalance = true } = {}) {
  const existing = await loadExistingFingerprints(account.id, userId);
  let inserted = 0;
  let skipped = 0;
  let delta = 0;
  await transaction(async () => {
    for (const tx of prepared) {
      if (skipDuplicates && consumeExisting(existing, tx.fingerprint)) {
        skipped++;
        continue;
      }
      await run(
        `INSERT INTO transactions (account_id, user_id, date, description, category, amount, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [account.id, userId, tx.date, tx.description, tx.category, tx.amount, tx.type]
      );
      inserted++;
      delta = money.add(delta, tx.amount);
    }
    if (updateBalance && inserted > 0 && delta !== 0) {
      await run(
        `UPDATE accounts SET balance = ROUND(balance + ?, 2), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
        [delta, account.id, userId]
      );
    }
  });
  return { inserted, skipped, delta: updateBalance ? delta : 0 };
}

module.exports = { loadExistingFingerprints, consumeExisting, prepareRows, commitPrepared, isCalendarDate, ISO_DATE };
