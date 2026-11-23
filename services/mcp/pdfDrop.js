// services/mcp/pdfDrop.js — invoice PDF links for AI chats on vault (encrypted) accounts.
//
// During a consented tool call the server holds the decrypted vault in memory (vaultGrant.js) and
// can make the PDF. It must not keep it readable: the PDF (with its file name) is encrypted with
// a fresh random key, only the ciphertext is stored, and the key goes into the link's #fragment:
//   https://app.finman.money/p/<id>#<key>
// Browsers never send the fragment to the server. /p/<id> serves a small page that fetches the
// ciphertext and decrypts it in the browser (public/js/pdf-drop.js). 7 days, then deleted.
'use strict';

const crypto = require('crypto');
const { run, get } = require('../../db/database');

const TTL_DAYS = 7;
const ID_RE = /^[A-Za-z0-9_-]{22,40}$/;
const MAGIC = Buffer.from('FMP1');

function baseUrl() { return (process.env.APP_PUBLIC_URL || 'https://app.finman.money').replace(/\/+$/, ''); }

// payload = u16 name length | name (utf8) | pdf bytes; blob = MAGIC | iv(12) | ciphertext | tag(16)
function seal(key, filename, pdf) {
  const name = Buffer.from(String(filename || 'invoice.pdf').slice(0, 120), 'utf8');
  const len = Buffer.alloc(2); len.writeUInt16BE(name.length, 0);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(Buffer.concat([len, name, Buffer.from(pdf)])), c.final()]);
  return Buffer.concat([MAGIC, iv, ct, c.getAuthTag()]);
}

async function create(userId, { buffer, filename }) {
  await run("DELETE FROM mcp_pdf_drops WHERE expires_at < datetime('now')").catch(() => {});
  const key = crypto.randomBytes(32);
  const id = crypto.randomBytes(18).toString('base64url');
  try {
    await run(`INSERT INTO mcp_pdf_drops (id, user_id, blob, expires_at) VALUES (?, ?, ?, datetime('now', '+${TTL_DAYS} days'))`,
      [id, userId, seal(key, filename, buffer)]);
    return `${baseUrl()}/p/${id}#${key.toString('base64url')}`;
  } finally {
    key.fill(0);
  }
}

async function blobOf(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const r = await get("SELECT blob FROM mcp_pdf_drops WHERE id = ? AND expires_at > datetime('now')", [String(id)]);
  return r ? Buffer.from(r.blob) : null;
}

module.exports = { create, blobOf, seal, TTL_DAYS };
