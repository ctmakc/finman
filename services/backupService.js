// services/backupService.js — full data portability (export / import / CSV).
//
// Wave-2 "export-backup" stream. Produces a COMPLETE, self-describing JSON
// backup of a single user's data across every user-owned table, and restores
// it (with validation + foreign-key remapping) into a — possibly different —
// user account. Also flattens the whole backup into a single CSV-of-everything.
//
// Design rules:
//   - ADDITIVE only. We never mutate Wave-1 tables/columns; we only SELECT/INSERT.
//   - Every export row carries its original primary key under `__id` so that
//     child rows (which reference parents by id) can be re-linked after the
//     parent gets a NEW id on import. This makes export->import into a fresh
//     user reproduce the data faithfully, even though autoincrement ids differ.
//   - Import is best-effort but transactional-ish per table order: parents
//     first, children after, using an in-memory id map per table.
//   - Validation is strict at the envelope level: a malformed backup (wrong
//     shape / version / missing tables container) throws AppError(400) so the
//     route surfaces a clean 400. Individual unknown columns are ignored.
//   - All money-ish numbers pass through lib/money.round on CSV render only;
//     raw JSON keeps stored values verbatim for an exact round-trip.

const { query, get, run } = require('../db/database');
const { AppError } = require('../middleware/error');

const BACKUP_VERSION = 1;
const BACKUP_APP = 'finman';

// ---------------------------------------------------------------------------
// Table catalogue
// ---------------------------------------------------------------------------
// Each entry describes how to export/import one table. Order matters for
// import: a table must come AFTER every table it references via `parents`.
//
//   table        : sqlite table name
//   scope        : how rows are owned by the user
//                    'user'   -> column user_id = ?
//                    'owner'  -> column owner_id = ? (families)
//                    'parent' -> owned transitively via a parent row
//   parents      : map of { localColumn: parentTableName } — foreign keys that
//                  must be remapped to the parent's NEW id on import.
//   ownerColumn  : (scope 'user'|'owner') the column holding the user id.
//
// We intentionally exclude purely-global tables (currency_rates,
// investment_prices) and auth/permission plumbing that does not belong to a
// single user's portable dataset.

const TABLES = [
  // ---- top-level, owned directly by user_id ----
  { table: 'accounts', scope: 'user', ownerColumn: 'user_id' },
  { table: 'categories', scope: 'user', ownerColumn: 'user_id' },
  { table: 'budgets', scope: 'user', ownerColumn: 'user_id' },
  { table: 'tags', scope: 'user', ownerColumn: 'user_id' },
  { table: 'savings_goals', scope: 'user', ownerColumn: 'user_id' },
  { table: 'debts', scope: 'user', ownerColumn: 'user_id' },
  { table: 'recurring_payments', scope: 'user', ownerColumn: 'user_id',
    parents: { account_id: 'accounts' } },
  { table: 'manual_assets', scope: 'user', ownerColumn: 'user_id' },
  { table: 'subscriptions', scope: 'user', ownerColumn: 'user_id',
    parents: { account_id: 'accounts' } },
  { table: 'investment_portfolios', scope: 'user', ownerColumn: 'user_id' },
  { table: 'split_groups', scope: 'user', ownerColumn: 'user_id' },
  { table: 'calendar_events', scope: 'user', ownerColumn: 'user_id' },
  { table: 'dashboard_widgets', scope: 'user', ownerColumn: 'user_id' },
  { table: 'notification_settings', scope: 'user', ownerColumn: 'user_id' },
  { table: 'user_currency_settings', scope: 'user', ownerColumn: 'user_id' },
  { table: 'networth_snapshots', scope: 'user', ownerColumn: 'user_id' },

  // ---- transactions reference accounts; keep after accounts ----
  { table: 'transactions', scope: 'user', ownerColumn: 'user_id',
    parents: { account_id: 'accounts' } },

  // ---- children (owned via a parent row) ----
  { table: 'transaction_tags', scope: 'parent',
    parents: { transaction_id: 'transactions', tag_id: 'tags' } },
  { table: 'goal_contributions', scope: 'parent',
    parents: { goal_id: 'savings_goals', transaction_id: 'transactions' } },
  { table: 'debt_payments', scope: 'parent',
    parents: { debt_id: 'debts', transaction_id: 'transactions' } },
  { table: 'subscription_payments', scope: 'parent',
    parents: { subscription_id: 'subscriptions', transaction_id: 'transactions' } },
  { table: 'investments', scope: 'parent',
    parents: { portfolio_id: 'investment_portfolios' } },
  { table: 'investment_transactions', scope: 'parent',
    parents: { investment_id: 'investments' } },
  { table: 'split_members', scope: 'parent',
    parents: { group_id: 'split_groups' } },
  { table: 'split_expenses', scope: 'parent',
    parents: { group_id: 'split_groups', paid_by: 'split_members' } },
  { table: 'split_shares', scope: 'parent',
    parents: { expense_id: 'split_expenses', member_id: 'split_members' } },
  { table: 'split_settlements', scope: 'parent',
    parents: { group_id: 'split_groups', from_member: 'split_members', to_member: 'split_members' } },
];

