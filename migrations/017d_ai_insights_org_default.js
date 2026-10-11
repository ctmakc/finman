// 017d — ai_insights.org_id gets DEFAULT 0 so per-user insights
// (services/financialInsights.js, wave3/ai) can be written without an
// organization. Production created the table with `org_id INTEGER NOT NULL`
// and no default; SQLite cannot change a column default in place, so a
// prod-shaped table is rebuilt (copy → drop → rename) with the rows kept.
// Idempotent: a table whose org_id already has a default is left alone.
//
// The runner (lib/migrate.js) wraps up() in BEGIN/COMMIT, so a failed
// rebuild rolls back completely. The copy keeps only rows whose user still
// exists: prod never enforced the FK, and an orphan row would violate the
// new table's FOREIGN KEY and block every boot.

const CANONICAL_DDL = (table) => `CREATE TABLE ${table} (
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
      )`;

// Rebuild ai_insights into the canonical shape. Works for the prod shape
// (org_id NOT NULL, no default) and for wave3/ai's 017b shape (no org_id at all;
// rows get org_id 0). Must run inside a transaction.
async function rebuildAiInsights(db) {
  const cols = await db.query(`PRAGMA table_info(ai_insights)`);
  const hasOrg = cols.some((c) => c.name === 'org_id');
  const has = (n) => cols.some((c) => c.name === n);
  const model = has('model') ? 'model' : 'NULL';
  const generatedAt = has('generated_at') ? 'generated_at' : 'CURRENT_TIMESTAMP';

  await db.run(`DROP TABLE IF EXISTS ai_insights__new`); // leftover of an earlier non-atomic run
  await db.run(CANONICAL_DDL('ai_insights__new'));
  await db.run(
    `INSERT OR IGNORE INTO ai_insights__new (id, org_id, user_id, period, type, content, model, generated_at)
       SELECT id, ${hasOrg ? 'COALESCE(org_id, 0)' : '0'}, user_id, period, type, content, ${model}, ${generatedAt}
         FROM ai_insights
        WHERE user_id IN (SELECT id FROM users)`
  );
  await db.run(`DROP TABLE ai_insights`);
  await db.run(`ALTER TABLE ai_insights__new RENAME TO ai_insights`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ai_insights_lookup ON ai_insights(org_id, user_id, period, type)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ai_insights_user_type ON ai_insights (user_id, type)`);
}

module.exports = {
  name: '017d_ai_insights_org_default',
  async up(db) {
    await db.run(`DROP TABLE IF EXISTS ai_insights__new`);
    const cols = await db.query(`PRAGMA table_info(ai_insights)`);
    if (!cols.length) return; // 017 always creates it; defensive
    const org = cols.find((c) => c.name === 'org_id');
    if (org && org.dflt_value !== null && org.dflt_value !== undefined) return;
    await rebuildAiInsights(db);
  },
  rebuildAiInsights,
};
