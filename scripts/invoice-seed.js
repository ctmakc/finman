#!/usr/bin/env node
// scripts/invoice-seed.js — puts ready invoice templates into Finman from a bundle file.
//
//   node scripts/invoice-seed.js <bundle.json> [--dry]
//
// bundle = {
//   profiles: [{ email, preset: '<key in OWNER_PRESETS>', name?, logo?, signature?, is_default? }],
//   shares:   [{ preset: '<key>', name?, logo?, signature? }]   // public template links, created_by NULL
// }
// logo/signature are data URLs, so company images live only in the bundle (outside the repo).
// Idempotent: a profile with the same name for the same user, or a share with the same name and
// no creator, is reported and left untouched. Prints share links.
'use strict';

const fs = require('fs');
const path = require('path');

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (!file) { console.error('usage: invoice-seed.js <bundle.json> [--dry]'); process.exit(64); }
  const bundle = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

  const db = require('../db/database');
  if (typeof db.initialize === 'function') await db.initialize();
  const { get } = db;
  const presets = require('../services/invoice/presets');
  const svc = require('../services/invoice/service');

  for (const p of bundle.profiles || []) {
    const preset = presets.OWNER_PRESETS[p.preset];
    if (!preset) throw new Error(`unknown preset ${p.preset}`);
    const user = await get('SELECT id FROM users WHERE lower(email) = lower(?)', [p.email]);
    if (!user) { console.log(`skip ${p.preset}: no user ${p.email}`); continue; }
    const name = p.name || preset.name;
    const has = await get('SELECT id FROM invoice_profiles WHERE user_id = ? AND name = ?', [user.id, name]);
    if (has) { console.log(`exists: user ${user.id} template #${has.id} "${name}"`); continue; }
    if (dry) { console.log(`would create: user ${user.id} "${name}"`); continue; }
    const prof = await svc.createProfile(user.id, {
      name, layout: preset.layout, currency: preset.currency, number_format: preset.number_format,
      next_seq: preset.next_seq || 1, due_days: preset.due_days, data: preset.data,
      logo: p.logo || null, signature: p.signature || null,
      ...(p.is_default !== undefined ? { is_default: p.is_default } : {}),
    });
    console.log(`created: user ${user.id} template #${prof.id} "${name}" logo=${prof.has_logo} signature=${prof.has_signature}`);
  }

  for (const s of bundle.shares || []) {
    const preset = presets.OWNER_PRESETS[s.preset];
    if (!preset) throw new Error(`unknown preset ${s.preset}`);
    const name = s.name || preset.name;
    const has = await get('SELECT code FROM invoice_template_shares WHERE created_by IS NULL AND name = ?', [name]);
    if (has) { console.log(`share exists: "${name}" ${svc.shareUrl(has.code)}`); continue; }
    if (dry) { console.log(`would share: "${name}"`); continue; }
    const code = await svc.insertShare(null, null, {
      name, layout: preset.layout, currency: preset.currency, number_format: preset.number_format,
      due_days: preset.due_days, data: preset.data, logo: s.logo || null, signature: s.signature || null,
    });
    console.log(`share created: "${name}" ${svc.shareUrl(code)}`);
  }
  if (typeof db.closeDatabase === 'function') await db.closeDatabase();
}

main().catch((e) => { console.error(e); process.exit(1); });
