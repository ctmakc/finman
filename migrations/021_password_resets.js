// 021 — password reset tokens (ADDITIVE, idempotent).
//
// A reset link carries a random token; only its SHA-256 is stored, so a leaked
// database cannot be turned into working links. Tokens expire (expires_at) and
// are single-use (used_at). services/passwordResetService.js owns the rows.
module.exports = {
  name: '021_password_resets',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)`);
  },
};
