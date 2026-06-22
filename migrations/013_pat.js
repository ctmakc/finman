// 013 — Personal Access Tokens (публичный REST API). ADDITIVE, идемпотентно.
// Хранит ТОЛЬКО хэш токена (sha-256), сам plaintext показывается один раз при
// создании и больше нигде не хранится.
module.exports = {
  name: '013_pat',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        last_used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // Поиск по хэшу при verify — частый горячий путь.
    await db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pat_token_hash ON personal_access_tokens (token_hash)`
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens (user_id)`
    );
  },
};
