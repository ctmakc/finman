#!/usr/bin/env node
// scripts/seed-demo.js — seed the demo household by hand (lib/demoSeed.js).
//
//   node scripts/seed-demo.js            # seeds only when the users table is empty
//   node scripts/seed-demo.js --force    # seeds when the demo user is missing, even
//                                        # if other users exist (local dev / previews)
//
// Reads DATABASE_PATH / DEMO_PASSWORD from the environment (.env is loaded).
// The server does the same at boot when DEMO_SEED_ON_EMPTY=1; this script is for
// a local checkout or a one-off refresh. Prints one JSON line with the result.
// Never run it against app.finman.money.

'use strict';

require('dotenv').config();

const force = process.argv.includes('--force');

(async () => {
  const { initDatabase, closeDatabase } = require('../db/database');
  const demoSeed = require('../lib/demoSeed');
  await initDatabase();
  const result = await demoSeed.seedDemo({ force });
  console.log(JSON.stringify(result));
  await closeDatabase();
  process.exit(result.seeded || result.reason === 'demo_exists' ? 0 : 2);
})().catch((err) => {
  console.error('seed-demo failed:', err && err.message);
  process.exit(1);
});