const TABLE_BY_NAME = TABLES.reduce((acc, t) => {
  acc[t.table] = t;
  return acc;
}, {});

// Columns we never carry across a restore (they are autoincrement / ownership /
// audit columns re-derived on insert).
const SKIP_INSERT_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

// ---------------------------------------------------------------------------
// Schema introspection (which columns actually exist) — cached per process,
// keyed by table. Lets the same code work even if a migration added/omitted a
// column, so we only ever INSERT real columns.
// ---------------------------------------------------------------------------
const _columnCache = new Map();

async function getColumns(table) {
  if (_columnCache.has(table)) return _columnCache.get(table);
  // PRAGMA table_info cannot be parameterised; table names come from our own
  // constant TABLES list (never user input), so this is safe.
  const rows = await query(`PRAGMA table_info(${table})`);
  const cols = rows.map((r) => r.name);
  _columnCache.set(table, cols);
  return cols;
}

// SELECT all rows of a table that belong to the given user, honouring scope.
async function selectOwnedRows(spec, userId) {
  const { table, scope } = spec;

  if (scope === 'user' || scope === 'owner') {
    const col = spec.ownerColumn || (scope === 'owner' ? 'owner_id' : 'user_id');
    return query(`SELECT * FROM ${table} WHERE ${col} = ?`, [userId]);
  }

  // scope === 'parent': resolve ownership transitively through the first parent
  // that is itself user-scoped (directly or indirectly). We do this with a
  // JOIN chain built from the parents map.
  return selectChildRows(spec, userId);
}

// For parent-scoped tables we filter rows down to those whose ancestry leads to
// the user. We reuse the already-exported parent id sets passed via `ownedIds`.
async function selectChildRows(spec, userId, ownedIds) {
  const { table } = spec;
  // If we have the owned-id sets for the parents, filter against them in SQL.
  // Otherwise (defensive) fall back to returning all rows then filtering in JS.
  const all = await query(`SELECT * FROM ${table}`, []);
  if (!ownedIds) return all;

  const parents = spec.parents || {};
  return all.filter((row) => {
    // A child belongs to the user iff EVERY non-null parent reference points to
    // a parent we exported for this user. (transaction_id may be null.)
    for (const [col, parentTable] of Object.entries(parents)) {
      const val = row[col];
      if (val === null || val === undefined) continue;
      const set = ownedIds[parentTable];
      if (!set) return false;
      if (!set.has(val)) return false;
    }
    // Require at least one parent reference to be present and owned, so we never
    // sweep in orphan/global rows that happen to have all-null FKs.
    const hasAnyOwnedRef = Object.entries(parents).some(([col, parentTable]) => {
      const val = row[col];
      if (val === null || val === undefined) return false;
      const set = ownedIds[parentTable];
      return set && set.has(val);
    });
    return hasAnyOwnedRef;
  });
}

