const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const config = require('../config/config');
const { googleEnabled } = require('../services/authService');
const emailVerify = require('../services/emailVerify');
const { handleSignup } = require('../services/signupFlow');
const tracker = require('../services/tracker');
const appHandoff = require('../services/appHandoff');
const appleAuth = require('../services/appleAuth');
const { deleteUserData } = require('../services/accountDeletion');
const vault = require('../services/vault');

const router = express.Router();

// One payload for every sign-in path: { id, tv } — tv is users.token_version,
// bumped on password change so older tokens are rejected (authService).
function signToken(user) {
  return jwt.sign({ id: user.id, tv: Number(user.token_version || 0) }, config.jwtSecret, {
    expiresIn: config.jwtExpiration
  });
}

// Валидация токена (для frontend)
router.get('/validate', passport.authenticate('jwt', { session: false }), (req, res) => {
  res.json({ valid: true, user: { id: req.user.id, username: req.user.username } });
});

// Finman Vault: how this login derives its password before sending it.
// Body { email } or { username } (the login field takes either, like the local strategy).
// Unknown login -> 'fm1' with a stable fake salt, so the answer does not reveal whether
// the account exists (beyond legacy/fm1 for real ones).
router.post('/prelogin', async (req, res) => {
  try {
    const b = req.body || {};
    const login = String(b.email || b.username || '').trim();
    if (!login || login.length > 320) return res.status(400).json({ error: true, message: 'Email or username is required' });
    const user = login.includes('@') ? await User.findByEmail(login) : await User.findByUsername(login);
    if (user && user.kdf === 'fm1' && user.kdf_salt) {
      let params = vault.DEFAULT_PARAMS;
      try { params = JSON.parse(user.kdf_params) || params; } catch (_) { /* default */ }
      return res.json({ kdf: 'fm1', salt: user.kdf_salt, params });
    }
    if (user) return res.json({ kdf: 'legacy', salt: null, params: null });
    return res.json({ kdf: 'fm1', salt: vault.fakeSalt(login), params: vault.DEFAULT_PARAMS });
  } catch (error) {
    console.error('Prelogin error:', error.message);
    return res.status(500).json({ error: true, message: 'Prelogin failed' });
  }
});

// --- Вход через Google (портировано из прод-линейки) -----------------------

// Фронтенд спрашивает, показывать ли кнопку, а не угадывает по env.
router.get('/google/status', (req, res) => res.json({ enabled: googleEnabled() }));

router.get('/google', (req, res, next) => {
  if (!googleEnabled()) {
    return res.status(503).json({ error: true, message: 'Google sign-in is not configured' });
  }
  // Откуда пришёл человек (utm, referrer, лендинг) — до возврата из Google
  // держим в сессии; googleVerify запишет это новому аккаунту.
  if (req.query.att && req.session && String(req.query.att).length <= 4000) {
    req.session.signupAtt = String(req.query.att);
  }
  // Native app: the system browser runs this flow and the app claims the result
  // later with the same nonce (services/appHandoff.js). Anything else clears it,
  // so a website sign-in in the same browser never lands in the hand-off.
  if (req.session) {
    if (appHandoff.isValidNonce(req.query.app_nonce)) req.session.appNonce = req.query.app_nonce;
    else delete req.session.appNonce;
  }
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  if (!googleEnabled()) {
    return res.status(503).json({ error: true, message: 'Google sign-in is not configured' });
  }
  passport.authenticate('google', { session: false }, async (err, user, info) => {
    const appNonce = req.session && req.session.appNonce;
    if (appNonce && req.session) delete req.session.appNonce;
    // App flow: leave the result for /app/claim, then send the browser to a
    // page whose button reopens the app. The token never appears in a URL.
    const toApp = async (result) => {
      try {
        await appHandoff.store(appNonce, result);
      } catch (e) {
        console.error('App hand-off store error:', e.message);
        return res.redirect('/app-return.html?error=google_failed');
      }
      return res.redirect(result.error ? '/app-return.html?error=' + encodeURIComponent(result.error) : '/app-return.html');
    };
    const fail = (reason) => {
      if (appNonce) return toApp({ error: reason });
      return res.redirect(config.google.successRedirect + '?auth_error=' + encodeURIComponent(reason));
    };
    if (err) { console.error('Google callback error:', err); return fail('google_failed'); }
    if (!user) {
      const reason = info && info.message === 'email_exists' ? 'email_exists' : 'google_denied';
      return fail(reason);
    }
    try {
      // Тот же payload, что и у входа по паролю.
      const token = signToken(user);
      tracker.track('login', { userId: user.id, props: { method: appNonce ? 'google_app' : 'google' }, req, test: tracker.isTestEmail(user.email) });
      if (appNonce) return toApp({ token });
      // Токен уезжает во фрагменте URL — так он не попадает в серверные логи.
      return res.redirect(config.google.successRedirect + '#token=' + encodeURIComponent(token));
    } catch (e) {
      console.error('Google callback token error:', e);
      return fail('google_failed');
    }
  })(req, res, next);
});

