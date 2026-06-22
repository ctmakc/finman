// 015 — investment depth (Ghostfolio gap): отдельные события по активу
// (дивиденды, комиссии, сплиты) для углублённой аналитики P&L.
//
// Хранятся ОТДЕЛЬНО от investment_transactions (buy/sell): события не меняют
// количество актива (кроме информационного 'split'), а влияют на чистый P&L:
//   net P&L = market value - cost - fees(tx + events) + dividends.
//
// ADDITIVE + идемпотентно (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
module.exports = {
  name: '015_invdepth',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS investment_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        investment_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        date TEXT NOT NULL,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (investment_id) REFERENCES investments (id) ON DELETE CASCADE
      )
    `);

    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_investment_events_investment
       ON investment_events (investment_id)`
    );
  },
};
