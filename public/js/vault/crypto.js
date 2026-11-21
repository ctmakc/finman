// public/js/vault/crypto.js — криптография Finman Vault (docs/E2E-ENCRYPTION.md §3).
// Работает в браузере (WebCrypto + hash-wasm argon2id из /vendor/hash-wasm/) и в
// Node 22 (globalThis.crypto.subtle + require('hash-wasm')) — тесты и MCP по согласию.
// Ключи и пароль из этого модуля на сервер не уходят: наружу идут только
// authToken (вместо пароля), обёртки ключа (wrapped_*) и шифротекст сейфа.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(true);
  else root.FMCrypto = factory(false);
})(typeof self !== 'undefined' ? self : this, function (isNode) {
  'use strict';
  const subtle = globalThis.crypto.subtle;
  const te = new TextEncoder();
  const td = new TextDecoder();

  const DEFAULT_PARAMS = { alg: 'argon2id', m: 65536, t: 3, p: 1, len: 32 };
  const MAGIC = te.encode('FMV1');

  function argon2id() {
    if (isNode) return require('hash-wasm').argon2id;
    const hw = globalThis.hashwasm;
    if (!hw || !hw.argon2id) throw new Error('argon2 library not loaded');
    return hw.argon2id;
  }

  // ---- кодеки ---------------------------------------------------------------
  function b64(bytes) {
    let s = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(String(str));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function hex(bytes) {
    return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function randomBytes(n) {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  }
  function concat(...parts) {
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ---- вывод ключей -----------------------------------------------------------
  function parseParams(params) {
    let p = params;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
    p = Object.assign({}, DEFAULT_PARAMS, p || {});
    if (p.alg !== 'argon2id') throw new Error('Unsupported KDF ' + p.alg);
    // Нижние границы: сервер не может «ослабить» KDF подменой параметров.
    if (p.m < 19456 || p.t < 2 || p.len !== 32) throw new Error('KDF parameters too weak');
    return p;
  }

  async function deriveMaster(password, saltB64, params) {
    const p = parseParams(params);
    const out = await argon2id()({
      password: String(password),
      salt: unb64(saltB64),
      parallelism: p.p,
      iterations: p.t,
      memorySize: p.m,
      hashLength: p.len,
      outputType: 'binary',
    });
    return new Uint8Array(out);
  }

  async function hkdf(ikm, info, len = 32) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) }, base, len * 8);
    return new Uint8Array(bits);
  }

  async function authToken(master) {
    return 'fm1$' + hex(await hkdf(master, 'finman/auth/v1'));
  }
  const kekFromMaster = (master) => hkdf(master, 'finman/kek/v1');
  const kekFromRecovery = (rk) => hkdf(rk, 'finman/recovery/v1');
  const kekFromGrant = (secret) => hkdf(secret, 'finman/grant/v1');

  // ---- AES-256-GCM ------------------------------------------------------------
  async function aesKey(raw, usages = ['encrypt', 'decrypt']) {
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
  }
  async function seal(keyBytes, plain, aad) {
    const iv = randomBytes(12);
    const key = keyBytes instanceof Uint8Array ? await aesKey(keyBytes) : keyBytes;
    const ct = new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, plain));
    return { iv, ct };
  }
  async function open(keyBytes, iv, ct, aad) {
    const key = keyBytes instanceof Uint8Array ? await aesKey(keyBytes) : keyBytes;
    return new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, ct));
  }

  // Обёртка ключа сейфа: "w1.<iv>.<ct>" (base64).
  async function wrap(kek, vaultKey, aad) {
    const { iv, ct } = await seal(kek, vaultKey, aad);
    return 'w1.' + b64(iv) + '.' + b64(ct);
  }
  async function unwrap(kek, wrapped, aad) {
    const parts = String(wrapped || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'w1') throw new Error('Bad key wrap');
    try {
      return await open(kek, unb64(parts[1]), unb64(parts[2]), aad);
    } catch (_) {
      const e = new Error('Wrong password or key');
      e.code = 'BAD_KEY';
      throw e;
    }
  }
  const wrapAad = (userId, kind) => `finman-wrap:v1:${userId}:${kind}`;
  const blobAad = (userId) => `finman-vault:v1:${userId}`;

  // ---- сжатие (gzip через CompressionStream, есть в браузерах и Node 18+) ------
  async function pipe(bytes, stream) {
    const s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const gzip = (b) => pipe(b, new CompressionStream('gzip'));
  const gunzip = (b) => pipe(b, new DecompressionStream('gzip'));

  // Сейф: "FMV1" | iv(12) | AES-GCM(vaultKey, gzip(sqlite bytes)).
  async function encryptVault(vaultKey, sqliteBytes, userId) {
    const { iv, ct } = await seal(vaultKey, await gzip(sqliteBytes), blobAad(userId));
    return concat(MAGIC, iv, ct);
  }
  async function decryptVault(vaultKey, blob, userId) {
    const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) throw new Error('Not a Finman vault');
    const plain = await open(vaultKey, b.subarray(4, 16), b.subarray(16), blobAad(userId));
    return gunzip(plain);
  }

  // ---- ключ восстановления: FM1-XXXX-… (Crockford base32, 256 бит) -------------
  const ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function toB32(bytes) {
    let bits = 0, val = 0, out = '';
    for (const x of bytes) {
      val = (val << 8) | x; bits += 8;
      while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += ALPH[(val << (5 - bits)) & 31];
    return out;
  }
  function fromB32(str) {
    const clean = String(str).toUpperCase().replace(/^FM1-?/, '').replace(/[\s-]/g, '')
      .replace(/[IL]/g, '1').replace(/O/g, '0');
    let bits = 0, val = 0;
    const out = [];
    for (const ch of clean) {
      const i = ALPH.indexOf(ch);
      if (i < 0) throw Object.assign(new Error('Recovery key has a wrong character'), { code: 'BAD_RECOVERY' });
      val = (val << 5) | i; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    if (out.length !== 32) throw Object.assign(new Error('Recovery key is incomplete'), { code: 'BAD_RECOVERY' });
    return new Uint8Array(out);
  }
  function newRecoveryKey() {
    const bytes = randomBytes(32);
    const s = toB32(bytes);
    return { bytes, text: 'FM1-' + s.match(/.{1,4}/g).join('-') };
  }

  return {
    DEFAULT_PARAMS, b64, unb64, hex, randomBytes,
    deriveMaster, hkdf, authToken, kekFromMaster, kekFromRecovery, kekFromGrant,
    wrap, unwrap, wrapAad, blobAad, encryptVault, decryptVault,
    newRecoveryKey, parseRecoveryKey: fromB32, gzip, gunzip,
    newSalt: () => b64(randomBytes(16)),
    newVaultKey: () => randomBytes(32),
  };
});
