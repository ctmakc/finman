// 033 — public invoice links (ADDITIVE, idempotent).
//
// invoice_links  one link per invoice: the issuer chose to publish THIS invoice to its client.
//                The client opens /i/<token> without an account: the invoice, the PDF and the
//                issuer's own payment details (card link, PayPal.me, e-Transfer, bank). Finman
//                never takes the money and never emails the client.
//                first/last_viewed_at + view_count come from the page's beacon (a real browser
//                that ran the page; link previews of messengers do not run it).
//                revoked_at: the issuer turned the link off; the page answers 410.
module.exports = {
  name: '033_invoice_links',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoice_links (
        token TEXT PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        first_viewed_at DATETIME,
        last_viewed_at DATETIME,
        view_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_links_invoice ON invoice_links (invoice_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_invoice_links_user ON invoice_links (user_id)');
  },
};
