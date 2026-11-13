// 023 — engagement funnel (ADDITIVE, idempotent).
//
// user_milestones     one row per (user, key) the first time it happens:
//                     activated, week1_active, week4_active, step_<journey step>,
//                     badge_<streak/journey badge>, weekly_review_seen:<week>.
//                     Each new row is also an OpenPanel event (services/journey.js),
//                     so the funnel sign_up → activated → week1_active → week4_active
//                     is built from it.
// push_subscriptions  Web Push endpoints of the PWA (one per browser/device).
// users.ref_code      personal invite code (lazy, routes/engagement.js).
// users.referred_by   who invited this user (fm_ref=invite-<code> at sign-up).
module.exports = {
  name: '023_engagement',
  async up(db, { columnExists }) {
    await db.run(`CREATE TABLE IF NOT EXISTS user_milestones (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      props TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    )`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_user_milestones_key ON user_milestones(key, at)');
    await db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_ok_at TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0
    )`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)');
    if (!(await columnExists(db, 'users', 'ref_code'))) {
      await db.run('ALTER TABLE users ADD COLUMN ref_code TEXT');
    }
    if (!(await columnExists(db, 'users', 'referred_by'))) {
      await db.run('ALTER TABLE users ADD COLUMN referred_by INTEGER');
    }
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code)');
  },
};
