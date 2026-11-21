// engine/shims/crypto.js — the synchronous node:crypto subset the bundled code uses:
// randomUUID, randomBytes, randomInt, createHash / createHmac (sha256, sha1, md5),
// timingSafeEqual. Hashes are small pure-JS implementations (WebCrypto digests are async).
// Ciphers / signatures are not available: the vault itself is already encrypted.
'use strict';

const webcrypto = globalThis.crypto;

function toBytes(data, enc) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), enc || 'utf8');
}
function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---- SHA-256 ----
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function padBE(msg) {
  const len = msg.length;
  const total = (((len + 9) + 63) >> 6) << 6;
  const p = new Uint8Array(total);
  p.set(msg);
  p[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(p.buffer);
  dv.setUint32(total - 4, bits >>> 0);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  return dv;
}
function sha256(msg) {
  const dv = padBE(msg);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) odv.setUint32(i * 4, h[i]);
  return out;
}

// ---- SHA-1 ----
function sha1(msg) {
  const dv = padBE(msg);
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i += 1) {
      let f; let k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 5; i += 1) odv.setUint32(i * 4, h[i]);
  return out;
}

// ---- MD5 ----
const S_MD5 = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K_MD5 = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000));
function md5(msg) {
  const len = msg.length;
  const total = (((len + 9) + 63) >> 6) << 6;
  const p = new Uint8Array(total);
  p.set(msg);
  p[len] = 0x80;
  const dv = new DataView(p.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 0x100000000), true);
  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) m[i] = dv.getUint32(off + i * 4, true);
    let a = a0; let b = b0; let c = c0; let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f; let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; } else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = b;
      const x = (a + f + K_MD5[i] + m[g]) >>> 0;
      b = (b + ((x << S_MD5[i]) | (x >>> (32 - S_MD5[i])))) >>> 0;
      a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => odv.setUint32(i * 4, v, true));
  return out;
}

const ALGOS = { sha256: sha256, 'sha-256': sha256, sha1: sha1, 'sha-1': sha1, md5: md5 };
function algo(name) {
  const fn = ALGOS[String(name || '').toLowerCase()];
  if (!fn) { const e = new Error(`NOT_AVAILABLE_IN_VAULT: hash ${name}`); e.code = 'NOT_AVAILABLE_IN_VAULT'; throw e; }
  return fn;
}

function encodeDigest(bytes, enc) {
  const buf = Buffer.from(bytes);
  if (!enc || enc === 'buffer') return buf;
  if (enc === 'base64url') return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return buf.toString(enc);
}

class Hash {
  constructor(name) { this.fn = algo(name); this.chunks = []; }
  update(data, enc) { this.chunks.push(toBytes(data, enc)); return this; }
  digest(enc) { return encodeDigest(this.fn(concat(this.chunks)), enc); }
  copy() { const h = new Hash('sha256'); h.fn = this.fn; h.chunks = this.chunks.slice(); return h; }
}

class Hmac {
  constructor(name, key) {
    this.fn = algo(name);
    let k = toBytes(key);
    if (k.length > 64) k = this.fn(k);
    this.key = new Uint8Array(64);
    this.key.set(k);
    this.chunks = [];
  }
  update(data, enc) { this.chunks.push(toBytes(data, enc)); return this; }
  digest(enc) {
    const ipad = this.key.map((b) => b ^ 0x36);
    const opad = this.key.map((b) => b ^ 0x5c);
    const inner = this.fn(concat([ipad, ...this.chunks]));
    return encodeDigest(this.fn(concat([opad, inner])), enc);
  }
}

function randomBytes(n, cb) {
  const out = Buffer.alloc(n);
  for (let o = 0; o < n; o += 65536) webcrypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  if (typeof cb === 'function') { setTimeout(() => cb(null, out), 0); return undefined; }
  return out;
}
function randomUUID() {
  if (webcrypto && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  const range = max - min;
  const v = new Uint32Array(1);
  webcrypto.getRandomValues(v);
  return min + (v[0] % range);
}
function timingSafeEqual(a, b) {
  const x = toBytes(a); const y = toBytes(b);
  if (x.length !== y.length) throw new RangeError('Input buffers must have the same byte length');
  let d = 0;
  for (let i = 0; i < x.length; i += 1) d |= x[i] ^ y[i];
  return d === 0;
}

const unavailable = (name) => () => { const e = new Error(`NOT_AVAILABLE_IN_VAULT: crypto.${name}`); e.code = 'NOT_AVAILABLE_IN_VAULT'; throw e; };

module.exports = {
  createHash: (name) => new Hash(name),
  createHmac: (name, key) => new Hmac(name, key),
  randomBytes,
  randomUUID,
  randomInt,
  timingSafeEqual,
  getRandomValues: (a) => webcrypto.getRandomValues(a),
  webcrypto,
  createCipheriv: unavailable('createCipheriv'),
  createDecipheriv: unavailable('createDecipheriv'),
  createPublicKey: unavailable('createPublicKey'),
  createPrivateKey: unavailable('createPrivateKey'),
  sign: unavailable('sign'),
  verify: unavailable('verify'),
  scryptSync: unavailable('scryptSync'),
  pbkdf2Sync: unavailable('pbkdf2Sync'),
};
