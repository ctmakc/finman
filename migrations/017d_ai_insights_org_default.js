// 017d — ai_insights.org_id gets DEFAULT 0 so per-user insights
// (services/financialInsights.js, wave3/ai) can be written without an
// organization. Production created the table with `org_id INTEGER NOT NULL`
// and no default; SQLite cannot change a column default in place, so a
// prod-shaped table is rebuilt (copy → drop → rename) with the rows kept.
// Idempotent: a table whose org_id already has a default is left alone.
module.exports = {
  name: '017d_ai_insights_org_default',
  async up(db) {
    const cols = await db.query(`PRAGMA table_info(ai_insights)`);
    if (!cols.length) return; // 017 always creates it; defensive
    const org = cols.find((c) => c.name === 'org_id');
    if (!org || (org.dflt_value !== null && org.dflt_value !== undefined)) return;

    await db.run(`CREATE TABLE ai_insights__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER NOT NULL,
        period TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, user_id, period, type),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    await db.run(`INSERT INTO ai_insights__new (id, org_id, user_id, period, type, content, model, generated_at)
                  SELECT id, org_id, user_id, period, type, content, model, generated_at FROM ai_insights`);
    await db.run(`DROP TABLE ai_insights`);
    await db.run(`ALTER TABLE ai_insights__new RENAME TO ai_insights`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_ai_insights_lookup ON ai_insights(org_id, user_id, period, type)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_ai_insights_user_type ON ai_insights (user_id, type)`);
  },
};
