// 028 — Statement Agent (ADDITIVE, idempotent).
//
// statement_tasks  one row per statement the agent read: what it found (rows as JSON, integer
//                  cents), the balance proof, how many model calls / tokens / milliseconds it
//                  took, and whether the person imported it. The file itself is NOT stored
//                  (only its sha-256, to spot a re-upload); only the last 4 digits of the account.
// user_id on the row, so services/accountDeletion.js sweeps it with the account.
module.exports = {
  name: '028_statement_tasks',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS statement_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'upload',
        file_name TEXT,
        file_sha256 TEXT,
        file_kind TEXT,
        mode TEXT,
        pages INTEGER,
        ai_source TEXT,
        ai_provider TEXT,
        ai_model TEXT,
        status TEXT NOT NULL,
        statement_type TEXT NOT NULL DEFAULT 'bank',
        institution TEXT,
        account_last4 TEXT,
        currency TEXT,
        period_start TEXT,
        period_end TEXT,
        opening_cents INTEGER,
        closing_cents INTEGER,
        balances_typed INTEGER NOT NULL DEFAULT 0,
        rows_json TEXT NOT NULL DEFAULT '[]',
        proof_json TEXT NOT NULL DEFAULT '{}',
        attempts_json TEXT NOT NULL DEFAULT '[]',
        model_calls INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        ms INTEGER NOT NULL DEFAULT 0,
        account_id INTEGER,
        inserted INTEGER,
        skipped INTEGER,
        committed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_statement_tasks_user ON statement_tasks (user_id, created_at)');
  },
};
