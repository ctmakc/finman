// 026 — MCP connector (ADDITIVE, idempotent).
//
// oauth_clients     OAuth 2.1 clients registered dynamically (RFC 7591) by MCP hosts
//                   (claude.ai, Claude Code, other MCP clients). Secret stored as sha-256.
// oauth_codes       one-time authorization codes (PKCE S256), 10 minutes, stored as sha-256.
// oauth_tokens      access (1 h) and refresh (60 days, rotating) tokens, stored as sha-256.
//                   `tv` = users.token_version at issue: a password change revokes them too.
// invoice_payments  payments against an invoice (full or partial, e.g. a 30 % deposit).
module.exports = {
  name: '026_mcp_oauth',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        client_name TEXT NOT NULL DEFAULT '',
        redirect_uris TEXT NOT NULL DEFAULT '[]',
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        resource TEXT,
        expires_at INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope TEXT NOT NULL DEFAULT '',
        resource TEXT,
        tv INTEGER NOT NULL DEFAULT 0,
        family TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_hash ON oauth_tokens (token_hash)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens (user_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family)`);
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        paid_on TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id)`);
  },
};
