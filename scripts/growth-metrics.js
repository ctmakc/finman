#!/usr/bin/env node
// scripts/growth-metrics.js — sign-ups, the path to the first report, activation and returns
// from the event journal (services/growthMetrics.js does the counting; aggregates only).
//
// Usage (prod): docker exec -e NODE_PATH=/app/node_modules -w /app finman node scripts/growth-metrics.js [--since 2026-11-03] [--json]
// Local: node scripts/growth-metrics.js --db path/to/finance.db
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');
const gm = require('../services/growthMetrics');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SINCE = opt('--since', '2026-11-03');
const DB = opt('--db', process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'finance.db'));

(async () => {
  const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
  const query = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const m = await gm.load({ query, since: SINCE });
  db.close();
  if (args.includes('--json')) { console.log(JSON.stringify(m, null, 2)); return; }
  console.log(gm.describe(m).join('\n'));
})().catch((e) => { console.error(e.message); process.exit(1); });
