// test/e2e/vault-browser.cjs — Finman Vault в настоящем Chromium на стенде.
//
//   BASE=http://127.0.0.1:PORT DB=/path/stage.db node test/e2e/vault-browser.cjs register <email> <password>
//   BASE=… DB=… node test/e2e/vault-browser.cjs legacy <email> <password>    # миграция старого пользователя
//
// Сценарий register: регистрация → сейф создан → ключ восстановления → счёт + транзакция →
//   перезагрузка (данные на месте без пароля: ключ устройства) → выход → вход паролем → данные на месте.
// Сценарий legacy: вход старым паролем → экран «Шифруем» → ключ восстановления → данные видны.
// После каждого сценария — проверка базы: в таблицах данных пусто, в user_vaults шифротекст.
'use strict';
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE;
const DB = process.env.DB;
const SHOTS = process.env.SHOTS || '/fast/claude-tmp/fm-e2e-stage/shots';
const [mode, email, password] = process.argv.slice(2);
fs.mkdirSync(SHOTS, { recursive: true });

// sqlite3 CLI is not on every machine: read through Python's sqlite3, read-only.
const PY = 'import sqlite3,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nfor r in c.execute(sys.argv[2]): print(" ".join("" if v is None else (v.hex() if isinstance(v,bytes) else str(v)) for v in r))';
function sql(q) {
  return execFileSync('python3', ['-c', PY, DB, q], { encoding: 'utf8' }).trim();
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${mode}-${name}.png`), fullPage: false });
}

async function waitApp(page) {
  await answerPrompts(page, '#main-content');
  await page.waitForSelector('#main-content', { timeout: 60000 });
}

// Google/Apple accounts: the vault asks to create (or enter) a vault password.
const VAULT_PW = process.env.VAULT_PW || 'Vault-Pass-2026!';
async function answerPrompts(page, until) {
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (await page.locator(until).count()) return;
    if (await page.locator('#fmv-secret2').count()) {
      log('vault asks to CREATE a vault password');
      await page.fill('#fmv-secret', VAULT_PW); await page.fill('#fmv-secret2', VAULT_PW);
      await page.click('.fmv-form button[type=submit]');
      await page.waitForFunction(() => !document.querySelector('#fmv-secret2'), null, { timeout: 30000 });
    } else if (await page.locator('#fmv-secret').count() && await page.locator('#fmv-secret').isVisible()) {
      log('vault asks to UNLOCK');
      await shot(page, 'unlock-prompt');
      await page.fill('#fmv-secret', process.env.UNLOCK_PW || VAULT_PW);
      await page.click('.fmv-form button[type=submit]');
      // Argon2id takes a second or two: wait until the prompt is gone or shows an error.
      await page.waitForFunction(() => !document.querySelector('#fmv-secret') || !document.querySelector('.fmv-err').hidden, null, { timeout: 30000 });
      const err = await page.locator('.fmv-err').textContent().catch(() => '');
      if (err && err.trim()) log('unlock error:', err.trim());
    }
    await page.waitForTimeout(400);
  }
}

async function confirmRecovery(page) {
  await answerPrompts(page, '#fmv-rktext');
  await page.waitForSelector('#fmv-rktext', { timeout: 90000 });
  const rk = (await page.textContent('#fmv-rktext')).trim();
  await shot(page, 'recovery-key');
  await page.check('#fmv-saved');
  await page.click('.fmv-go');
  return rk;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const serverBodies = [];
  page.on('request', (r) => {
    if (r.url().startsWith(BASE + '/api/') && r.method() !== 'GET') serverBodies.push(`${r.method()} ${r.url().slice(BASE.length)} ${String(r.postData() || '').slice(0, 300)}`);
  });

  await page.goto(BASE + '/');
  if (mode === 'register') {
    await page.click('.auth-tab[data-tab="register"]');
    await page.fill('#register-email', email);
    await page.fill('#register-password', password);
    await page.click('#register-form button[type=submit]');
    const rk = await confirmRecovery(page);
    log('recovery key shown, length', rk.length);
    await waitApp(page);
    // счёт и транзакция через API приложения (тот же fetch, что у экранов)
    const made = await page.evaluate(async () => {
      const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
      const a = await (await fetch('/api/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'E2E Chequing', currency: 'CAD', balance: 1000, accountType: 'checking' }) })).json();
      const acc = a.account || a.data || a;
      const t = await fetch('/api/transactions', { method: 'POST', headers: h, body: JSON.stringify({ accountId: acc.id, amount: 42.5, type: 'expense', description: 'E2E secret groceries', category: 'Groceries', date: new Date().toISOString().slice(0, 10) }) });
      const list = await (await fetch('/api/accounts', { headers: h })).json();
      return { acc: acc.id, tx: t.status, list: JSON.stringify(list).slice(0, 400) };
    });
    log('created', JSON.stringify(made));
    await page.evaluate(() => window.FMVault.syncNow());
    await page.waitForTimeout(1500);
  } else if (mode === 'legacy') {
    await page.click('.auth-tab[data-tab="login"]').catch(() => {});
    await page.fill('#login-username', email);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type=submit]');
    const rk = await confirmRecovery(page);
    log('recovery key shown, length', rk.length);
    await waitApp(page);
  } else if (mode === 'login') {
    // existing vault on a fresh device: sign in → unlock prompt → data
    await page.click('.auth-tab[data-tab="login"]').catch(() => {});
    await page.fill('#login-username', email);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type=submit]');
    await waitApp(page);
  } else {
    throw new Error('mode register|legacy|login');
  }

  await page.waitForTimeout(2500);
  await shot(page, 'dashboard');
  const status1 = await page.evaluate(() => window.FMVault.status());
  log('vault status', JSON.stringify(status1));

  // перезагрузка: сейф открывается ключом устройства
  await page.reload();
  await waitApp(page);
  await page.waitForTimeout(2500);
  const accountsAfterReload = await page.evaluate(async () => {
    const r = await fetch('/api/accounts', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    return JSON.stringify(await r.json()).slice(0, 300);
  });
  log('after reload /api/accounts', accountsAfterReload);
  await shot(page, 'after-reload');

  // выход и вход паролем
  await page.evaluate(() => { if (typeof logout === 'function') logout(); });
  await page.waitForTimeout(800);
  await page.goto(BASE + '/');
  await page.click('.auth-tab[data-tab="login"]').catch(() => {});
  await page.fill('#login-username', email);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type=submit]');
  await waitApp(page);
  await page.waitForTimeout(3000);
  const accountsAfterLogin = await page.evaluate(async () => {
    const r = await fetch('/api/accounts', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    return JSON.stringify(await r.json()).slice(0, 300);
  });
  log('after re-login /api/accounts', accountsAfterLogin);
  await shot(page, 'after-login');
  await page.click('[data-page="transactions"], a[href="/transactions"]').catch(() => {});
  await page.waitForTimeout(2000);
  await shot(page, 'transactions');

  // что ушло на сервер: тело входа не содержит пароль
  const loginBodies = serverBodies.filter((b) => b.includes('/api/auth/login') || b.includes('/api/auth/register'));
  const leaked = serverBodies.filter((b) => b.includes(password) || b.includes('E2E secret groceries'));
  log('login/register bodies:', loginBodies.map((b) => b.replace(/"password":"([^"]{0,12})[^"]*"/, '"password":"$1…"')).join(' || '));
  log('requests carrying the raw password or tx text:', leaked.length);

  // база: открытых строк нет, сейф — шифротекст (на проде проверка отдельно, через ssh)
  if (!DB) { log('page errors:', errors.length ? errors.join(' | ').slice(0, 800) : 'none'); await browser.close(); return; }
  const uid = sql(`select id from users where email='${email.replace(/'/g, "''")}'`);
  log('db user', uid, sql(`select vault_state||' '||kdf||' '||substr(password,1,7) from users where id=${uid}`));
  log('db plaintext rows: accounts', sql(`select count(*) from accounts where user_id=${uid}`), 'transactions', sql(`select count(*) from transactions where user_id=${uid}`));
  log('db vault', sql(`select version||' '||size||' '||hex(substr(blob,1,16)) from user_vaults where user_id=${uid}`));
  const blobHex = sql(`select hex(blob) from user_vaults where user_id=${uid}`);
  const blobTxt = Buffer.from(blobHex, 'hex').toString('latin1');
  const grep = ['E2E', 'Chequing', 'groceries', 'SQLite format'].filter((w) => blobTxt.includes(w)).length;
  log('readable words inside the vault blob:', grep);
  log('page errors:', errors.length ? errors.join(' | ').slice(0, 800) : 'none');
  await browser.close();
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
