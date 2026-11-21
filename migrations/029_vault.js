// 028 — Finman Vault, end-to-end encryption (ADDITIVE, idempotent). docs/E2E-ENCRYPTION.md
//
// users.kdf          'legacy' = bcrypt(raw password); 'fm1' = the browser derives a key with
//                    Argon2id(kdf_salt, kdf_params) and sends only authToken ('fm1$' + hex).
// users.kdf_salt     16 random bytes, base64. Public: POST /api/auth/prelogin hands it out.
// users.kdf_params   JSON {"alg":"argon2id","m":65536,"t":3,"p":1,"len":32}.
// users.vault_state  'none' until the plaintext rows are purged, then 'active'.
// user_vaults        one encrypted SQLite file per user (AES-256-GCM, key only in the browser);
//                    wrapped_pw / wrapped_rc = the vault key wrapped by the password / recovery key.
// vault_grants       consent-MCP (§6.3): vault key wrapped by a secret that lives only inside the
//                    token given to the AI app; the server keeps the wrap and the token hash.
// Both tables have user_id, so services/accountDeletion.js sweeps them with the account.
module.exports = {
  name: '029_vault',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'users', 'kdf'))) {
      await db.run(`ALTER TABLE users ADD COLUMN kdf TEXT NOT NULL DEFAULT 'legacy'`);
    }
    if (!(await columnExists(db, 'users', 'kdf_salt'))) {
      await db.run('ALTER TABLE users ADD COLUMN kdf_salt TEXT');
    }
    if (!(await columnExists(db, 'users', 'kdf_params'))) {
      await db.run('ALTER TABLE users ADD COLUMN kdf_params TEXT');
    }
    if (!(await columnExists(db, 'users', 'vault_state'))) {
      await db.run(`ALTER TABLE users ADD COLUMN vault_state TEXT NOT NULL DEFAULT 'none'`);
    }
    await db.run(`
      CREATE TABLE IF NOT EXISTS user_vaults (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        blob BLOB NOT NULL,
        size INTEGER NOT NULL,
        wrapped_pw TEXT,
        wrapped_rc TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS vault_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        wrapped_vk TEXT NOT NULL,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        revoked_at DATETIME
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_vault_grants_user ON vault_grants (user_id)');
  },
};
