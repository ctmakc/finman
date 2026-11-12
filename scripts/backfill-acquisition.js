#!/usr/bin/env node
// scripts/backfill-acquisition.js — sources of accounts created before
// sign-up tracking existed, reconstructed from nginx logs (12.11.2026 review).
// Rows are marked backfilled=1: they show in the admin/digest, and lifecycle
// emails never go to these accounts. Idempotent (INSERT OR IGNORE).
//   node scripts/backfill-acquisition.js [--dry]
'use strict';
require('dotenv').config();
const { initDatabase, closeDatabase, run, get } = require('../db/database');

const ROWS = [
  // id, method, source, utm_source, utm_medium, utm_campaign, country
  [10, 'google', 'finman.money · cta budget-app-canada', 'finman.money', 'site', 'budget-app-canada', 'CA'],
  [11, 'google', 'finman.money · cta home', 'finman.money', 'site', 'home', 'PL'],
  [12, 'google', 'finman.money · cta home', 'finman.money', 'site', 'home', 'CA'],
  [13, 'google', 'direct (Google sign-in link)', null, null, null, 'CA'],
  [14, 'google', 'finman.money · cta home', 'finman.money', 'site', 'home', 'CA'],
  [15, 'google', 'chatgpt.com (AI)', 'chatgpt.com', null, null, 'IL'],
  [16, 'google', 'finman.money · cta home', 'finman.money', 'site', 'home', 'DE'],
  [17, 'password', 'finman.money · cta home', 'finman.money', 'site', 'home', 'US'],
];

(async () => {
  await initDatabase();
  const dry = process.argv.includes('--dry');
  let n = 0;
  for (const [id, method, source, us, um, uc, country] of ROWS) {
    const u = await get('SELECT id, created_at FROM users WHERE id = ?', [id]);
    if (!u) { console.log(`#${id} missing, skipped`); continue; }
    if (dry) { console.log(`#${id} ${method} ${source} ${country}`); continue; }
    const r = await run(
      `INSERT OR IGNORE INTO user_acquisition
         (user_id, method, source, utm_source, utm_medium, utm_campaign, country, backfilled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, method, source, us, um, uc, country, u.created_at],
    );
    n += r && r.changes ? r.changes : 0;
  }
  console.log(`backfill: ${n} rows added`);
  await closeDatabase();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
