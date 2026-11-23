#!/usr/bin/env node
// scripts/vault-rehearsal.js — репетиция перехода на Finman Vault на КОПИИ базы.
//
//   DATABASE_PATH=/path/copy.db node scripts/vault-rehearsal.js [--only <userId>]
//
// Для каждого пользователя делает то же, что браузер при входе (docs/E2E-ENCRYPTION.md §5):
// вход → legacy-export → локальная база в движке → шифрование → /api/vault/setup →
// /api/vault/purge-legacy. Затем скачивает сейф, расшифровывает и сверяет содержимое
// каждой таблицы с тем, что было в базе ДО (хеш всех строк), проверяет, что открытых
// строк пользователя на сервере не осталось и что вход теперь идёт по authToken.
// ВНИМАНИЕ: меняет хеши паролей в копии (нужно для входа) — только для копии базы.
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

function norm(v) {
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return 'hex:' + Buffer.from(v).toString('hex');
  return v;
}
function hashRows(rows) {
  const lines = rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, norm(r[k])]))).sort();
  return { n: rows.length, h: crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16) };
}

(async () => {
  const supertest = require('supertest');
  const bcrypt = require('bcrypt');
  const { initDatabase, query, get, run } = require(path.join(ROOT, 'db/database'));
  await initDatabase();
  const app = require(path.join(ROOT, 'server.js'));
  const { VAULT_TABLES, paramsFor } = require(path.join(ROOT, 'lib/vaultTables'));
  const C = require(path.join(ROOT, 'public/js/vault/crypto'));
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const FEmod = require(path.join(ROOT, 'engine/dist/engine.node.cjs'));
  const FE = FEmod.FinmanEngine || FEmod;
  const req = supertest(app);
  // дождаться миграций сервера (server.js запускает их при старте)
  for (let i = 0; i < 50; i++) {
    const t = await get("SELECT name FROM sqlite_master WHERE type='table' AND name='user_vaults'").catch(() => null);
    if (t) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const snapshot = async (uid) => {
    const out = {};
    for (const t of VAULT_TABLES) out[t.name] = hashRows(await query(`SELECT * FROM ${t.name} WHERE ${t.where}`, paramsFor(t, uid)));
    return out;
  };
  const totals = async () => {
    const out = {};
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    for (const { name } of tables) out[name] = (await get(`SELECT COUNT(*) n FROM "${name}"`)).n;
    return out;
  };

  const before = await totals();
  const users = await query('SELECT id, email, username, password, google_id, apple_id FROM users ORDER BY id');
  const report = [];
  let failures = 0;

  for (const u of users) {
    if (only && u.id !== only) continue;
    // Accounts that already have a vault: see scripts/vault-rehearsal-late.js.
    if (process.argv.includes('--legacy-only') && (await get('SELECT vault_state FROM users WHERE id = ?', [u.id])).vault_state === 'active') continue;
    const row = { id: u.id, email: String(u.email).replace(/^(.{3}).*(@.*)$/, '$1…$2'), rows: 0, ok: false, note: '' };
    try {
      const pre = await snapshot(u.id);
      row.rows = Object.values(pre).reduce((s, x) => s + x.n, 0);
      const pw = 'Rehearsal-' + u.id + '-pw';
      await run('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(pw, 4), u.id]);
      // Session token minted directly (the login route is rate-limited to 5 per 15 min).
      const jwt = require('jsonwebtoken');
      const cfg = require(path.join(ROOT, 'config/config'));
      const tv = (await get('SELECT token_version FROM users WHERE id = ?', [u.id])).token_version || 0;
      let token = jwt.sign({ id: u.id, tv: Number(tv) }, cfg.jwtSecret, { expiresIn: '1h' });
      const auth = () => ({ Authorization: 'Bearer ' + token });
      const meta = (await req.get('/api/vault/meta').set(auth())).body;
      const dump = (await req.get('/api/vault/legacy-export').set(auth())).body;
      const eng = await FE.open({ SQL, bytes: null, user: dump.user || { id: u.id, email: u.email } });
      await eng.importLegacy({ tables: dump.tables || {}, user: dump.user });
      const counts = eng.counts();
      const salt = C.newSalt();
      const master = await C.deriveMaster(pw, salt, C.DEFAULT_PARAMS);
      const vk = C.newVaultKey();
      const rk = C.newRecoveryKey();
      const blob = await C.encryptVault(vk, eng.export(), u.id);
      eng.close();
      const body = {
        blob_b64: C.b64(blob),
        wrapped_pw: await C.wrap(await C.kekFromMaster(master), vk, C.wrapAad(u.id, 'pw')),
        wrapped_rc: await C.wrap(await C.kekFromRecovery(rk.bytes), vk, C.wrapAad(u.id, 'rc')),
        kdf_salt: salt, kdf_params: JSON.stringify(C.DEFAULT_PARAMS),
      };
      if (meta.hasPassword) { body.auth_token = await C.authToken(master); body.current_password = pw; }
      const setup = await req.post('/api/vault/setup').set(auth()).send(body);
      if (setup.status !== 200 && setup.status !== 201) throw new Error('setup ' + setup.status + ' ' + JSON.stringify(setup.body));
      if (setup.body.token) token = setup.body.token;
      const purge = await req.post('/api/vault/purge-legacy').set(auth()).send({ counts });
      if (purge.status !== 200) throw new Error('purge ' + purge.status + ' ' + JSON.stringify(purge.body).slice(0, 300));

      // проверка: сейф открывается и содержит те же строки
      const got = await req.get('/api/vault/blob').set(auth()).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
      const back = await FE.open({ SQL, bytes: await C.decryptVault(vk, new Uint8Array(got.body), u.id), user: dump.user });
      const diffs = [];
      for (const t of VAULT_TABLES) {
        if (!back.query) { diffs.push('engine has no query()'); break; }
        let rows;
        try {
          rows = await back.query(`SELECT * FROM ${t.name} WHERE ${t.where}`, paramsFor(t, u.id));
        } catch (e) {
          if (!/no such table/.test(e.message)) throw e;
          rows = []; // table absent in the engine schema = it had no rows to carry
        }
        const h = hashRows(rows);
        if (h.n !== pre[t.name].n || h.h !== pre[t.name].h) diffs.push(`${t.name}: before ${pre[t.name].n}/${pre[t.name].h} after ${h.n}/${h.h}`);
      }
      back.close();
      // проверка: открытых строк на сервере нет
      const left = Object.entries(await snapshot(u.id)).filter(([, x]) => x.n > 0).map(([k, x]) => `${k}=${x.n}`);
      // проверка: старый пароль больше не входит, authToken входит
      const User = require(path.join(ROOT, 'models/user'));
      const fresh = await get('SELECT * FROM users WHERE id = ?', [u.id]);
      const oldLogin = meta.hasPassword ? ((await User.verifyPassword(fresh, pw)) ? 200 : 401) : 'n/a';
      const newLogin = meta.hasPassword ? ((await User.verifyPassword(fresh, await C.authToken(master))) ? 200 : 401) : 'n/a';
      const stateRow = await get('SELECT vault_state, kdf FROM users WHERE id = ?', [u.id]);
      row.ok = diffs.length === 0 && left.length === 0 && stateRow.vault_state === 'active' &&
        (!meta.hasPassword || (oldLogin === 401 && newLogin === 200));
      row.note = [diffs.join('; '), left.length ? 'left: ' + left.join(',') : '', `state=${stateRow.vault_state} kdf=${stateRow.kdf} old=${oldLogin} new=${newLogin} vault=${blob.length}B`].filter(Boolean).join(' | ');
    } catch (e) {
      row.note = 'ERROR ' + e.message;
    }
    if (!row.ok) failures++;
    report.push(row);
    console.log(`${row.ok ? 'OK  ' : 'FAIL'} user ${row.id} ${row.email} rows=${row.rows} ${row.note}`);
  }

  const after = await totals();
  console.log('\nTable totals before → after (vault tables should drop to 0 for migrated users; others unchanged except users/user_vaults/analytics):');
  for (const k of Object.keys({ ...before, ...after }).sort()) {
    if (before[k] !== after[k]) console.log(`  ${k}: ${before[k] ?? '-'} → ${after[k] ?? '-'}`);
  }
  const vaults = await get('SELECT COUNT(*) n, SUM(size) bytes FROM user_vaults');
  console.log(`\nusers: ${report.length}, ok: ${report.length - failures}, failed: ${failures}; vaults: ${vaults.n} (${vaults.bytes} bytes)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
