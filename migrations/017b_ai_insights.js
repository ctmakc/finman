// 017b — ai_insights: per-user cache of generated AI stories (PORT_PLAN A8).
// ADDITIVE and idempotent. Mirrors production's ai_insights table minus org_id
// (wave2 scopes by user_id; an org dimension can be added by a later migration).
//   type   : 'monthly' | 'weekly' | ...
//   period : 'YYYY-MM' for monthly, 'YYYY-MM-DD' (week start) for weekly
//   content: JSON string of the cached insight
module.exports = {
  name: '017b_ai_insights',
  async up(db) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        period TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, period, type),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_ai_insights_user_type ON ai_insights (user_id, type)`
    );
  },
};
