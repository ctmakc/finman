// services/patService.js — Personal Access Tokens (публичный REST API).
//
// Токен показывается пользователю ОДИН РАЗ при создании (plaintext); в БД лежит
// только его sha-256-хэш. verify() сравнивает хэши за константное по схеме время
// (хэш фиксированной длины -> timingSafeEqual) и обновляет last_used_at.
//
// Формат токена: 'finman_pat_' + 48 hex-символов (24 случайных байта).
// Префикс делает токен распознаваемым (как у GitHub `ghp_…`) и удобным для
// секрет-сканеров.

const crypto = require('crypto');
const { query, get, run } = require('../db/database');

const TOKEN_PREFIX = 'finman_pat_';
const TOKEN_BYTES = 24; // -> 48 hex символов

// Хэшируем токен (sha-256, hex). Детерминированно -> можно искать по индексу.
function hashToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest('hex');
}

// Генерируем новый plaintext-токен.
function generatePlaintext() {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// Сравнение хэшей в константное время (оба — hex одинаковой длины).
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Публичное (безопасное) представление токена — БЕЗ хэша и без plaintext.
function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    lastUsedAt: row.last_used_at || null,
    createdAt: row.created_at,
  };
}

// create(userId, name) -> { id, name, token (plaintext, показывается ОДИН раз),
//   createdAt }. Имя обязательно (непустая строка).
async function create(userId, name) {
  const clean = String(name == null ? '' : name).trim();
  if (!clean) {
    const err = new Error('Token name is required');
    err.code = 'INVALID_NAME';
    throw err;
  }
  const plaintext = generatePlaintext();
  const tokenHash = hashToken(plaintext);
  const result = await run(
    `INSERT INTO personal_access_tokens (user_id, name, token_hash) VALUES (?, ?, ?)`,
    [userId, clean.slice(0, 100), tokenHash]
  );
  return {
    id: result.id,
    name: clean.slice(0, 100),
    token: plaintext, // единственный раз, когда виден plaintext
    createdAt: new Date().toISOString(),
  };
}

// verify(token) -> userId | null. При успехе обновляет last_used_at.
// Не бросает на «плохой» токен — возвращает null (нет утечки информации).
async function verify(token) {
  if (!token || typeof token !== 'string') return null;
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);
  const row = await get(
    `SELECT id, user_id, token_hash FROM personal_access_tokens WHERE token_hash = ?`,
    [tokenHash]
  );
  if (!row) return null;
  // Доп. константное сравнение (на случай коллизии/частичного совпадения индекса).
  if (!safeEqualHex(row.token_hash, tokenHash)) return null;
  // Обновляем время последнего использования (best-effort, без блокировки ответа).
  try {
    await run(
      `UPDATE personal_access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [row.id]
    );
  } catch (_) {
    /* не критично для авторизации */
  }
  return row.user_id;
}

// list(userId) -> [{ id, name, lastUsedAt, createdAt }] (без хэшей/plaintext).
async function list(userId) {
  const rows = await query(
    `SELECT id, name, last_used_at, created_at
       FROM personal_access_tokens
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC`,
    [userId]
  );
  return rows.map(publicRow);
}

// revoke(userId, tokenId) -> boolean (true, если что-то удалили).
// Удаляем строго в рамках владельца — чужой токен не отзовём.
async function revoke(userId, tokenId) {
  const result = await run(
    `DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?`,
    [tokenId, userId]
  );
  return result.changes > 0;
}

module.exports = {
  create,
  verify,
  list,
  revoke,
  // экспортируем для тестов/повторного использования
  hashToken,
  TOKEN_PREFIX,
};
