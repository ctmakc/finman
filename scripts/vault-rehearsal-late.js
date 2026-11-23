#!/usr/bin/env node
// scripts/vault-rehearsal-late.js — rehearsal of the LATE move into Finman Vault on a COPY of the
// database: accounts that already have a vault but still hold rows of tables added to the vault
// later (the invoices, 23.11.2026).
//
//   DATABASE_PATH=/path/copy.db node scripts/vault-rehearsal-late.js [--only <userId>]
//
// Per account: hash of every such row before → legacy-export → into a vault engine (what
// public/js/vault/vault.js lateImport does) → hashes inside the engine must match → the vault is
// stored → scoped purge-legacy (counts re-checked by the server) → no such rows left on the
// server → the stored vault decrypts and still has the same hashes. The real vault of the account
// cannot be opened here (no key), so a test vault with one account stands in for it; on the copy
// only. Prints only counts and short hashes.
'use strict';

const path = require('path');
const crypto = require('crypto');

if (!process.env.DATABASE_PATH || /\/app\/data\/finman\.db$/.test(process.env.DATABASE_PATH)) {
  console.error('Set DATABASE_PATH to a COPY of the database.');
  process.exit(64);
}
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rehearsal-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'rehearsal-session-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.LIFECYCLE_EMAILS = '0';
process.env.ENGAGEMENT_EMAILS = '0';

const ROOT = path.join(__dirname, '..');
const only = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : null;
const norm = (v) => (v instanceof Uint8Array || Buffer.isBuffer(v) ? 'hex:' + Buffer.from(v).toString('hex') : v);
function hashRows(rows) {
  const lines = rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, norm(r[k])]))).sort();
  return { n: rows.length, h: crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16) };
}

(async () => {
  const supertest = require('supertest');
  const { initDatabase, query, get } = require(path.join(ROOT, 'db/database'));
  await initDatabase();
  const app = require(path.join(ROOT, 'server.js'));
  const { VAULT_TABLES, paramsFor } = require(path.join(ROOT, 'lib/vaultTables'));
  const vault = require(path.join(ROOT, 'services/vault'));
  const C = require(path.join(ROOT, 'public/js/vault/crypto'));
  const SQL = await require('sql.js')();
  const FEmod = require(path.join(ROOT, 'engine/dist/engine.node.cjs'));
  const FE = FEmod.FinmanEngine || FEmod;
  const req = supertest(app);
  for (let i = 0; i < 50; i++) {
    if (await get("SELECT name FROM sqlite_master WHERE type='table' AND name='invoice_links'").catch(() => null)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const jwt = require('jsonwebtoken');
  const cfg = require(path.join(ROOT, 'config/config'));
  const users = await query("SELECT id, email FROM users WHERE vault_state = 'active' ORDER BY id");
  let failures = 0; let moved = 0;
  for (const u of users) {
    if (only && u.id !== only) continue;
    const counts = await vault.legacyCounts(u.id);
    const pending = Object.entries(counts).filter(([, n]) => n > 0).map(([k]) => k);
    if (!pending.length) continue;
    const label = `user ${u.id} ${String(u.email).replace(/^(.{3}).*(@.*)$/, '$1…$2')}`;
    try {
      const pre = {};
      for (const t of VAULT_TABLES.filter((x) => pending.includes(x.name))) pre[t.name] = hashRows(await query(`SELECT * FROM ${t.name} WHERE ${t.where}`, paramsFor(t, u.id)));
      const tv = (await get('SELECT token_version FROM users WHERE id = ?', [u.id])).token_version || 0;
      const H = { Authorization: 'Bearer ' + jwt.sign({ id: u.id, tv: Number(tv) }, cfg.jwtSecret, { expiresIn: '1h' }) };
      const meta = (await req.get('/api/vault/meta').set(H)).body;
      const dump = (await req.get('/api/vault/legacy-export').set(H)).body;
      const tables = {}; const want = {};
      for (const [n, rows] of Object.entries(dump.tables || {})) if (rows.length) { tables[n] = rows; want[n] = rows.length; }
      // Stand-in for the account's own vault (its key is the user's): one account row.
      const eng = await FE.open({ SQL, bytes: null, user: { id: u.id, email: u.email } });
      await eng.handle({ method: 'POST', url: '/api/accounts', headers: {}, body: { name: 'Rehearsal', currency: 'CAD', balance: 0 } });
      const r = await eng.importLegacy({ tables });
      const diffs = [];
      for (const n of Object.keys(want)) {
        if (r.counts[n] !== want[n]) diffs.push(`${n}: imported ${r.counts[n]} of ${want[n]}`);
        const t = VAULT_TABLES.find((x) => x.name === n);
        const h = hashRows(await eng.query(`SELECT * FROM ${n} WHERE ${t.where}`, paramsFor(t, u.id)));
        if (h.n !== pre[n].n || h.h !== pre[n].h) diffs.push(`${n}: before ${pre[n].n}/${pre[n].h} engine ${h.n}/${h.h}`);
      }
      const vk = C.newVaultKey();
      const blob = await C.encryptVault(vk, eng.export(), u.id);
      eng.close();
      const put = await req.put('/api/vault/blob').set(H).set('If-Match', String(meta.version)).set('Content-Type', 'application/octet-stream').send(Buffer.from(blob));
      if (put.status !== 200) throw new Error('blob ' + put.status + ' ' + JSON.stringify(put.body));
      const purge = await req.post('/api/vault/purge-legacy').set(H).send({ counts: want, scope: Object.keys(want) });
      if (purge.status !== 200) throw new Error('purge ' + purge.status + ' ' + JSON.stringify(purge.body).slice(0, 300));
      const left = Object.entries(await vault.legacyCounts(u.id)).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
      const v = await get('SELECT blob FROM user_vaults WHERE user_id = ?', [u.id]);
      const back = await FE.open({ SQL, bytes: await C.decryptVault(vk, new Uint8Array(v.blob), u.id), user: { id: u.id } });
      for (const n of Object.keys(want)) {
        const t = VAULT_TABLES.find((x) => x.name === n);
        const h = hashRows(await back.query(`SELECT * FROM ${n} WHERE ${t.where}`, paramsFor(t, u.id)));
        if (h.h !== pre[n].h) diffs.push(`${n}: stored vault ${h.n}/${h.h}`);
      }
      back.close();
      const ok = !diffs.length && !left.length;
      if (!ok) failures++; else moved++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${Object.entries(pre).map(([k, x]) => `${k}=${x.n}/${x.h}`).join(' ')}${diffs.length ? ' | ' + diffs.join('; ') : ''}${left.length ? ' | left ' + left.join(',') : ''}`);
    } catch (e) {
      failures++;
      console.log(`FAIL ${label} ERROR ${e.message}`);
    }
  }
  const rest = {};
  for (const t of ['invoice_profiles', 'invoices', 'invoice_payments', 'invoice_repeats']) {
    rest[t] = (await get(`SELECT COUNT(*) n FROM ${t} WHERE user_id IN (SELECT id FROM users WHERE vault_state = 'active')`)).n;
  }
  console.log(`\nvault accounts moved: ${moved}, failed: ${failures}; invoice rows left on the server for vault accounts: ${JSON.stringify(rest)}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
