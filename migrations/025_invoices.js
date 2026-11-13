// 025 — invoicing (ADDITIVE, idempotent).
//
// invoice_profiles         a user's invoice template: seller block, bank block, tax line,
//                          terms, numbering, optional logo/signature (data URLs).
// invoices                 issued invoices. `snapshot` freezes the template (text + images)
//                          at creation, so editing a template never rewrites an issued invoice.
// invoice_template_shares  a template shared by link (?tpl=<code>); importing copies it into
//                          the importer's own invoice_profiles.
module.exports = {
  name: '025_invoices',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoice_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        layout TEXT NOT NULL DEFAULT 'classic',
        currency TEXT NOT NULL DEFAULT 'USD',
        number_format TEXT NOT NULL DEFAULT '{SEQ}',
        next_seq INTEGER NOT NULL DEFAULT 1,
        due_days INTEGER NOT NULL DEFAULT 14,
        data TEXT NOT NULL DEFAULT '{}',
        logo TEXT,
        signature TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        source_share TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_invoice_profiles_user ON invoice_profiles (user_id)`);
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_id INTEGER REFERENCES invoice_profiles(id) ON DELETE SET NULL,
        number TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        issue_date TEXT NOT NULL,
        due_date TEXT,
        currency TEXT NOT NULL,
        client_name TEXT NOT NULL DEFAULT '',
        client_details TEXT NOT NULL DEFAULT '',
        items TEXT NOT NULL DEFAULT '[]',
        tax_rate REAL,
        tax_label TEXT,
        tax_sub TEXT,
        tax_text TEXT,
        subtotal_cents INTEGER NOT NULL DEFAULT 0,
        tax_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        terms TEXT,
        notes TEXT,
        snapshot TEXT NOT NULL DEFAULT '{}',
        sent_at DATETIME,
        paid_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_user_number ON invoices (user_id, number)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_user_date ON invoices (user_id, issue_date)`);
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoice_template_shares (
        code TEXT PRIMARY KEY,
        created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
        profile_id INTEGER,
        name TEXT NOT NULL,
        layout TEXT NOT NULL,
        currency TEXT NOT NULL,
        number_format TEXT NOT NULL,
        due_days INTEGER NOT NULL,
        data TEXT NOT NULL,
        logo TEXT,
        signature TEXT,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  },
};
