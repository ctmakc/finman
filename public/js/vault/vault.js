// public/js/vault/vault.js — Finman Vault в браузере (docs/E2E-ENCRYPTION.md).
//
// 1. Перехватывает window.fetch('/api/…'): запросы к данным пользователя уходят в
//    локальный движок (FinmanEngine над расшифрованной SQLite в памяти вкладки),
//    на сервер идут только вход, оплата, аналитика без данных и сам сейф-шифротекст.
// 2. Вход: пароль → Argon2id → authToken (на сервер вместо пароля) + KEK (здесь).
// 3. Миграция: открытые данные с сервера → локальная база → шифротекст на сервер →
//    ключ восстановления пользователю → сервер стирает открытые строки.
// 4. Синхронизация: после записи — шифрованная копия в IndexedDB и PUT на сервер
//    с If-Match; конфликт → скачать новую версию, повторить свои запросы, отправить.
(function () {
  'use strict';
  const C = window.FMCrypto;
  const origFetch = window.fetch.bind(window);

  // ---------------------------------------------------------------- strings
  const S = {
    en: {
      migTitle: 'Encrypting your data',
      migLead: 'From now on your Finman data is encrypted on this device. Our servers keep only ciphertext — nobody at Finman can read your accounts, transactions or notes.',
      stExport: 'Getting your data', stBuild: 'Building your encrypted vault', stUpload: 'Saving the encrypted copy', stPurge: 'Erasing the readable copy from our server',
      rkTitle: 'Your recovery key',
      rkLead: 'This key is the only way back to your data if you forget your password. We cannot reset it for you: we never see your password or your key. Save it somewhere safe — a password manager or on paper.',
      rkCopy: 'Copy', rkDownload: 'Download as file', rkSaved: 'I saved my recovery key', rkContinue: 'Continue', rkCopied: 'Copied',
      unlockTitle: 'Unlock your data', unlockLead: 'Your data is encrypted. Enter your password to open it on this device.',
      unlockLeadSafe: 'Your data is encrypted. Enter your vault password to open it on this device.',
      pw: 'Password', vaultPw: 'Vault password', vaultPw2: 'Repeat the vault password', unlock: 'Unlock', useRk: 'Use recovery key instead', usePw: 'Use password instead',
      rk: 'Recovery key', remember: 'Keep unlocked on this device', wrongPw: 'That password does not open your vault.', wrongRk: 'That recovery key does not open your vault.',
      setTitle: 'Create a vault password', setLead: 'You sign in with Google or Apple, so Finman needs a separate password to encrypt your data. We never see it. Use at least 8 characters.',
      setShort: 'Use at least 8 characters.', setMismatch: 'The passwords do not match.', create: 'Encrypt my data',
      migPwLead: 'To encrypt your data we need your Finman password once more.',
      failed: 'Encryption did not finish. Your data is safe and unchanged — we will try again next time you open Finman.',
      signOut: 'Sign out', newPwTitle: 'Set a new vault password',
      syncFail: 'Could not save the encrypted copy. Finman will retry.',
      working: 'Working…',
    },
    ru: {
      migTitle: 'Шифруем ваши данные',
      migLead: 'Теперь данные Finman шифруются на этом устройстве. На нашем сервере остаётся только шифротекст: в Finman никто не может прочитать ваши счета, транзакции и заметки.',
      stExport: 'Получаем ваши данные', stBuild: 'Собираем зашифрованный сейф', stUpload: 'Сохраняем зашифрованную копию', stPurge: 'Стираем читаемую копию с сервера',
      rkTitle: 'Ваш ключ восстановления',
      rkLead: 'Этот ключ — единственный путь к данным, если вы забудете пароль. Восстановить его мы не сможем: ваш пароль и ключ к нам не попадают. Сохраните его в менеджер паролей или на бумаге.',
      rkCopy: 'Скопировать', rkDownload: 'Скачать файлом', rkSaved: 'Я сохранил ключ восстановления', rkContinue: 'Продолжить', rkCopied: 'Скопировано',
      unlockTitle: 'Откройте свои данные', unlockLead: 'Ваши данные зашифрованы. Введите пароль, чтобы открыть их на этом устройстве.',
      unlockLeadSafe: 'Ваши данные зашифрованы. Введите пароль сейфа, чтобы открыть их на этом устройстве.',
      pw: 'Пароль', vaultPw: 'Пароль сейфа', vaultPw2: 'Пароль сейфа ещё раз', unlock: 'Открыть', useRk: 'Открыть ключом восстановления', usePw: 'Открыть паролем',
      rk: 'Ключ восстановления', remember: 'Держать открытым на этом устройстве', wrongPw: 'Этот пароль не открывает сейф.', wrongRk: 'Этот ключ не открывает сейф.',
      setTitle: 'Придумайте пароль сейфа', setLead: 'Вы входите через Google или Apple, поэтому для шифрования нужен отдельный пароль. Мы его не видим. Минимум 8 символов.',
      setShort: 'Минимум 8 символов.', setMismatch: 'Пароли не совпадают.', create: 'Зашифровать данные',
      migPwLead: 'Чтобы зашифровать данные, введите пароль Finman ещё раз.',
      failed: 'Шифрование не завершилось. Данные целы и не изменились — попробуем снова при следующем входе.',
      signOut: 'Выйти', newPwTitle: 'Новый пароль сейфа',
      syncFail: 'Не удалось сохранить зашифрованную копию. Finman повторит попытку.',
      working: 'Секунду…',
    },
    uk: {
      migTitle: 'Шифруємо ваші дані',
      migLead: 'Відтепер дані Finman шифруються на цьому пристрої. На нашому сервері лишається тільки шифротекст: у Finman ніхто не може прочитати ваші рахунки, транзакції й нотатки.',
      stExport: 'Отримуємо ваші дані', stBuild: 'Збираємо зашифрований сейф', stUpload: 'Зберігаємо зашифровану копію', stPurge: 'Стираємо читабельну копію з сервера',
      rkTitle: 'Ваш ключ відновлення',
      rkLead: 'Цей ключ — єдиний шлях до даних, якщо ви забудете пароль. Відновити його ми не зможемо: ваш пароль і ключ до нас не потрапляють. Збережіть його в менеджері паролів або на папері.',
      rkCopy: 'Скопіювати', rkDownload: 'Завантажити файлом', rkSaved: 'Я зберіг ключ відновлення', rkContinue: 'Продовжити', rkCopied: 'Скопійовано',
      unlockTitle: 'Відкрийте свої дані', unlockLead: 'Ваші дані зашифровані. Введіть пароль, щоб відкрити їх на цьому пристрої.',
      unlockLeadSafe: 'Ваші дані зашифровані. Введіть пароль сейфа, щоб відкрити їх на цьому пристрої.',
      pw: 'Пароль', vaultPw: 'Пароль сейфа', vaultPw2: 'Пароль сейфа ще раз', unlock: 'Відкрити', useRk: 'Відкрити ключем відновлення', usePw: 'Відкрити паролем',
      rk: 'Ключ відновлення', remember: 'Тримати відкритим на цьому пристрої', wrongPw: 'Цей пароль не відкриває сейф.', wrongRk: 'Цей ключ не відкриває сейф.',
      setTitle: 'Придумайте пароль сейфа', setLead: 'Ви входите через Google або Apple, тож для шифрування потрібен окремий пароль. Ми його не бачимо. Щонайменше 8 символів.',
      setShort: 'Щонайменше 8 символів.', setMismatch: 'Паролі не збігаються.', create: 'Зашифрувати дані',
      migPwLead: 'Щоб зашифрувати дані, введіть пароль Finman ще раз.',
      failed: 'Шифрування не завершилося. Дані цілі й не змінилися — спробуємо знову під час наступного входу.',
      signOut: 'Вийти', newPwTitle: 'Новий пароль сейфа',
      syncFail: 'Не вдалося зберегти зашифровану копію. Finman спробує ще раз.',
      working: 'Секунду…',
    },
  };
  function t(k) {
    let lang = 'en';
    try { lang = (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || 'en'; } catch (_) { /* default */ }
    return (S[lang] && S[lang][k]) || S.en[k] || k;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------- state
  const st = {
    mode: 'unknown',      // unknown | legacy | vault
    user: null,
    meta: null,
    vaultKey: null,       // Uint8Array, только в памяти
    engine: null,
    version: 0,
    pending: [],          // несохранённые на сервере запросы (для повтора при конфликте)
    loginCtx: null,       // {kdf, master?, rawPassword?, email} — живёт до ensureReady
    readyPromise: null,
    readyResolve: null,
    syncTimer: null,
    syncing: null,
  };

  function newReady() {
    st.readyPromise = new Promise((r) => { st.readyResolve = r; });
  }
  newReady();

  function token() {
    if (st.logoutToken) return st.logoutToken;
    try { return localStorage.getItem('token'); } catch (_) { return null; }
  }
  // Journal beacon (POST /api/t/me): the event name and a few short flags,
  // never request bodies. The server never sees vault writes, so this is the
  // only way activation and returns of encrypted users reach the metrics.
  function journal(event, props) {
    const tk = token();
    if (!tk || !event) return;
    try {
      origFetch('/api/t/me', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
        body: JSON.stringify({ event, props: props || {}, path: location.pathname }),
      }).catch(() => {});
    } catch (_) { /* analytics never breaks the app */ }
  }

  async function api(path, init = {}) {
    const headers = Object.assign({ Authorization: 'Bearer ' + token() }, init.headers || {});
    if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(init.json); }
    const r = await origFetch(path, Object.assign({}, init, { headers }));
    return r;
  }
  async function apiJson(path, init) {
    const r = await api(path, init);
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    if (!r.ok) {
      const e = new Error((body && body.message) || ('HTTP ' + r.status));
      e.status = r.status; e.body = body; e.code = body && body.code;
      throw e;
    }
    return body;
  }

  // ---------------------------------------------------------------- IndexedDB
  const IDB_NAME = 'finman-vault';
  function idb() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function idbOp(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const out = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); res(out && out.result); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  }
  const idbGet = (k) => idbOp('readonly', (s) => s.get(k)).catch(() => undefined);
  const idbSet = (k, v) => idbOp('readwrite', (s) => s.put(v, k)).catch(() => undefined);
  const idbDel = (k) => idbOp('readwrite', (s) => s.delete(k)).catch(() => undefined);

  // Ключ устройства: неизвлекаемый AES-ключ в IndexedDB, им завёрнут ключ сейфа —
  // перезагрузка страницы не требует пароля. Сервер его не видит; «Выйти» стирает.
  async function rememberDevice(userId, vaultKey) {
    const dk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = C.randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dk, vaultKey));
    await idbSet('dk:' + userId, { dk, iv, ct });
  }
  async function deviceKey(userId) {
    const rec = await idbGet('dk:' + userId);
    if (!rec || !rec.dk) return null;
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, rec.dk, rec.ct));
    } catch (_) { return null; }
  }

  // ---------------------------------------------------------------- engine
  let enginePromise = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function engineLib() {
    if (!enginePromise) {
      const v = (document.querySelector('meta[name="fm-build"]') || {}).content || '';
      enginePromise = Promise.all([
        window.initSqlJs ? null : loadScript('/vendor/sqljs/sql-wasm.js'),
        window.FinmanEngine ? null : loadScript('/js/vault/engine.js' + (v ? '?v=' + v : '')),
      ]).then(async () => {
        const SQL = await window.initSqlJs({ locateFile: () => '/vendor/sqljs/sql-wasm.wasm' });
        return { SQL, FE: window.FinmanEngine };
      });
    }
    return enginePromise;
  }
  // The vault's own users row has no sign-in facts: the first-run screen read
  // email_verified_at / google_id from it and told every verified Google user to
  // "confirm your email". Carry the two facts from /api/auth/me (no Google id itself).
  function engineUser(u) {
    if (!u) return u;
    const out = { ...u };
    if (u.emailVerified !== undefined) out.email_verified_at = u.emailVerified ? (u.email_verified_at || new Date().toISOString().slice(0, 19).replace('T', ' ')) : null;
    if (u.google !== undefined) out.google_id = u.google ? 'google' : null;
    return out;
  }

  async function openEngine(bytes) {
    const { SQL, FE } = await engineLib();
    if (st.engine) { try { st.engine.close(); } catch (_) { /* ignore */ } }
    st.engine = await FE.open({ SQL, bytes, user: engineUser(st.user), serverFetch: (u, i) => api(u, i) });
    return st.engine;
  }

  // ---------------------------------------------------------------- prelogin / auth helpers
  async function prelogin(identifier) {
    try {
      const r = await origFetch('/api/auth/prelogin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(/@/.test(identifier) ? { email: identifier } : { username: identifier }),
      });
      if (!r.ok) return { kdf: 'legacy' };
      return await r.json();
    } catch (_) { return { kdf: 'legacy' }; }
  }

  // Вход: что отправить в поле password.
  async function prepareLogin(identifier, password) {
    const pre = await prelogin(identifier);
    if (pre && pre.kdf === 'fm1' && pre.salt) {
      const master = await C.deriveMaster(password, pre.salt, pre.params);
      st.loginCtx = { kdf: 'fm1', master };
      return { password: await C.authToken(master) };
    }
    st.loginCtx = { kdf: 'legacy', rawPassword: password };
    return { password };
  }

  // Регистрация: сразу схема fm1, пароль на сервер не уходит.
  async function prepareRegister(email, password) {
    const salt = C.newSalt();
    const params = C.DEFAULT_PARAMS;
    const master = await C.deriveMaster(password, salt, params);
    st.loginCtx = { kdf: 'fm1', master, salt, params };
    return { password: await C.authToken(master), kdf_salt: salt, kdf_params: JSON.stringify(params) };
  }

  // Смена пароля / удаление аккаунта: превращает введённые пароли в authToken
  // для пользователей fm1 и готовит новую обёртку ключа сейфа.
  async function passwordFields(current, next) {
    const m = st.meta || (await apiJson('/api/vault/meta').catch(() => null));
    if (!m || m.kdf !== 'fm1') return { currentPassword: current, password: next };
    const curMaster = await C.deriveMaster(current, m.salt, m.params);
    const out = { currentPassword: await C.authToken(curMaster) };
    if (next != null) {
      const newMaster = await C.deriveMaster(next, m.salt, m.params);
      out.password = await C.authToken(newMaster);
      if (st.vaultKey) out.wrapped_pw = await C.wrap(await C.kekFromMaster(newMaster), st.vaultKey, C.wrapAad(st.user.id, 'pw'));
    }
    return out;
  }

  // ---------------------------------------------------------------- UI
  function overlay(html) {
    let host = document.getElementById('fmv-overlay');
    if (!host) {
      host = document.createElement('div');
      host.id = 'fmv-overlay';
      host.className = 'fmv-overlay';
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');
      document.body.appendChild(host);
    }
    host.innerHTML = '<div class="fmv-card"><div class="fmv-lock" aria-hidden="true"><i class="fas fa-lock"></i></div>' + html + '</div>';
    const f = host.querySelector('input,button');
    if (f) setTimeout(() => f.focus(), 30);
    return host;
  }
  function closeOverlay() {
    const host = document.getElementById('fmv-overlay');
    if (host) host.remove();
  }
  function steps(active, done) {
    const keys = ['stExport', 'stBuild', 'stUpload', 'stPurge'];
    return '<ol class="fmv-steps">' + keys.map((k, i) =>
      `<li class="${i < done ? 'is-done' : i === active ? 'is-active' : ''}">${esc(t(k))}</li>`).join('') + '</ol>';
  }
  function showMigration(active, done) {
    overlay(`<h2>${esc(t('migTitle'))}</h2><p>${esc(t('migLead'))}</p>${steps(active, done)}`);
  }

  function askSecret({ title, lead, mode, error }) {
    // mode: 'unlock-pw' | 'unlock-safe' | 'set-safe' | 'mig-pw'
    return new Promise((resolve) => {
      const isSet = mode === 'set-safe';
      const label = mode === 'unlock-safe' || isSet ? t('vaultPw') : t('pw');
      const canRk = mode === 'unlock-pw' || mode === 'unlock-safe';
      if (isSet || mode === 'mig-pw') journal('vault_prompt_shown', { mode });
      const host = overlay(`
        <h2>${esc(title)}</h2><p>${esc(lead)}</p>
        <form class="fmv-form" novalidate>
          <div class="fmv-pw">
            <label class="form-label" for="fmv-secret">${esc(label)}</label>
            <input id="fmv-secret" type="password" class="form-control" autocomplete="${isSet ? 'new-password' : 'current-password'}" required>
            ${isSet ? `<label class="form-label" for="fmv-secret2">${esc(t('vaultPw2'))}</label><input id="fmv-secret2" type="password" class="form-control" autocomplete="new-password" required>` : ''}
          </div>
          <div class="fmv-rk" hidden>
            <label class="form-label" for="fmv-rk">${esc(t('rk'))}</label>
            <input id="fmv-rk" type="text" class="form-control fmv-mono" autocomplete="off" spellcheck="false" placeholder="FM1-XXXX-XXXX-…">
          </div>
          <label class="fmv-check"><input type="checkbox" id="fmv-remember" checked> ${esc(t('remember'))}</label>
          <p class="auth-error fmv-err" role="alert" ${error ? '' : 'hidden'}>${esc(error || '')}</p>
          <button type="submit" class="btn btn-primary fmv-wide">${esc(isSet ? t('create') : t('unlock'))}</button>
          ${canRk ? `<button type="button" class="btn btn-link fmv-toggle">${esc(t('useRk'))}</button>` : ''}
          <button type="button" class="btn btn-link fmv-signout">${esc(t('signOut'))}</button>
        </form>`);
      const form = host.querySelector('form');
      const err = host.querySelector('.fmv-err');
      let useRk = false;
      const toggle = host.querySelector('.fmv-toggle');
      if (toggle) toggle.onclick = () => {
        useRk = !useRk;
        host.querySelector('.fmv-pw').hidden = useRk;
        host.querySelector('.fmv-rk').hidden = !useRk;
        toggle.textContent = useRk ? t('usePw') : t('useRk');
        (useRk ? host.querySelector('#fmv-rk') : host.querySelector('#fmv-secret')).focus();
      };
      host.querySelector('.fmv-signout').onclick = () => { resolve({ signOut: true }); };
      form.onsubmit = (e) => {
        e.preventDefault();
        err.hidden = true;
        const remember = host.querySelector('#fmv-remember').checked;
        if (useRk) return resolve({ recovery: host.querySelector('#fmv-rk').value, remember, fail: (m) => { err.textContent = m; err.hidden = false; } });
        const v = host.querySelector('#fmv-secret').value;
        if (isSet) {
          if (v.length < 8) { err.textContent = t('setShort'); err.hidden = false; return; }
          if (v !== host.querySelector('#fmv-secret2').value) { err.textContent = t('setMismatch'); err.hidden = false; return; }
        }
        if (!v) return;
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = t('working');
        resolve({ secret: v, remember, fail: (m) => { btn.disabled = false; btn.textContent = isSet ? t('create') : t('unlock'); err.textContent = m; err.hidden = false; } });
      };
    });
  }

  function showRecoveryKey(text) {
    journal('vault_key_shown', {});
    return new Promise((resolve) => {
      const host = overlay(`
        <h2>${esc(t('rkTitle'))}</h2><p>${esc(t('rkLead'))}</p>
        <div class="fmv-rkbox fmv-mono" id="fmv-rktext">${esc(text)}</div>
        <div class="fmv-row">
          <button type="button" class="btn btn-outline fmv-copy"><i class="fas fa-copy" aria-hidden="true"></i> ${esc(t('rkCopy'))}</button>
          <button type="button" class="btn btn-outline fmv-dl"><i class="fas fa-download" aria-hidden="true"></i> ${esc(t('rkDownload'))}</button>
        </div>
        <label class="fmv-check"><input type="checkbox" id="fmv-saved"> ${esc(t('rkSaved'))}</label>
        <button type="button" class="btn btn-primary fmv-wide fmv-go" disabled>${esc(t('rkContinue'))}</button>`);
      host.querySelector('.fmv-copy').onclick = async (e) => {
        const btn = e.currentTarget; // currentTarget is null after the await
        try { await navigator.clipboard.writeText(text); btn.textContent = t('rkCopied'); } catch (_) { /* select manually */ }
      };
      host.querySelector('.fmv-dl').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([
          'Finman recovery key\n\n' + text + '\n\nAccount: ' + (st.user && st.user.email || '') +
          '\nKeep this file private. It opens your encrypted Finman data if you forget your password.\n'], { type: 'text/plain' }));
        a.download = 'finman-recovery-key.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
      const cb = host.querySelector('#fmv-saved');
      const go = host.querySelector('.fmv-go');
      const sync = () => { go.disabled = !cb.checked; };
      cb.onchange = sync;
      cb.oninput = sync;
      // Copying or downloading the key is saving it: tick the box so Continue opens.
      const saved = () => { cb.checked = true; sync(); };
      host.querySelector('.fmv-copy').addEventListener('click', saved);
      host.querySelector('.fmv-dl').addEventListener('click', saved);
      go.onclick = () => { journal('vault_key_saved', {}); resolve(); };
    });
  }

  // ---------------------------------------------------------------- vault open
  async function kekFromSecret(secret) {
    const m = st.meta;
    const master = await C.deriveMaster(secret, m.salt, m.params);
    return C.kekFromMaster(master);
  }

  async function obtainVaultKey() {
    const m = st.meta;
    const uid = st.user.id;
    const dk = await deviceKey(uid);
    if (dk) return dk;
    if (st.loginCtx && st.loginCtx.master && m.wrapped_pw) {
      try {
        const vk = await C.unwrap(await C.kekFromMaster(st.loginCtx.master), m.wrapped_pw, C.wrapAad(uid, 'pw'));
        await rememberDevice(uid, vk);
        return vk;
      } catch (_) { /* fall through to the prompt */ }
    }
    let lastError = null;
    for (;;) {
      const ans = await askSecret({
        title: t('unlockTitle'),
        lead: m.hasPassword ? t('unlockLead') : t('unlockLeadSafe'),
        mode: m.hasPassword ? 'unlock-pw' : 'unlock-safe',
        error: lastError,
      });
      if (ans.signOut) { signOutNow(); return null; }
      try {
        let vk;
        if (ans.recovery != null) {
          vk = await C.unwrap(await C.kekFromRecovery(C.parseRecoveryKey(ans.recovery)), m.wrapped_rc, C.wrapAad(uid, 'rc'));
          if (!m.hasPassword) await resetSafePassword(vk);
        } else {
          vk = await C.unwrap(await kekFromSecret(ans.secret), m.wrapped_pw, C.wrapAad(uid, 'pw'));
        }
        if (ans.remember) await rememberDevice(uid, vk);
        return vk;
      } catch (e) {
        lastError = ans.recovery != null ? t('wrongRk') : t('wrongPw');
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  // Google/Apple: забыли пароль сейфа → открыли ключом восстановления → новый пароль сейфа.
  async function resetSafePassword(vk) {
    const ans = await askSecret({ title: t('newPwTitle'), lead: t('setLead'), mode: 'set-safe' });
    if (!ans.secret) return;
    const wrapped = await C.wrap(await kekFromSecret(ans.secret), vk, C.wrapAad(st.user.id, 'pw'));
    await apiJson('/api/vault/rewrap', { method: 'POST', json: { wrapped_pw: wrapped } });
    st.meta.wrapped_pw = wrapped;
  }

  async function loadBytes(vk) {
    const uid = st.user.id;
    const cached = await idbGet('blob:' + uid);
    // Local copy of the same version: use it; if it was saved locally but never reached
    // the server (tab closed within the debounce), upload it now.
    if (cached && cached.blob && cached.version === st.meta.version) {
      return { bytes: await C.decryptVault(vk, cached.blob, uid), dirty: !!cached.dirty };
    }
    const r = await api('/api/vault/blob');
    if (!r.ok) throw new Error('Could not download the vault (HTTP ' + r.status + ')');
    const blob = new Uint8Array(await r.arrayBuffer());
    st.meta.version = Number(r.headers.get('X-Vault-Version')) || st.meta.version;
    if (cached && cached.blob && cached.dirty && cached.inflight && cached.inflight.to === st.meta.version) {
      // Our own upload reached the server, but the tab closed before it heard back.
      // The local copy holds everything that was sent plus anything written after it:
      // keep it on top of the new version and upload it again.
      await idbSet('blob:' + uid, { version: st.meta.version, blob: cached.blob, dirty: true, inflight: null });
      return { bytes: await C.decryptVault(vk, cached.blob, uid), dirty: true };
    }
    if (cached && cached.dirty && cached.version < st.meta.version) {
      // Another device saved a newer version meanwhile; its copy wins (v1: no merge).
      console.warn('Finman Vault: a newer version from another device replaced unsent local changes');
    }
    await idbSet('blob:' + uid, { version: st.meta.version, blob, dirty: false });
    return { bytes: await C.decryptVault(vk, blob, uid), dirty: false };
  }

  // ---------------------------------------------------------------- migration
  async function migrate() {
    const uid = st.user.id;
    const m = st.meta;
    let secret = null;
    let master = st.loginCtx && st.loginCtx.master;
    const raw = st.loginCtx && st.loginCtx.rawPassword;
    let salt = (st.loginCtx && st.loginCtx.salt) || (m.kdf === 'fm1' ? m.salt : null);
    let params = (st.loginCtx && st.loginCtx.params) || (m.kdf === 'fm1' ? m.params : C.DEFAULT_PARAMS);
    let currentPassword = raw || null;

    if (!master) {
      if (m.hasPassword) {
        if (m.kdf === 'fm1') {
          for (;;) {
            const ans = await askSecret({ title: t('migTitle'), lead: t('migPwLead'), mode: 'mig-pw' });
            if (ans.signOut) { signOutNow(); return false; }
            master = await C.deriveMaster(ans.secret, m.salt, m.params);
            break;
          }
        } else {
          if (!currentPassword) {
            const ans = await askSecret({ title: t('migTitle'), lead: t('migPwLead'), mode: 'mig-pw' });
            if (ans.signOut) { signOutNow(); return false; }
            currentPassword = ans.secret;
          }
          secret = currentPassword;
        }
      } else {
        const ans = await askSecret({ title: t('setTitle'), lead: t('setLead'), mode: 'set-safe' });
        if (ans.signOut) { signOutNow(); return false; }
        secret = ans.secret;
      }
    } else if (raw) {
      currentPassword = raw;
    }
    if (!master) {
      salt = C.newSalt();
      params = C.DEFAULT_PARAMS;
      master = await C.deriveMaster(secret, salt, params);
    }

    showMigration(0, 0);
    const dump = await apiJson('/api/vault/legacy-export');
    showMigration(1, 1);
    const eng = await openEngine(null);
    await eng.importLegacy({ tables: dump.tables || {}, user: dump.user || st.user });
    const counts = eng.counts();
    const vk = C.newVaultKey();
    const rk = C.newRecoveryKey();
    const blob = await C.encryptVault(vk, eng.export(), uid);
    showMigration(2, 2);
    const body = {
      blob_b64: C.b64(blob),
      wrapped_pw: await C.wrap(await C.kekFromMaster(master), vk, C.wrapAad(uid, 'pw')),
      wrapped_rc: await C.wrap(await C.kekFromRecovery(rk.bytes), vk, C.wrapAad(uid, 'rc')),
      kdf_salt: salt,
      kdf_params: typeof params === 'string' ? params : JSON.stringify(params),
    };
    if (m.hasPassword) {
      body.auth_token = await C.authToken(master);
      if (currentPassword && m.kdf !== 'fm1') body.current_password = currentPassword;
    }
    const setup = await apiJson('/api/vault/setup', { method: 'POST', json: body });
    if (setup && setup.token) { try { localStorage.setItem('token', setup.token); } catch (_) { /* ignore */ } }
    st.vaultKey = vk;
    st.version = (setup && setup.version) || 1;
    await idbSet('blob:' + uid, { version: st.version, blob, dirty: false });
    await rememberDevice(uid, vk);
    await showRecoveryKey(rk.text);
    showMigration(3, 3);
    await purge(counts);
    return true;
  }

  async function purge(counts) {
    await apiJson('/api/vault/purge-legacy', { method: 'POST', json: { counts } });
    // Старые ответы API в кэше Service Worker были открытым текстом — убираем.
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'clear-api-cache' });
      if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.filter((k) => /api/i.test(k)).map((k) => caches.delete(k))); }
    } catch (_) { /* ignore */ }
  }

  // Сейф создан, но открытые строки ещё на сервере (прервались на ключе восстановления).
  async function finishInterrupted(vk) {
    const uid = st.user.id;
    const dump = await apiJson('/api/vault/legacy-export');
    const eng = await openEngine(null);
    await eng.importLegacy({ tables: dump.tables || {}, user: dump.user || st.user });
    const counts = eng.counts();
    const blob = await C.encryptVault(vk, eng.export(), uid);
    const v = await putBlob(blob, st.meta.version);
    const rk = C.newRecoveryKey();
    const wrapped_rc = await C.wrap(await C.kekFromRecovery(rk.bytes), vk, C.wrapAad(uid, 'rc'));
    await apiJson('/api/vault/rewrap', { method: 'POST', json: { wrapped_rc } });
    st.version = v;
    await idbSet('blob:' + uid, { version: v, blob, dirty: false });
    await showRecoveryKey(rk.text);
    showMigration(3, 3);
    await purge(counts);
  }

  // Rows of tables that joined the vault after this account's own migration (the invoices,
  // 23.11.2026) still sit on the server in the open. Bring them into the vault, store the vault,
  // and only then let the server delete exactly those rows (it re-counts them first).
  async function lateImport() {
    const dump = await apiJson('/api/vault/legacy-export');
    const tables = {};
    const counts = {};
    for (const [name, rows] of Object.entries((dump && dump.tables) || {})) {
      if (Array.isArray(rows) && rows.length) { tables[name] = rows; counts[name] = rows.length; }
    }
    if (!Object.keys(tables).length) return;
    showMigration(1, 3);
    const moved = await makeRoom(tables);
    const r = await st.engine.importLegacy({ tables });
    for (const name of Object.keys(counts)) {
      if (((r && r.counts && r.counts[name]) || 0) !== counts[name]) throw new Error('Import check failed: ' + name);
    }
    const blob = await C.encryptVault(st.vaultKey, st.engine.export(), st.user.id);
    showMigration(2, 3);
    st.version = await putBlob(blob, st.version);
    st.engine.dirty = false;
    await idbSet('blob:' + st.user.id, { version: st.version, blob, dirty: false });
    await apiJson('/api/vault/purge-legacy', { method: 'POST', json: { counts, scope: Object.keys(counts) } });
    if (moved.invoices && Object.keys(moved.invoices).length) {
      await apiJson('/api/invoice-links/rekey', { method: 'POST', json: { map: moved.invoices } }).catch(() => {});
    }
    showMigration(3, 3);
  }

  // Incoming rows never overwrite what is already in the vault (importLegacy writes INSERT OR
  // REPLACE): an id the vault already uses gets the next free one, references follow; an
  // invoice number the vault already has gets a suffix. Returns { table: { oldId: newId } }.
  const LATE_REFS = {
    invoices: [['profile_id', 'invoice_profiles']],
    invoice_payments: [['invoice_id', 'invoices']],
    invoice_repeats: [['invoice_id', 'invoices'], ['last_invoice_id', 'invoices']],
  };
  async function makeRoom(tables) {
    const maps = {};
    for (const name of Object.keys(tables)) {
      const rows = tables[name];
      for (const [col, parent] of LATE_REFS[name] || []) {
        const m = maps[parent];
        if (m) for (const row of rows) if (row[col] != null && m[row[col]] != null) row[col] = typeof m[row[col]] === 'object' ? m[row[col]].to : m[row[col]];
      }
      let local = [];
      try { local = await st.engine.query(`SELECT id${name === 'invoices' ? ', number' : ''} FROM "${name}"`); } catch (_) { local = []; }
      const taken = new Set(local.map((x) => Number(x.id)));
      let next = Math.max(0, ...local.map((x) => Number(x.id) || 0), ...rows.map((x) => Number(x.id) || 0)) + 1;
      const m = {};
      for (const row of rows) {
        if (!taken.has(Number(row.id))) continue;
        // invoices: the number goes along, so the server moves only the link published for THIS one
        m[row.id] = name === 'invoices' ? { to: next, number: String(row.number) } : next;
        row.id = next; next += 1;
      }
      if (Object.keys(m).length) maps[name] = m;
      if (name === 'invoices') {
        const numbers = new Set(local.map((x) => String(x.number)));
        for (const row of rows) {
          let n = String(row.number); let k = 2;
          while (numbers.has(n)) { n = `${row.number}-${k}`; k += 1; }
          row.number = n; numbers.add(n);
        }
      }
    }
    return maps;
  }

  // ---------------------------------------------------------------- sync
  async function putBlob(blob, ifMatch) {
    const r = await api('/api/vault/blob', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(ifMatch) }, body: blob });
    if (r.status === 409) { const e = new Error('conflict'); e.code = 'VERSION_CONFLICT'; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return j.version;
  }

  // Local encrypted copy in IndexedDB. Writes go through one queue and export the
  // engine when they run, so an older snapshot never lands after a newer one.
  // `inflight` marks an upload the server may already have taken (see loadBytes).
  let localQueue = Promise.resolve();
  function saveLocal(dirty) {
    const job = async () => {
      const blob = await C.encryptVault(st.vaultKey, st.engine.export(), st.user.id);
      await idbSet('blob:' + st.user.id, { version: st.version, blob, dirty, inflight: st.inflight || null });
      return blob;
    };
    const p = localQueue.then(job, job);
    localQueue = p.catch(() => {});
    return p;
  }
  function saveLocalBlob(blob, dirty) {
    const job = () => idbSet('blob:' + st.user.id, { version: st.version, blob, dirty, inflight: null });
    const p = localQueue.then(job, job);
    localQueue = p.catch(() => {});
    return p;
  }

  function scheduleSync() {
    clearTimeout(st.syncTimer);
    st.syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, 1200);
  }

  async function syncNow() {
    if (st.mode !== 'vault' || !st.engine) return;
    if (st.syncing) { await st.syncing; if (!st.engine.dirty && !st.pending.length) return; }
    st.syncing = (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const sent = st.pending.length;
        st.engine.dirty = false;
        st.inflight = { to: st.version + 1 };
        const blob = await saveLocal(true);
        try {
          st.version = await putBlob(blob, st.version);
          st.inflight = null;
          st.pending.splice(0, sent);
          // Changes made while the upload was in flight are not in `blob`: store the
          // current state on top of the new version and upload it next.
          if (st.engine.dirty || st.pending.length) {
            await saveLocal(true);
            scheduleSync();
          } else {
            await saveLocalBlob(blob, false);
          }
          return;
        } catch (e) {
          st.inflight = null;
          if (e.code !== 'VERSION_CONFLICT') {
            st.engine.dirty = true;
            setTimeout(scheduleSync, 5000 * (attempt + 1));
            return;
          }
          // Другое устройство сохранило раньше: берём его версию и повторяем свои запросы.
          const meta = await apiJson('/api/vault/meta');
          st.meta.version = meta.version;
          const r = await api('/api/vault/blob');
          const remote = new Uint8Array(await r.arrayBuffer());
          st.version = Number(r.headers.get('X-Vault-Version')) || meta.version;
          await openEngine(await C.decryptVault(st.vaultKey, remote, st.user.id));
          for (const op of st.pending) { try { await st.engine.handle(op); } catch (_) { /* skip op */ } }
        }
      }
    })().finally(() => { st.syncing = null; });
    return st.syncing;
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && st.engine && st.engine.dirty) syncNow().catch(() => {}); });

  // ---------------------------------------------------------------- fetch interception
  async function toEngineRequest(input, init) {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), location.href);
    const method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
    const headers = {};
    new Headers((init && init.headers) || (req && req.headers) || {}).forEach((v, k) => { headers[k] = v; });
    let body = init && init.body !== undefined ? init.body : (req && method !== 'GET' && method !== 'HEAD' ? await req.clone().text() : undefined);
    const files = [];
    if (body instanceof FormData) {
      const obj = {};
      for (const [k, v] of body.entries()) {
        if (typeof v === 'object' && v && 'arrayBuffer' in v) {
          files.push({ fieldname: k, originalname: v.name || 'file', mimetype: v.type || 'application/octet-stream', size: v.size, buffer: new Uint8Array(await v.arrayBuffer()) });
        } else obj[k] = v;
      }
      body = obj;
    } else if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries());
    } else if (typeof body === 'string') {
      const ct = headers['content-type'] || '';
      if (/json/i.test(ct) || /^\s*[[{]/.test(body)) { try { body = JSON.parse(body); } catch (_) { /* keep text */ } }
    } else if (body instanceof Blob) {
      body = await body.text();
      try { body = JSON.parse(body); } catch (_) { /* keep text */ }
    }
    return { method, url: url.pathname + url.search, headers, body: body == null ? {} : body, files };
  }

  function journalWrite(method, pathname, res) {
    try {
      const FE = window.FinmanEngine;
      if (!FE || typeof FE.eventFor !== 'function') return;
      const ok = res.status < 400;
      const event = FE.eventFor(method, pathname, ok);
      if (!event) return;
      const props = { local: true };
      if (!ok && typeof res.body === 'string') {
        try { const b = JSON.parse(res.body); const c = b && (b.code || (b.error && b.error.code)); if (c) props.code = String(c).slice(0, 40); } catch (_) { /* not JSON */ }
      }
      journal(event, props);
    } catch (_) { /* analytics never breaks the app */ }
  }

  const SERVER_ONLY = /^\/api\/(auth|t|vault|health|ready|billing|invoice-links|invoice-shares|v1|oauth|mcp)(\/|$)/;

  window.fetch = async function (input, init) {
    let path;
    try { path = new URL(input instanceof Request ? input.url : String(input), location.href); } catch (_) { return origFetch(input, init); }
    if (path.origin !== location.origin || !path.pathname.startsWith('/api/') || st.mode === 'legacy') return origFetch(input, init);
    if (st.mode !== 'vault') {
      // Вход, аналитика, оплата и сам сейф идут на сервер всегда. Всё остальное при
      // наличии сессии ждёт решения ensureReady(): иначе ранний запрос модуля (до
      // открытия сейфа) ушёл бы на сервер, а запись — открытым текстом.
      if (SERVER_ONLY.test(path.pathname) || !token()) return origFetch(input, init);
      await st.readyPromise;
      if (st.mode !== 'vault') return origFetch(input, init);
    }
    const method = String((init && init.method) || (input instanceof Request && input.method) || 'GET').toUpperCase();
    if (!st.engine.isLocal(method, path.pathname)) return origFetch(input, init);
    const op = await toEngineRequest(input, init);
    const res = await st.engine.handle(op);
    if (method !== 'GET' && method !== 'HEAD') journalWrite(method, path.pathname, res);
    if (method !== 'GET' && method !== 'HEAD' && res.status < 400) {
      st.pending.push(op);
      st.engine.dirty = true;
      saveLocal(true).catch(() => {});
      scheduleSync();
    }
    const h = new Headers(res.headers || {});
    if (res.contentType && !h.has('content-type')) h.set('content-type', res.contentType);
    return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: h });
  };

  // ---------------------------------------------------------------- lifecycle
  function signOutNow() {
    closeOverlay();
    st.mode = 'unknown';
    if (typeof window.logout === 'function') window.logout();
    else { try { localStorage.removeItem('token'); } catch (_) { /* ignore */ } location.reload(); }
  }

  // app.js logout() removes the token right after calling this: keep it for the last save.
  async function onLogout() {
    const uid = st.user && st.user.id;
    st.logoutToken = token();
    clearTimeout(st.syncTimer);
    if (st.engine && (st.engine.dirty || st.pending.length)) { try { await syncNow(); } catch (_) { /* ignore */ } }
    st.logoutToken = null;
    if (uid) { await idbDel('dk:' + uid); await idbDel('blob:' + uid); }
    if (st.engine) { try { st.engine.close(); } catch (_) { /* ignore */ } }
    st.engine = null; st.vaultKey = null; st.user = null; st.meta = null; st.pending = []; st.loginCtx = null;
    st.mode = 'unknown'; st.waiting = false;
    newReady();
  }

  // Вызывается из initApp() после /api/auth/me. true — можно рисовать приложение.
  async function ensureReady(user) {
    if (!C || !window.crypto || !window.crypto.subtle || !window.indexedDB) {
      st.mode = 'legacy'; st.readyResolve(); return true;
    }
    if (st.mode === 'vault' && st.user && user && st.user.id === user.id) return true;
    st.user = user; st.waiting = true;
    try {
      st.meta = await apiJson('/api/vault/meta');
    } catch (e) {
      if (e.status === 404) { st.mode = 'legacy'; st.waiting = false; st.readyResolve(); return true; }
      throw e;
    }
    try {
      if (!st.meta.version) {
        const ok = await migrate();
        if (!ok) return false;
      } else {
        const vk = await obtainVaultKey();
        if (!vk) return false;
        st.vaultKey = vk;
        if (st.meta.state !== 'active') {
          await finishInterrupted(vk);
        } else {
          const loaded = await loadBytes(vk);
          st.version = st.meta.version;
          await openEngine(loaded.bytes);
          if (loaded.dirty) { st.engine.dirty = true; scheduleSync(); }
          else if (st.meta.legacyRows > 0) await lateImport();
        }
      }
      st.mode = 'vault';
      st.loginCtx = null;
      closeOverlay();
      st.waiting = false;
      st.readyResolve();
      return true;
    } catch (e) {
      console.error('Vault:', e);
      overlay(`<h2>${esc(t('migTitle'))}</h2><p>${esc(t('failed'))}</p><p class="fmv-small">${esc(e.message || '')}</p>
        <button type="button" class="btn btn-primary fmv-wide" id="fmv-retry">${esc(t('rkContinue'))}</button>`);
      await new Promise((r) => { document.getElementById('fmv-retry').onclick = r; });
      closeOverlay();
      if (st.meta && st.meta.state === 'active') { location.reload(); return false; }
      // Сейфа ещё нет — работаем по-старому до следующего входа, данные не тронуты.
      st.mode = 'legacy'; st.waiting = false; st.readyResolve();
      return true;
    }
  }

  async function newRecoveryKey() {
    if (!st.vaultKey) throw new Error('Vault is locked');
    const rk = C.newRecoveryKey();
    const wrapped_rc = await C.wrap(await C.kekFromRecovery(rk.bytes), st.vaultKey, C.wrapAad(st.user.id, 'rc'));
    await apiJson('/api/vault/rewrap', { method: 'POST', json: { wrapped_rc } });
    await showRecoveryKey(rk.text);
    closeOverlay();
  }

  function status() {
    return { mode: st.mode, version: st.version, pending: st.pending.length, dirty: !!(st.engine && st.engine.dirty) };
  }

  window.FMVault = {
    prepareLogin, prepareRegister, passwordFields, ensureReady, onLogout, syncNow, newRecoveryKey, status,
    afterPasswordChange(wrapped) { if (st.meta && wrapped) st.meta.wrapped_pw = wrapped; },
    lock: async () => { await onLogout(); location.reload(); },
    journal,
    // для MCP по согласию (страница OAuth): ключ сейфа заворачивается секретом гранта
    async wrapForGrant(secretBytes) {
      if (!st.vaultKey) throw new Error('Vault is locked');
      return C.wrap(await C.kekFromGrant(secretBytes), st.vaultKey, C.wrapAad(st.user.id, 'grant'));
    },
    _state: st,
  };
})();
