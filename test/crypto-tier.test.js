// test/crypto-tier.test.js — stream "gcm-tier" security polish.
// ADDITIVE: проверяет три вещи без правки роутов/сервера.
//
//   1) AES-256-GCM encrypt -> decrypt roundtrip (новый формат 'iv:tag:ct');
//   2) старый AES-256-CBC формат ('iv:ct') всё ещё дешифруется (backward-compat);
//   3) requireTier предпочитает req.user.subscription_tier (без обращения к БД)
//      и падает в БД только если поля нет.
//
// Крипто-тесты не зависят от БД. Тест requireTier работает напрямую с
// middleware (он НЕ смонтирован как роут) — мокаем req/res/next вручную.

const crypto = require('crypto');

// Фиксируем ключ ДО загрузки config (config читает ENCRYPTION_KEY при require).
const FIXED_KEY = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ENCRYPTION_KEY = FIXED_KEY;

const config = require('../config/config');
const { requireTier } = require('../middleware/requireTier');

// Воспроизводим СТАРЫЙ CBC-формат ('iv:ciphertext') тем же ключом, чтобы
// доказать обратную совместимость decryptToken без обращения к приватным внутренностям.
function legacyCbcEncrypt(plaintext, keyHex) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv);
  let enc = cipher.update(Buffer.from(plaintext, 'utf8'));
  enc = Buffer.concat([enc, cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

describe('crypto: AES-256-GCM encrypt/decrypt', () => {
  test('roundtrip восстанавливает исходный текст', () => {
    const secret = 'plaid-access-token-abc123';
    const enc = config.encryptToken(secret);
    expect(typeof enc).toBe('string');
    expect(config.decryptToken(enc)).toBe(secret);
  });

  test('новый формат состоит из 3 hex-частей iv:tag:ciphertext', () => {
    const enc = config.encryptToken('hello');
    const parts = enc.split(':');
    expect(parts.length).toBe(3);
    // iv = 12 байт (24 hex), tag = 16 байт (32 hex).
    expect(parts[0]).toHaveLength(24);
    expect(parts[1]).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(parts[2])).toBe(true);
  });

  test('два разных шифрования одного текста дают разный ciphertext (случайный IV)', () => {
    const a = config.encryptToken('same-token');
    const b = config.encryptToken('same-token');
    expect(a).not.toBe(b);
    expect(config.decryptToken(a)).toBe('same-token');
    expect(config.decryptToken(b)).toBe('same-token');
  });

  test('подмена auth-tag (tampering) ломает дешифровку — аутентичность работает', () => {
    const enc = config.encryptToken('integrity-matters');
    const parts = enc.split(':');
    // Портим один символ в tag.
    const flipped = parts[1][0] === '0' ? '1' : '0';
    parts[1] = flipped + parts[1].slice(1);
    expect(() => config.decryptToken(parts.join(':'))).toThrow();
  });

  test('encrypt(null/empty) -> null, decrypt(null) -> null', () => {
    expect(config.encryptToken(null)).toBeNull();
    expect(config.encryptToken('')).toBeNull();
    expect(config.decryptToken(null)).toBeNull();
    expect(config.decryptToken('')).toBeNull();
  });

  test('юникод сохраняется через roundtrip', () => {
    const secret = 'токен-🔐-перевірка';
    expect(config.decryptToken(config.encryptToken(secret))).toBe(secret);
  });
});

describe('crypto: обратная совместимость со старым CBC-форматом', () => {
  test('legacy CBC значение (iv:ciphertext) всё ещё дешифруется', () => {
    const secret = 'old-cbc-stored-token';
    const legacy = legacyCbcEncrypt(secret, FIXED_KEY);
    expect(legacy.split(':').length).toBe(2); // именно старый 2-частный формат
    expect(config.decryptToken(legacy)).toBe(secret);
  });

  test('GCM и CBC форматы различаются по числу частей, но оба читаются', () => {
    const secret = 'mixed-store';
    const gcm = config.encryptToken(secret);
    const cbc = legacyCbcEncrypt(secret, FIXED_KEY);
    expect(gcm.split(':').length).toBe(3);
    expect(cbc.split(':').length).toBe(2);
    expect(config.decryptToken(gcm)).toBe(secret);
    expect(config.decryptToken(cbc)).toBe(secret);
  });
});

// --- requireTier ------------------------------------------------------------
// Лёгкие mock-объекты req/res/next; middleware не смонтирован, тестируем напрямую.
function makeReqRes(user) {
  const req = { user };
  const res = {};
  let nextArg;
  let nextCalled = false;
  const next = (arg) => {
    nextCalled = true;
    nextArg = arg;
  };
  return { req, res, next, getNextArg: () => nextArg, wasNextCalled: () => nextCalled };
}

describe('requireTier: предпочитает req.user.subscription_tier (без БД-запроса)', () => {
  test('pro-пользователь проходит requireTier("pro") без обращения к БД', async () => {
    // Если бы middleware полез в БД, getDb() кинул бы (БД не инициализирована
    // в этом тест-файле) -> next получил бы ошибку. Чистый next() доказывает,
    // что значение взято из req.user.
    const { req, res, next, getNextArg, wasNextCalled } = makeReqRes({
      id: 1,
      subscription_tier: 'pro',
    });
    await requireTier('pro')(req, res, next);
    expect(wasNextCalled()).toBe(true);
    expect(getNextArg()).toBeUndefined(); // прошёл гейт
  });

  test('family-пользователь проходит requireTier("pro") (выше требуемого)', async () => {
    const { req, res, next, getNextArg } = makeReqRes({ id: 2, subscription_tier: 'family' });
    await requireTier('pro')(req, res, next);
    expect(getNextArg()).toBeUndefined();
  });

  test('free-пользователь не проходит requireTier("pro") -> 402 PAYMENT_REQUIRED', async () => {
    const { req, res, next, getNextArg } = makeReqRes({ id: 3, subscription_tier: 'free' });
    await requireTier('pro')(req, res, next);
    const err = getNextArg();
    expect(err).toBeTruthy();
    expect(err.statusCode || err.status).toBe(402);
    expect(err.code).toBe('PAYMENT_REQUIRED');
  });

  test('значение из req.user используется даже когда БД недоступна (нет лишнего запроса)', async () => {
    // tier берётся из req.user.subscription_tier; никакого getDb() не происходит,
    // иначе при отсутствии инициализации БД мы бы получили исключение в next.
    const { req, res, next, getNextArg } = makeReqRes({ id: 4, subscription_tier: 'family' });
    await requireTier('family')(req, res, next);
    expect(getNextArg()).toBeUndefined();
  });

  test('без req.user -> 401 UNAUTHORIZED', async () => {
    const { req, res, next, getNextArg } = makeReqRes(undefined);
    await requireTier('pro')(req, res, next);
    const err = getNextArg();
    expect(err).toBeTruthy();
    expect(err.statusCode || err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });
});