// Native app picks up the Google result left by the callback. One-time: the row
// is deleted on the first claim. 404 when missing, expired or already claimed.
router.post('/app/claim', async (req, res) => {
  const nonce = req.body && req.body.nonce;
  if (!appHandoff.isValidNonce(nonce)) {
    return res.status(400).json({ error: 'invalid_nonce' });
  }
  try {
    const result = await appHandoff.claim(nonce);
    if (!result) return res.status(404).json({ error: 'not_found' });
    return res.json(result);
  } catch (e) {
    console.error('App hand-off claim error:', e.message);
    return res.status(500).json({ error: 'claim_failed' });
  }
});

// Sign in with Apple (native iOS app). Body: { identityToken, authorizationCode,
// nonce, givenName, familyName, attribution }. Answers like /login.
router.post('/apple', async (req, res) => {
  const b = req.body || {};
  try {
    const identity = await appleAuth.verifyIdentityToken(b.identityToken, b.nonce);
    const { user, created } = await appleAuth.findOrCreateUser(identity, {
      givenName: b.givenName, familyName: b.familyName, attribution: b.attribution, req,
    });
    await appleAuth.storeRefreshToken(user.id, b.authorizationCode);
    const token = signToken(user);
    tracker.track('login', { userId: user.id, props: { method: 'apple', created }, req, test: tracker.isTestEmail(user.email) });
    return res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, fullName: user.full_name },
    });
  } catch (e) {
    if (e instanceof appleAuth.AppleAuthError) {
      return res.status(e.status).json({ error: true, code: e.code, message: APPLE_MESSAGES[e.code] || 'Apple sign-in failed' });
    }
    console.error('Apple sign-in error:', e.message);
    return res.status(500).json({ error: true, code: 'apple_failed', message: 'Apple sign-in failed' });
  }
});

const APPLE_MESSAGES = {
  email_exists: 'An account with this email already exists. Sign in with your password.',
  email_missing: 'Apple did not share an email address. Try again and choose to share your email.',
  token_expired: 'The Apple sign-in expired. Try again.',
  invalid_nonce: 'Apple sign-in could not be verified. Try again.',
  invalid_token: 'Apple sign-in could not be verified. Try again.',
  apple_keys_unavailable: 'Apple sign-in is unavailable right now. Try again later.',
};

// Delete the account and all of its data (Settings > Danger zone).
// Body: { confirm: "DELETE", password } — password only for accounts that have one.
router.delete('/me', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.confirm !== 'DELETE') {
      return res.status(400).json({ error: true, code: 'confirm_required', message: 'Type DELETE to confirm' });
    }
    const methods = await User.authMethods(req.user.id);
    if (methods.password) {
      const full = await User.findByUsername(req.user.username);
      const ok = Boolean(full) && typeof b.password === 'string' && b.password.length > 0 &&
        await User.verifyPassword(full, b.password);
      // 400, never 401: the client treats 401 as an expired session.
      if (!ok) return res.status(400).json({ error: true, code: 'wrong_password', message: 'Current password is incorrect' });
    }
    const appleToken = methods.apple ? await appleAuth.appleRefreshTokenOf(req.user.id) : null;
    const test = tracker.isTestEmail(req.user.email);
    const result = await deleteUserData(req.user.id);
    if (!result.deleted) return res.status(404).json({ error: true, message: 'User not found' });
    if (appleToken) await appleAuth.revokeRefreshToken(appleToken);
    // No user id, IP or email: only which sign-in the account used.
    tracker.track('account_deleted', {
      props: { method: methods.apple ? 'apple' : methods.google ? 'google' : 'password' },
      ip: null, test,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error('Account deletion error:', e.message);
    return res.status(500).json({ error: true, message: 'Account deletion failed' });
  }
});

