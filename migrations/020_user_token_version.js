// 020 — token version per user (ADDITIVE, idempotent).
//
// JWTs carry tv = users.token_version. Changing the password bumps the version,
// so tokens issued before the change stop working (a stolen 24 h token no
// longer survives a password reset). Tokens without tv count as version 0.
module.exports = {
  name: '020_user_token_version',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'users', 'token_version'))) {
      await db.run(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`);
    }
  },
};