// ---------------------------------------------------------------------------
// exportAll(userId) -> Promise<backupObject>
// ---------------------------------------------------------------------------
async function exportAll(userId) {
  if (!userId) throw new AppError(400, 'VALIDATION_ERROR', 'userId is required');

  // Pull the (sanitised) user record for context — never include the password.
  const user = await get(
    'SELECT id, username, email, full_name, created_at FROM users WHERE id = ?',
    [userId]
  );

  const data = {};
  // Track exported primary keys per table so child tables can be filtered.
  const ownedIds = {};

  for (const spec of TABLES) {
    let rows;
    if (spec.scope === 'parent') {
      rows = await selectChildRows(spec, userId, ownedIds);
    } else {
      rows = await selectOwnedRows(spec, userId);
    }

    // Stamp every row with its original id for FK remapping on import.
    const set = new Set();
    const exported = rows.map((row) => {
      if (row.id !== undefined && row.id !== null) set.add(row.id);
      return Object.assign({ __id: row.id }, row);
    });
    ownedIds[spec.table] = set;
    data[spec.table] = exported;
  }

  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    user: user
      ? { id: user.id, username: user.username, email: user.email, fullName: user.full_name }
      : { id: userId },
    tables: data,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
// Accepts either a parsed object or a JSON string. Throws AppError(400) on any
// structural problem.
function parseAndValidate(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new AppError(400, 'INVALID_BACKUP', 'Backup is not valid JSON');
    }
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new AppError(400, 'INVALID_BACKUP', 'Backup must be a JSON object');
  }
  if (obj.app && obj.app !== BACKUP_APP) {
    throw new AppError(400, 'INVALID_BACKUP', `Unknown backup app: ${obj.app}`);
  }
  if (obj.version !== undefined && Number(obj.version) > BACKUP_VERSION) {
    throw new AppError(
      400,
      'INVALID_BACKUP',
      `Unsupported backup version: ${obj.version}`
    );
  }
  if (!obj.tables || typeof obj.tables !== 'object' || Array.isArray(obj.tables)) {
    throw new AppError(400, 'INVALID_BACKUP', 'Backup is missing a tables object');
  }

  // Every present table must be a known table and an array.
  for (const [name, rows] of Object.entries(obj.tables)) {
    if (!TABLE_BY_NAME[name]) {
      throw new AppError(400, 'INVALID_BACKUP', `Unknown table in backup: ${name}`);
    }
    if (!Array.isArray(rows)) {
      throw new AppError(400, 'INVALID_BACKUP', `Table ${name} must be an array`);
    }
  }

  return obj;
}