// Регистрация
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    // Username is optional since 22.11: the form asks for email + password only,
    // and the username is derived from the email.
    let username = typeof req.body.username === 'string' ? req.body.username.trim() : '';

    // Honeypot: скрытое поле «website» человек не видит и не заполняет.
    // Бот получает обычный «успех» без аккаунта, чтобы не подбирал обход.
    if (req.body.website) {
      console.warn('Registration honeypot hit from', req.ip);
      return res.json({ ok: true, pending: true });
    }

    // Проверка, что обязательные поля заполнены
    if (!email || !password) {
      return res.status(400).json({
        error: true,
        message: 'Email and password are required'
      });
    }

    // Валидация email
    if (!config.isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: 'Invalid email format'
      });
    }

    if (!username) username = await User.usernameFromEmail(email);

    // Валидация username (только буквы, цифры, подчёркивания, 3-30 символов)
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: true,
        message: 'Username must be 3-30 characters (letters, digits, underscores)'
      });
    }

    // Finman Vault: with kdf_salt the browser derived the key, `password` is the authToken.
    let kdfSalt = null;
    let kdfParams = null;
    if (req.body.kdf_salt != null || req.body.kdf_params != null) {
      kdfSalt = req.body.kdf_salt;
      kdfParams = vault.normalizeParams(req.body.kdf_params);
      if (!vault.isSalt(kdfSalt) || !kdfParams) {
        return res.status(400).json({ error: true, code: 'BAD_KDF', message: 'kdf_salt or kdf_params are invalid' });
      }
      if (!vault.isAuthToken(password)) {
        return res.status(400).json({ error: true, code: 'BAD_AUTH_TOKEN', message: 'password must be the derived auth token' });
      }
    }

    // Валидация пароля (минимум 6 символов)
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({
        error: true,
        message: 'Password must be at least 6 characters'
      });
    }
    
    // Проверка, существует ли пользователь с таким именем
    const existingUser = await User.findByUsername(username);
    if (existingUser) {
      return res.status(400).json({ 
        error: true, 
        message: 'A user with this username already exists' 
      });
    }
    
    // Проверка, существует ли пользователь с таким email
    const existingEmail = await User.findByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ 
        error: true, 
        message: 'A user with this email already exists' 
      });
    }
    
    // Создание пользователя
    const newUser = await User.create({
      username,
      email,
      password,
      fullName,
      kdfSalt,
      kdfParams
    });
    
    // Создание токена JWT
    const token = signToken(newUser);

    // Уведомление оператора о регистрации (письмо владельцу; ответ не ждёт).
    // Источник регистрации + письмо с ним (ответ не ждёт).
    await handleSignup(
      { id: newUser.id, username: newUser.username, email: newUser.email, fullName: newUser.fullName },
      'password', req.body.attribution, req
    );
    // Email confirmation (non-blocking: the app works before the link is opened).
    emailVerify.sendVerificationLater(newUser.id, req);
    
    // Отправка токена и данных пользователя
    res.json({
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        fullName: newUser.fullName,
        kdf: newUser.kdf
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Registration failed' 
    });
  }
});

// Вход в систему
router.post('/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err) {
      return next(err);
    }
    
    if (!user) {
      return res.status(401).json({ 
        error: true, 
        message: info.message || 'Invalid username or password' 
      });
    }
    
    // Создание токена JWT
    const token = signToken(user);
    tracker.track('login', { userId: user.id, props: { method: 'password' }, req, test: tracker.isTestEmail(user.email) });

    // Отправка токена и данных пользователя
    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name
      }
    });
  })(req, res, next);
});

// Получение данных текущего пользователя
router.get('/me', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user) { tracker.appOpen(user, req); require('../services/journey').touch(user.id); }
    const methods = await User.authMethods(req.user.id);
    const vaultInfo = (await require('../db/database').get(
      `SELECT u.kdf, u.vault_state, v.version FROM users u LEFT JOIN user_vaults v ON v.user_id = u.id WHERE u.id = ?`,
      [req.user.id]
    ).catch(() => null)) || {};

    if (!user) {
      return res.status(404).json({ 
        error: true, 
        message: 'User not found' 
      });
    }
    
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      createdAt: user.created_at,
      emailVerified: Boolean(user.email_verified_at),
      google: Boolean(user.google_id),
      apple: methods.apple,
      hasPassword: methods.password,
      // Finman Vault: vault_state 'none' | 'active'; vault_version null = no vault uploaded yet.
      kdf: vaultInfo.kdf || 'legacy',
      vault_state: vaultInfo.vault_state || 'none',
      vault_version: vaultInfo.version == null ? null : vaultInfo.version
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to fetch user data' 
    });
  }
});

// Email confirmation. The link in the letter lands here and redirects to the app.
router.get('/verify-email', async (req, res) => {
  try {
    const userId = await emailVerify.verifyToken(req.query.token);
    res.redirect(302, userId ? '/?email_verified=1' : '/?email_verified=0');
  } catch (error) {
    console.error('Email verification error:', error);
    res.redirect(302, '/?email_verified=0');
  }
});

