// 030 — in-app feedback (ADDITIVE, idempotent).
//
// feedback  what people tell the Finman team on purpose: a star rating, a one-question
//           survey after a key moment, a bug report, an idea, or why they delete the
//           account. The person writes it for us, so it is stored as plain text (it is
//           not part of their ledger). user_id goes NULL when the account is deleted
//           (services/accountDeletion.js) — the exit survey survives anonymised.
//   kind     rating | survey | bug | idea | exit
//   trigger  menu | settings | import_done | insight_shown | day7 | account_delete
//   answer   chosen option key of a survey (e.g. bank_sync, privacy)
//   is_test  comment starts with "test" — kept out of Telegram / review inbox
//   status   new | seen | done
// 028 = statement agent, 029 = reserved for the encryption work.
module.exports = {
  name: '030_feedback',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'menu',
        rating INTEGER,
        answer TEXT,
        comment TEXT,
        page TEXT,
        app_version TEXT,
        lang TEXT,
        device TEXT,
        is_test INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_feedback_user_trigger ON feedback (user_id, trigger)');
  },
};
