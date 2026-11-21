/** @jest-environment node */
const C = require('../public/js/vault/crypto');

describe('Finman Vault crypto', () => {
  jest.setTimeout(30000);
  test('password → master → authToken/KEK; wrap/unwrap; wrong password fails', async () => {
    const salt = C.newSalt();
    const m1 = await C.deriveMaster('correct horse', salt, C.DEFAULT_PARAMS);
    const m2 = await C.deriveMaster('correct horse', salt, C.DEFAULT_PARAMS);
    expect(C.hex(m1)).toBe(C.hex(m2));
    const tok = await C.authToken(m1);
    expect(tok).toMatch(/^fm1\$[0-9a-f]{64}$/);
    const vk = C.newVaultKey();
    const kek = await C.kekFromMaster(m1);
    expect(C.hex(kek)).not.toBe(tok.slice(4));
    const w = await C.wrap(kek, vk, C.wrapAad(7, 'pw'));
    expect(C.hex(await C.unwrap(kek, w, C.wrapAad(7, 'pw')))).toBe(C.hex(vk));
    const bad = await C.kekFromMaster(await C.deriveMaster('wrong', salt, C.DEFAULT_PARAMS));
    await expect(C.unwrap(bad, w, C.wrapAad(7, 'pw'))).rejects.toMatchObject({ code: 'BAD_KEY' });
    // обёртка привязана к пользователю
    await expect(C.unwrap(kek, w, C.wrapAad(8, 'pw'))).rejects.toMatchObject({ code: 'BAD_KEY' });
  });
  test('recovery key text roundtrip and unwrap', async () => {
    const rk = C.newRecoveryKey();
    expect(rk.text).toMatch(/^FM1-([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    const parsed = C.parseRecoveryKey(rk.text.toLowerCase().replace(/-/g, ' '));
    expect(C.hex(parsed)).toBe(C.hex(rk.bytes));
    const vk = C.newVaultKey();
    const w = await C.wrap(await C.kekFromRecovery(rk.bytes), vk, C.wrapAad(1, 'rc'));
    const back = await C.unwrap(await C.kekFromRecovery(parsed), w, C.wrapAad(1, 'rc'));
    expect(C.hex(back)).toBe(C.hex(vk));
    expect(() => C.parseRecoveryKey('FM1-ABCD')).toThrow();
  });
  test('vault blob encrypt/decrypt, tamper detection, no plaintext inside', async () => {
    const vk = C.newVaultKey();
    const plain = new TextEncoder().encode('SQLite format 3\0 Groceries 123.45 '.repeat(200));
    const blob = await C.encryptVault(vk, plain, 5);
    expect(Buffer.from(blob).toString('latin1')).not.toMatch(/Groceries|SQLite/);
    expect(Buffer.from(await C.decryptVault(vk, blob, 5)).equals(Buffer.from(plain))).toBe(true);
    const t = blob.slice(); t[40] ^= 1;
    await expect(C.decryptVault(vk, t, 5)).rejects.toThrow();
    await expect(C.decryptVault(vk, blob, 6)).rejects.toThrow();
  });
  test('weak KDF params from server are refused', async () => {
    await expect(C.deriveMaster('x', C.newSalt(), { alg: 'argon2id', m: 8, t: 1, p: 1, len: 32 })).rejects.toThrow(/weak/);
  });
});
