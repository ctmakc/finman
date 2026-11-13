// 022 — first-run activation (ADDITIVE, idempotent).
//
// accounts.is_demo        demo household a new user can load from the empty
//                         dashboard and remove in one click (DELETE /api/onboarding/demo).
// users.email_verified_at email confirmation for password sign-ups. Google
//                         sign-ins arrive verified by Google, so they are back-filled.
// users.email_verify_hash sha-256 of the one-time link token (the token itself is
//                         only in the email).
// users.email_verify_sent_at  resend throttle.
module.exports = {
  name: '022_onboarding_activation',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'accounts', 'is_demo'))) {
      await db.run(`ALTER TABLE accounts ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`);
    }
    if (!(await columnExists(db, 'users', 'email_verified_at'))) {
      await db.run(`ALTER TABLE users ADD COLUMN email_verified_at DATETIME`);
      await db.run(
        `UPDATE users SET email_verified_at = COALESCE(created_at, CURRENT_TIMESTAMP)
         WHERE google_id IS NOT NULL AND google_id <> ''`
      );
    }
    if (!(await columnExists(db, 'users', 'email_verify_hash'))) {
      await db.run(`ALTER TABLE users ADD COLUMN email_verify_hash TEXT`);
    }
    if (!(await columnExists(db, 'users', 'email_verify_sent_at'))) {
      await db.run(`ALTER TABLE users ADD COLUMN email_verify_sent_at DATETIME`);
    }
    await db.run(`CREATE INDEX IF NOT EXISTS idx_users_email_verify_hash ON users (email_verify_hash)`);
  },
};
