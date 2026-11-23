// 034 — repeating invoices (ADDITIVE, idempotent).
// invoice_repeats: "make a new draft from this invoice every month". The rule points at the
// invoice it copies; next_date is the issue date of the next draft. Drafts only: Finman never
// sends anything to the client by itself.
module.exports = {
  name: '034_invoice_repeat',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoice_repeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        every TEXT NOT NULL DEFAULT 'month',
        next_date TEXT NOT NULL,
        made INTEGER NOT NULL DEFAULT 0,
        last_invoice_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_repeats_invoice ON invoice_repeats (invoice_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_invoice_repeats_next ON invoice_repeats (next_date)');
  },
};
