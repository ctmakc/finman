// 024 — native iOS/Android app (ADDITIVE, idempotent).
//
// users.apple_id                 Sign in with Apple subject ("sub"), unique when set.
// users.apple_refresh_token_enc  Apple refresh token, AES-GCM encrypted with
//                                config.encryptToken. Kept only so account deletion
//                                can revoke it at Apple.
// app_auth_handoff               one-time hand-off of a Google sign-in from the
//                                system browser back into the app. Keyed by the
//                                sha-256 of a nonce the app generated; the raw nonce
//                                never touches the database. Rows live 10 minutes
//                                and are deleted on the first claim.
//
// Numbered 024: 023 is taken by a parallel branch.
module.exports = {
  name: '024_native_app',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'users', 'apple_id'))) {
      await db.run(`ALTER TABLE users ADD COLUMN apple_id TEXT`);
    }
    if (!(await columnExists(db, 'users', 'apple_refresh_token_enc'))) {
      await db.run(`ALTER TABLE users ADD COLUMN apple_refresh_token_enc TEXT`);
    }
    await db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id ON users (apple_id) WHERE apple_id IS NOT NULL`
    );
    await db.run(`
      CREATE TABLE IF NOT EXISTS app_auth_handoff (
        nonce_hash TEXT PRIMARY KEY,
        token TEXT,
        error TEXT,
        expires_at INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_app_auth_handoff_expires ON app_auth_handoff (expires_at)`);
  },
};
