// 035 — encrypted one-time PDF drops for AI chats on vault accounts (ADDITIVE, idempotent).
// mcp_pdf_drops: an invoice PDF made during a consented MCP tool call, stored only as AES-256-GCM
// ciphertext (file name inside). The key lives in the link's #fragment, which browsers never send
// to the server; the server cannot open the file. Expires after 7 days.
module.exports = {
  name: '035_mcp_pdf_drops',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS mcp_pdf_drops (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blob BLOB NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
      )
    `);
    await db.run('CREATE INDEX IF NOT EXISTS idx_mcp_pdf_drops_exp ON mcp_pdf_drops (expires_at)');
  },
};