// Resend the confirmation letter (throttled to one per minute).
router.post('/verify-email/send', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const result = await emailVerify.sendVerification(req.user.id, req);
    if (result.reason === 'ALREADY_VERIFIED') return res.json({ success: true, alreadyVerified: true });
    if (result.reason === 'COOLDOWN') {
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({ error: true, message: `Wait ${result.retryAfter} s before sending another letter`, retryAfter: result.retryAfter });
    }
    if (!result.sent && !result.skipped) {
      return res.status(502).json({ error: true, message: 'Could not send the letter. Try again later.' });
    }
    res.json({ success: true, sent: result.sent });
  } catch (error) {
    console.error('Error sending verification email:', error);
    res.status(500).json({ error: true, message: 'Could not send the letter' });
  }
});

// Обновление данных пользователя
router.put('/me', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const { email, fullName, password, currentPassword } = req.body;
    const wrappedPw = req.body.wrapped_pw;
    
    // Пароль и email меняются только с текущим паролем: иначе украденный JWT
    // (24 ч) превращается в постоянный доступ (смена email -> сброс/вход Google).
    const currentEmail = String(req.user.email || '').toLowerCase();
    const emailChanging = email !== undefined && String(email).toLowerCase() !== currentEmail;
    if (password !== undefined && password !== null && String(password).length < 6) {
      return res.status(400).json({ error: true, message: 'Password must be at least 6 characters' });
    }
    if (password || emailChanging) {
      if (!currentPassword) {
        return res.status(400).json({ 
          error: true, 
          message: 'Current password is required' 
        });
      }
      
      // findById не отдаёт хеш пароля (bcrypt.compare(undefined) -> 500):
      // берём полную строку.
      const user = await User.findByUsername(req.user.username);
      const isPasswordValid = Boolean(user) && await User.verifyPassword(user, String(currentPassword));
      
      if (!isPasswordValid) {
        // 400, не 401: клиент считает любой 401 истёкшей сессией и разлогинивает.
        return res.status(400).json({ 
          error: true, 
          message: 'Current password is incorrect' 
        });
      }
    }
    
    // Finman Vault: for an fm1 account password/currentPassword are authTokens, and the
    // vault key wrap must change in the same write, or the vault could not be opened.
    let vaultRewrap = false;
    if (password) {
      const acc = await require('../db/database').get(
        'SELECT u.kdf, v.user_id AS has_vault FROM users u LEFT JOIN user_vaults v ON v.user_id = u.id WHERE u.id = ?',
        [req.user.id]
      );
      if (acc && acc.kdf === 'fm1') {
        if (!vault.isAuthToken(String(password))) {
          return res.status(400).json({ error: true, code: 'BAD_AUTH_TOKEN', message: 'password must be the derived auth token' });
        }
        if (acc.has_vault) {
          if (!vault.isWrap(wrappedPw)) {
            return res.status(400).json({ error: true, code: 'VAULT_REWRAP_REQUIRED', message: 'wrapped_pw is required to change the password' });
          }
          vaultRewrap = true;
        }
      }
    }

    // Email уникален (UNIQUE в users): проверяем заранее -> 409, иначе был 500.
    if (email) {
      const taken = await User.findByEmail(email);
      if (taken && taken.id !== req.user.id) {
        return res.status(409).json({
          error: true,
          message: 'This email is already used by another account'
        });
      }
    }

    // Обновление данных пользователя
    let success;
    if (vaultRewrap) {
      const passwordHash = await User.hashPassword(String(password));
      const db = require('../db/database');
      success = await db.transaction(async () => {
        const okUser = await User.update(req.user.id, { email, fullName, passwordHash });
        const r = await db.run('UPDATE user_vaults SET wrapped_pw = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [wrappedPw, req.user.id]);
        if (!r.changes) throw new Error('vault row vanished during password change');
        return okUser;
      });
    } else {
      success = await User.update(req.user.id, {
        email,
        fullName,
        password
      });
    }
    
    if (success) {
      if (emailChanging) {
        // A new address has to be confirmed again.
        const { run } = require('../db/database');
        await run('UPDATE users SET email_verified_at = NULL, email_verify_hash = NULL, email_verify_sent_at = NULL WHERE id = ?', [req.user.id]);
        emailVerify.sendVerificationLater(req.user.id, req);
      }
      const updatedUser = await User.findById(req.user.id);
      
      res.json({
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        fullName: updatedUser.full_name,
        updatedAt: updatedUser.updated_at,
        // Пароль сменён: старые токены отозваны, эта сессия получает новый.
        ...(password ? { token: signToken(updatedUser) } : {})
      });
    } else {
      res.status(400).json({ 
        error: true, 
        message: 'Failed to update user data' 
      });
    }
  } catch (error) {
    // Гонка двух одновременных PUT с одним email: UNIQUE сработал после pre-check.
    if (error && /UNIQUE constraint failed: users\.email/.test(error.message || '')) {
      return res.status(409).json({
        error: true,
        message: 'This email is already used by another account'
      });
    }
    console.error('Error updating user:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to update user data' 
    });
  }
});

module.exports = router;