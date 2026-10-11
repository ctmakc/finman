// 017 — production parity: organizations / members / invites / ai_insights,
// users.google_id + avatar_url + org_id, and the 15 performance indexes that
// app.finman.money (prod lineage, db/database.js ~940-1032) created inline
// with unguarded ALTERs. ADDITIVE and idempotent: CREATE … IF NOT EXISTS and
// columnExists() guards, so it is a no-op on a DB that prod already shaped,
// and a full apply on a fresh wave2 DB. Both end with the same objects.
//
// Deliberately NOT ported: prod's `ai_chat_sessions` (wave2 keeps chat in
// ai_conversations / ai_messages from migration 002; prod sessions held no
// user data worth keeping — 0 transactions at audit time).
module.exports = {
  name: '017_org_google_indexes',
  async up(db, { columnExists }) {
    // ==================== ORGANIZATIONS (SaaS) — DDL verbatim from prod ====
    await db.run(`CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        plan TEXT DEFAULT 'free',
        ai_provider TEXT DEFAULT NULL,
        ai_model TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

    await db.run(`CREATE TABLE IF NOT EXISTS organization_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(org_id, user_id)
      )`);

    await db.run(`CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'member',
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
      )`);

    // org_id defaults to 0 ("no organization"): wave3 insights are per user
    // (services/financialInsights.js inserts without org_id). Prod rows keep
    // their org_id; 017d rebuilds a prod-shaped table to add this default.
    await db.run(`CREATE TABLE IF NOT EXISTS ai_insights (
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

    // A DB that already ran wave3/ai's 017b (it sorts after 017_ but was
    // merged first) has ai_insights WITHOUT org_id: the CREATE above was a
    // no-op and idx_ai_insights_lookup below would fail with "no such column".
    // Rebuild it into the canonical shape (rows kept with org_id 0).
    if (!(await columnExists(db, 'ai_insights', 'org_id'))) {
      await require('./017d_ai_insights_org_default').rebuildAiInsights(db);
    }

    // ==================== users: Google sign-in + org link ==================
    if (!(await columnExists(db, 'users', 'google_id'))) {
      await db.run(`ALTER TABLE users ADD COLUMN google_id TEXT`);
    }
    if (!(await columnExists(db, 'users', 'avatar_url'))) {
      await db.run(`ALTER TABLE users ADD COLUMN avatar_url TEXT`);
    }
    if (!(await columnExists(db, 'users', 'org_id'))) {
      await db.run(`ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES organizations(id)`);
    }
    // Partial unique index: many NULLs allowed, each google_id at most once.
    await db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL`
    );

    // ==================== 15 performance indexes (prod list, verbatim) ======
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id, type)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_user_category ON transactions(user_id, category)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id)`,
      `CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_payments(user_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, is_active, next_billing_date)`,
      `CREATE INDEX IF NOT EXISTS idx_goals_user ON savings_goals(user_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_user_type_date ON transactions(user_id, type, date)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_insights_lookup ON ai_insights(org_id, user_id, period, type)`,
      `CREATE INDEX IF NOT EXISTS idx_sub_payments_sub ON subscription_payments(subscription_id, payment_date DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id, event_date)`,
    ];
    for (const sql of indexes) {
      await db.run(sql);
    }
  },
};

module.exports.PERF_INDEX_NAMES = [
  'idx_transactions_user_date', 'idx_transactions_user_type', 'idx_transactions_user_category',
  'idx_transactions_account', 'idx_budgets_user', 'idx_notifications_user', 'idx_recurring_user',
  'idx_accounts_user', 'idx_subscriptions_user', 'idx_goals_user', 'idx_debts_user',
  'idx_transactions_user_type_date', 'idx_ai_insights_lookup', 'idx_sub_payments_sub',
  'idx_calendar_events_user',
];
