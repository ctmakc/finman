const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const config = require('../config/config');
const { googleEnabled } = require('../services/authService');
const { notifySignup } = require('../services/signupNotify');
const passwordReset = require('../services/passwordResetService');

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

// --- Вход через Google (портировано из прод-линейки) -----------------------

// Фронтенд спрашивает, показывать ли кнопку, а не угадывает по env.
router.get('/google/status', (req, res) => res.json({ enabled: googleEnabled() }));

router.get('/google', (req, res, next) => {
  if (!googleEnabled()) {
    return res.status(503).json({ error: true, message: 'Google sign-in is not configured' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  if (!googleEnabled()) {
    return res.status(503).json({ error: true, message: 'Google sign-in is not configured' });
  }
  passport.authenticate('google', { session: false }, (err, user, info) => {
    const fail = (reason) =>
      res.redirect(config.google.successRedirect + '?auth_error=' + encodeURIComponent(reason));
    if (err) { console.error('Google callback error:', err); return fail('google_failed'); }
    if (!user) {
      const reason = info && info.message === 'email_exists' ? 'email_exists' : 'google_denied';
      return fail(reason);
    }
    try {
      // Тот же payload, что и у входа по паролю.
      const token = signToken(user);
      // Токен уезжает во фрагменте URL — так он не попадает в серверные логи.
      return res.redirect(config.google.successRedirect + '#token=' + encodeURIComponent(token));
    } catch (e) {
      console.error('Google callback token error:', e);
      return fail('google_failed');
    }
  })(req, res, next);
});

// --- Forgot / reset password ------------------------------------------------
// POST /forgot-password { email } always answers 200 with the same message, so
// the endpoint cannot be used to find out which emails have accounts. The link
// is mailed through services/emailService (no-op without RESEND_API_KEY).
router.post('/forgot-password', async (req, res) => {
  const email = req.body && req.body.email;
  if (!email || !config.isValidEmail(String(email))) {
    return res.status(400).json({ error: true, message: 'Enter the email address of your account' });
  }
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await passwordReset.requestReset({ email: String(email), baseUrl });
    res.json({
      success: true,
      message: 'If an account exists for that email, a reset link is on its way. It works for one hour.',
      // Only an operator can act on this: no mail provider configured.
      emailConfigured: result.reason !== 'EMAIL_NOT_CONFIGURED'
    });
  } catch (error) {
    console.error('Forgot-password error:', error);
    res.status(500).json({ error: true, message: 'Could not start the password reset' });
  }
});

// POST /reset-password { token, password } -> 200 { success } | 400 { error }
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  try {
    await passwordReset.resetPassword({ token, password });
    res.json({ success: true, message: 'Your password has been changed. Sign in with the new one.' });
  } catch (error) {
    if (error && error.isOperational) {
      return res.status(error.status || 400).json({ error: true, code: error.code, message: error.message });
    }
    console.error('Reset-password error:', error);
    res.status(500).json({ error: true, message: 'Could not reset the password' });
  }
});

// Регистрация
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;

    // Проверка, что обязательные поля заполнены
    if (!username || !email || !password) {
      return res.status(400).json({
        error: true,
        message: 'Username, email and password are required'
      });
    }

    // Валидация email
    if (!config.isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: 'Invalid email format'
      });
    }

    // Валидация username (только буквы, цифры, подчёркивания, 3-30 символов)
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: true,
        message: 'Username must be 3-30 characters (letters, digits, underscores)'
      });
    }

    // Валидация пароля (минимум 6 символов)
    if (password.length < 6) {
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
      fullName
    });
    
    // Создание токена JWT
    const token = signToken(newUser);

    // Уведомление оператора о регистрации (письмо владельцу; ответ не ждёт).
    notifySignup(
      { id: newUser.id, username: newUser.username, email: newUser.email, fullName: newUser.fullName },
      'password'
    );
    
    // Отправка токена и данных пользователя
    res.json({
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        fullName: newUser.fullName
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
      createdAt: user.created_at
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Failed to fetch user data' 
    });
  }
});

// Обновление данных пользователя
router.put('/me', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const { email, fullName, password, currentPassword } = req.body;
    
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
    const success = await User.update(req.user.id, {
      email,
      fullName,
      password
    });
    
    if (success) {
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