// 031 — business vs personal money (management accounting, 21.11.2026). ADDITIVE, idempotent.
//
// accounts.scope          'personal' (default) | 'business' — whose money the account holds.
// accounts.business_name  which business a business account belongs to ('' = "My business");
//                         several businesses are told apart by this name.
// Runs on the server DB and inside every Finman Vault (engine/src/schema.js runs the same files).
module.exports = {
  name: '031_account_scope',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'accounts', 'scope'))) {
      await db.run(`ALTER TABLE accounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'`);
    }
    if (!(await columnExists(db, 'accounts', 'business_name'))) {
      await db.run(`ALTER TABLE accounts ADD COLUMN business_name TEXT NOT NULL DEFAULT ''`);
    }
  }
};
