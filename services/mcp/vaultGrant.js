// services/mcp/vaultGrant.js — MCP-доступ ИИ-чата к зашифрованному сейфу по явному
// согласию (docs/E2E-ENCRYPTION.md §6.3).
//
// На странице «Разрешить» браузер (сейф открыт) создаёт grantSecret и заворачивает им
// ключ сейфа. Сервер хранит только обёртку (vault_grants.wrapped_vk) и хеши токенов;
// сам grantSecret живёт внутри токенов, выданных ИИ-приложению (суффикс ".v.<secret>").
// Вызов инструмента: секрет из токена → ключ сейфа → расшифровка в памяти → движок
// Finman (тот же код, что в браузере) → при записи шифруем и сохраняем новую версию.
// Отключение приложения удаляет обёртку: прочитать сейф больше нечем.
'use strict';

const { get, run } = require('../../db/database');
const FMCrypto = require('../../public/js/vault/crypto');

const SEP = '.v.';
const CODE_TTL_MS = 10 * 60 * 1000;
const pendingByCode = new Map(); // sha(code) -> { wrapped, secret, exp }

function famKey(family) { return 'fam:' + String(family); }

function stashForCode(codeHash, wrapped, secret) {
  if (typeof wrapped !== 'string' || !/^w1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(wrapped)) return false;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
  const now = Date.now();
  for (const [k, v] of pendingByCode) if (v.exp < now) pendingByCode.delete(k);
  pendingByCode.set(codeHash, { wrapped, secret, exp: now + CODE_TTL_MS });
  return true;
}

function takeForCode(codeHash) {
  const v = pendingByCode.get(codeHash);
  pendingByCode.delete(codeHash);
  if (!v || v.exp < Date.now()) return null;
  return v;
}

function withSecret(token, secret) { return secret ? token + SEP + secret : token; }
function secretOf(token) {
  const s = String(token || '');
  const i = s.lastIndexOf(SEP);
  if (i < 0) return null;
  const sec = s.slice(i + SEP.length);
  return /^[A-Za-z0-9_-]{43}$/.test(sec) ? sec : null;
}

async function saveGrant(userId, family, wrapped, label) {
  await run(
    `INSERT INTO vault_grants (user_id, token_hash, wrapped_vk, label) VALUES (?, ?, ?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET wrapped_vk = excluded.wrapped_vk, revoked_at = NULL`,
    [userId, famKey(family), wrapped, label || null]);
}

async function revokeFamily(family) {
  await run('DELETE FROM vault_grants WHERE token_hash = ?', [famKey(family)]).catch(() => {});
}

async function vaultActive(userId) {
  const u = await get('SELECT vault_state FROM users WHERE id = ?', [userId]).catch(() => null);
  return !!(u && u.vault_state === 'active');
}

let enginePromise = null;
function engineLib() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const FE = require('../../engine/dist/engine.node.cjs');
      return { SQL, FE: FE.FinmanEngine || FE.default || FE };
    })();
  }
  return enginePromise;
}

class VaultLockedError extends Error {
  constructor(msg) { super(msg); this.code = 'VAULT_LOCKED'; }
}

// fn(engine) → result. Ключ и открытая база живут только в этом вызове.
async function withVault(userId, family, secret, fn) {
  if (!secret || !family) throw new VaultLockedError('Your Finman data is end-to-end encrypted. Disconnect Finman in this app, connect it again and press Allow while signed in to Finman, so this app gets its own key.');
  const g = await get('SELECT wrapped_vk FROM vault_grants WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL', [famKey(family), userId]);
  if (!g) throw new VaultLockedError('Access to your encrypted data was turned off. Connect Finman again to allow it.');
  const user = await get('SELECT id, username, email, full_name, timezone, subscription_tier, created_at FROM users WHERE id = ?', [userId]);
  const { SQL, FE } = await engineLib();
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await get('SELECT version, blob FROM user_vaults WHERE user_id = ?', [userId]);
    if (!v) throw new VaultLockedError('Your encrypted vault was not found.');
    let vk = await FMCrypto.unwrap(await FMCrypto.kekFromGrant(Buffer.from(secret, 'base64url')), g.wrapped_vk, FMCrypto.wrapAad(userId, 'grant'));
    let bytes = await FMCrypto.decryptVault(vk, new Uint8Array(v.blob), userId);
    const eng = await FE.open({ SQL, bytes, user });
    bytes = null;
    try {
      const out = await fn(eng);
      if (!eng.dirty) return out;
      const blob = await FMCrypto.encryptVault(vk, eng.export(), userId);
      const r = await run(
        'UPDATE user_vaults SET blob = ?, size = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND version = ?',
        [Buffer.from(blob), blob.length, userId, v.version]);
      if (r.changes === 1) return out;
      // Пользователь как раз сохранил с другого устройства — повторяем на свежей версии.
    } finally {
      try { eng.close(); } catch (_) { /* ignore */ }
      vk.fill(0); vk = null;
    }
  }
  throw new Error('The vault changed while the tool ran. Try again.');
}

// Инструменты над данными сейфа (счета, транзакции…) — в движке; инвойсы — на сервере.
let localTools = null;
function isLocalTool(name) {
  if (!localTools) {
    const FE = require('../../engine/dist/engine.node.cjs');
    const list = (FE.FinmanEngine || FE).MCP_LOCAL_TOOLS || FE.MCP_LOCAL_TOOLS;
    if (!Array.isArray(list)) return true;
    localTools = new Set(list);
  }
  return localTools.has(name);
}

module.exports = { isLocalTool, SEP, stashForCode, takeForCode, withSecret, secretOf, saveGrant, revokeFamily, vaultActive, withVault, VaultLockedError };
