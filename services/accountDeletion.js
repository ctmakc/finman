// services/accountDeletion.js — delete a user and everything they own, in one
// transaction (App Store guideline 5.1.1(v), Google Play account deletion).
//
// Mirrors the operator script /data/backups/finman/fm-deluser.js and adds the
// shared-data rules the script does not need for a one-off:
//   - a family the user owns passes to another member (admin first, then the
//     earliest to join); a family with no one else left is deleted;
//   - the user's memberships, invites and permissions on other people's
//     accounts/budgets go away; permissions the user granted on accounts they do
//     not own are re-attributed to the account/budget owner;
//   - split groups of other people keep the member row (their ledger), unlinked
//     from the account and without the user's email;
//   - transfers with a surviving leg on someone else's account are unpaired;
//   - other people's subscriptions pointing at the user's accounts lose the link.
// Every remaining row with user_id / owner_id / created_by = the user is swept
// table by table (so tables added later are covered). PRAGMA foreign_key_check
// must show no new violation before COMMIT; otherwise everything rolls back.
const { query, get, run, transaction } = require('../db/database');

const OWNER_COLUMNS = ['user_id', 'owner_id', 'created_by'];
// Global reference data or tables handled explicitly above the sweep.
const SKIP_SWEEP = new Set(['users', 'schema_migrations', 'currency_rates', 'investment_prices', 'organizations', 'invites']);

async function tableColumns(table) {
  return (await query(`PRAGMA table_info(${JSON.stringify(table)})`)).map((c) => c.name);
}

async function deleteUserData(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('invalid user id');

  return transaction(async () => {
    // FK checks are deferred to COMMIT, so the order below only has to end clean.
    await run('PRAGMA defer_foreign_keys = ON');

    const user = await get('SELECT id, email FROM users WHERE id = ?', [uid]);
    if (!user) return { deleted: false };
    // Older databases may already hold unrelated dangling rows; only violations
    // this delete introduces count.
    const fkKey = (b) => `${b.table}:${b.rowid}:${b.parent}`;
    const fkBefore = new Set((await query('PRAGMA foreign_key_check')).map(fkKey));

    // ---- families ----------------------------------------------------------
    const owned = await query('SELECT id FROM families WHERE owner_id = ?', [uid]);
    for (const { id: familyId } of owned) {
      const heir = await get(
        `SELECT user_id FROM family_members
          WHERE family_id = ? AND user_id <> ?
          ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC, id ASC
          LIMIT 1`,
        [familyId, uid]
      );
      if (heir) {
        await run('UPDATE families SET owner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [heir.user_id, familyId]);
        await run(`UPDATE family_members SET role = 'owner' WHERE family_id = ? AND user_id = ?`, [familyId, heir.user_id]);
      } else {
        await run('DELETE FROM family_invites WHERE family_id = ?', [familyId]);
        await run('DELETE FROM family_members WHERE family_id = ?', [familyId]);
        await run('DELETE FROM families WHERE id = ?', [familyId]);
      }
    }
    await run('DELETE FROM family_members WHERE user_id = ?', [uid]);
    await run('DELETE FROM family_invites WHERE created_by = ?', [uid]);

    // ---- permissions -------------------------------------------------------
    await run('DELETE FROM account_permissions WHERE user_id = ?', [uid]);
    await run('DELETE FROM budget_permissions WHERE user_id = ?', [uid]);
    await run(
      `UPDATE account_permissions
          SET granted_by = (SELECT a.user_id FROM accounts a WHERE a.id = account_permissions.account_id)
        WHERE granted_by = ?
          AND account_id IN (SELECT id FROM accounts WHERE user_id <> ?)`,
      [uid, uid]
    );
    await run(
      `UPDATE budget_permissions
          SET granted_by = (SELECT b.user_id FROM budgets b WHERE b.id = budget_permissions.budget_id)
        WHERE granted_by = ?
          AND budget_id IN (SELECT id FROM budgets WHERE user_id <> ?)`,
      [uid, uid]
    );

    // ---- split groups of other people -------------------------------------
    await run(
      `UPDATE split_members
          SET user_id = NULL, is_registered = 0,
              email = CASE WHEN email IS NOT NULL AND lower(email) = lower(?) THEN NULL ELSE email END
        WHERE user_id = ?
          AND group_id NOT IN (SELECT id FROM split_groups WHERE user_id = ?)`,
      [user.email || '', uid, uid]
    );

    // ---- ledger on the user's accounts -----------------------------------
    const myAccounts = 'SELECT id FROM accounts WHERE user_id = ?';
    await run(
      `UPDATE transactions SET transfer_id = NULL
        WHERE transfer_id IN (
                SELECT transfer_id FROM transactions
                 WHERE transfer_id IS NOT NULL AND (user_id = ? OR account_id IN (${myAccounts})))
          AND user_id <> ? AND account_id NOT IN (${myAccounts})`,
      [uid, uid, uid, uid]
    );
    await run(`DELETE FROM transactions WHERE user_id = ? OR account_id IN (${myAccounts})`, [uid, uid]);
    await run(`UPDATE subscriptions SET account_id = NULL WHERE user_id <> ? AND account_id IN (${myAccounts})`, [uid, uid]);
    await run(`DELETE FROM recurring_payments WHERE user_id = ? OR account_id IN (${myAccounts})`, [uid, uid]);

    // ---- children without a user column ------------------------------------
    await run(
      'DELETE FROM ai_messages WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE user_id = ?)',
      [uid]
    );

    // ---- sweep every table with an owner column ----------------------------
    const tables = await query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    );
    const swept = {};
    for (const { name } of tables) {
      if (SKIP_SWEEP.has(name)) continue;
      const cols = (await tableColumns(name)).filter((c) => OWNER_COLUMNS.includes(c));
      if (!cols.length) continue;
      const where = cols.map((c) => `${c} = ?`).join(' OR ');
      const r = await run(`DELETE FROM ${JSON.stringify(name)} WHERE ${where}`, cols.map(() => uid));
      if (r.changes) swept[name] = r.changes;
    }

    const del = await run('DELETE FROM users WHERE id = ?', [uid]);
    if (del.changes !== 1) throw new Error('user row was not deleted');

    const broken = (await query('PRAGMA foreign_key_check')).filter((b) => !fkBefore.has(fkKey(b)));
    if (broken.length) {
      const tablesHit = [...new Set(broken.map((b) => b.table))].join(', ');
      throw new Error('foreign key check failed after delete: ' + tablesHit);
    }
    return { deleted: true, swept };
  });
}

module.exports = { deleteUserData };
