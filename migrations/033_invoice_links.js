// 033 — public invoice links (ADDITIVE, idempotent).
//
// invoice_links  one link per published invoice. The issuer chose to publish THIS invoice: the row
//                holds a snapshot of exactly what the client page and its PDF show (seller, client,
//                lines, totals, the issuer's own payment details, paid so far). The invoice itself
//                lives wherever the account keeps its data (server tables or the encrypted vault);
//                invoice_id is the issuer's own invoice id, with no foreign key to any server table.
//                The browser re-publishes the snapshot when the invoice changes.
//                first/last_viewed_at + view_count come from the page's beacon (a browser that ran
//                the page; link previews of messengers do not run it).
//                revoked_at: the issuer turned the link off; the page answers 410.
module.exports = {
  name: '033_invoice_links',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoice_links (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invoice_id INTEGER NOT NULL,
        snapshot TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        first_viewed_at DATETIME,
        last_viewed_at DATETIME,
        view_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_links_user_invoice ON invoice_links (user_id, invoice_id)');
  },
};
