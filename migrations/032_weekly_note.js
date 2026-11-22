// 032 — weekly email switch kept on the server (22.11.2026). ADDITIVE, idempotent.
//
// users.weekly_note_opt_out  1 = no weekly email of any kind: neither the "Your week in money"
//                            recap with numbers (open-data users) nor the no-numbers reminder
//                            for Finman Vault users. Set from Settings -> Emails
//                            (PUT /api/auth/email-prefs). It has to live on the server: the
//                            vault's own notification_settings are encrypted.
// Runs inside every vault too (engine/src/schema.js); there the column is simply unused.
module.exports = {
  name: '032_weekly_note',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'users', 'weekly_note_opt_out'))) {
      await db.run('ALTER TABLE users ADD COLUMN weekly_note_opt_out INTEGER NOT NULL DEFAULT 0');
    }
  }
};