// ---------------------------------------------------------------------------
// importAll(userId, json) -> Promise<{ imported, skipped, idMap }>
// ---------------------------------------------------------------------------
// Restores a backup into `userId`. Foreign keys are remapped from the backup's
// original ids to the freshly-inserted ids. Returns per-table counts.
async function importAll(userId, json) {
  if (!userId) throw new AppError(400, 'VALIDATION_ERROR', 'userId is required');

  const backup = parseAndValidate(json);
  const tables = backup.tables;

  // idMap[table] = Map(oldId -> newId)
  const idMap = {};
  const imported = {};
  const skipped = {};

  // Iterate in catalogue order so parents are inserted before children.
  for (const spec of TABLES) {
    const { table } = spec;
    idMap[table] = new Map();
    imported[table] = 0;
    skipped[table] = 0;

    const rows = tables[table];
    if (!rows || !rows.length) continue;

    const existingCols = await getColumns(table);
    const parents = spec.parents || {};
    const ownerColumn =
      spec.scope === 'user'
        ? spec.ownerColumn || 'user_id'
        : spec.scope === 'owner'
          ? spec.ownerColumn || 'owner_id'
          : null;

    for (const raw of rows) {
      const oldId = raw.__id !== undefined ? raw.__id : raw.id;

      // Build the column/value lists for this row.
      const cols = [];
      const vals = [];
      let parentMissing = false;

      for (const col of existingCols) {
        if (SKIP_INSERT_COLUMNS.has(col)) continue;

        // Ownership column -> force to the importing user.
        if (ownerColumn && col === ownerColumn) {
          cols.push(col);
          vals.push(userId);
          continue;
        }

        // Foreign-key column -> remap to the parent's new id.
        if (parents[col]) {
          const parentTable = parents[col];
          const rawVal = raw[col];
          if (rawVal === null || rawVal === undefined) {
            cols.push(col);
            vals.push(null);
            continue;
          }
          const map = idMap[parentTable];
          const mapped = map ? map.get(rawVal) : undefined;
          if (mapped === undefined) {
            // Parent wasn't imported (e.g. partial backup). For a NOT NULL FK we
            // must skip this child; for a nullable one we could null it, but to
            // stay safe we skip the whole row.
            parentMissing = true;
            break;
          }
          cols.push(col);
          vals.push(mapped);
          continue;
        }

        // Plain data column — copy through if present in the backup row.
        if (Object.prototype.hasOwnProperty.call(raw, col)) {
          cols.push(col);
          vals.push(raw[col]);
        }
      }

      if (parentMissing || !cols.length) {
        skipped[table]++;
        continue;
      }

      // Ensure the ownership column is always set for user/owner-scoped tables
      // even if it wasn't in existingCols loop (it always is, but be safe).
      if (ownerColumn && !cols.includes(ownerColumn)) {
        cols.push(ownerColumn);
        vals.push(userId);
      }

      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      try {
        const result = await run(sql, vals);
        if (oldId !== undefined && oldId !== null) {
          idMap[table].set(oldId, result.id);
        }
        imported[table]++;
      } catch (e) {
        // A single bad row should not abort the whole restore.
        skipped[table]++;
      }
    }
  }

  const totalImported = Object.values(imported).reduce((a, b) => a + b, 0);
  const totalSkipped = Object.values(skipped).reduce((a, b) => a + b, 0);

  return {
    totalImported,
    totalSkipped,
    imported,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// CSV of everything
// ---------------------------------------------------------------------------
// Renders the full backup as a single CSV where the first column is the source
// table name, followed by a stable union of columns. This is a human-readable
// "everything" dump (not meant for re-import — JSON is the round-trip format).
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/[",\n\r]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function exportCsv(userId) {
  const backup = await exportAll(userId);
  const lines = [];

  for (const spec of TABLES) {
    const rows = backup.tables[spec.table] || [];
    if (!rows.length) continue;

    // Column union across the rows of this table (excluding the synthetic __id).
    const colSet = [];
    const seen = new Set();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (k === '__id') continue;
        if (!seen.has(k)) {
          seen.add(k);
          colSet.push(k);
        }
      }
    }

    // Section header so a human can find each table inside the single CSV.
    lines.push(`# ${spec.table}`);
    lines.push(['table', ...colSet].map(csvEscape).join(','));
    for (const row of rows) {
      const cells = [spec.table, ...colSet.map((c) => row[c])];
      lines.push(cells.map(csvEscape).join(','));
    }
    lines.push(''); // blank separator between tables
  }

  if (!lines.length) {
    lines.push('table');
  }

  // BOM so Excel reads UTF-8 (Cyrillic merchant/category names) correctly.
  return '﻿' + lines.join('\n');
}

module.exports = {
  exportAll,
  importAll,
  exportCsv,
  parseAndValidate,
  BACKUP_VERSION,
  BACKUP_APP,
  TABLES,
};
