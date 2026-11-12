// 021 — where users come from and what they do (ADDITIVE, idempotent).
//
// user_acquisition  one row per user: sign-up method + first/last touch
//                   (utm_*, click ids, referrer, landing, the finman.money page
//                   that sent them), IP country, device, browser tz/lang.
//                   backfilled = 1 marks rows reconstructed from old logs.
// analytics_events  our own event journal (server-side; mirrored to the
//                   self-hosted OpenPanel when it is configured).
// lifecycle_emails  which lifecycle/digest emails went out (once per kind).
// users.lifecycle_opt_out  unsubscribe flag for lifecycle emails.
module.exports = {
  name: '021_acquisition_analytics',
  async up(db, { columnExists }) {
    await db.run(`CREATE TABLE IF NOT EXISTS user_acquisition (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      method TEXT,
      source TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
      gclid TEXT, fbclid TEXT, msclkid TEXT,
      referrer TEXT, landing TEXT,
      site_referrer TEXT, site_landing TEXT,
      first_touch TEXT, last_touch TEXT,
      anon_id TEXT,
      ip TEXT, country TEXT, city TEXT, user_agent TEXT, device TEXT,
      tz TEXT, lang TEXT,
      first_seen_at TEXT, form_ms INTEGER,
      backfilled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      anon_id TEXT,
      event TEXT NOT NULL,
      props TEXT,
      path TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id, created_at)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events(event, created_at)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_analytics_events_anon ON analytics_events(anon_id)');
    await db.run(`CREATE TABLE IF NOT EXISTS lifecycle_emails (
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, kind)
    )`);
    if (!(await columnExists(db, 'users', 'lifecycle_opt_out'))) {
      await db.run('ALTER TABLE users ADD COLUMN lifecycle_opt_out INTEGER NOT NULL DEFAULT 0');
    }
  },
};
