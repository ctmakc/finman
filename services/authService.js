const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const User = require('../models/user');
const config = require('../config/config');

// Конфигурация для JWT-стратегии
const jwtOptions = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: config.jwtSecret
};

// Локальная стратегия (логин с паролем)
passport.use(new LocalStrategy(
  async function(username, password, done) {
    try {
      // Поиск пользователя по имени
      const user = await User.findByUsername(username);

      if (!user) {
        return done(null, false, { message: 'Invalid username or password' });
      }

      // Проверка пароля
      const isPasswordValid = await User.verifyPassword(user, password);

      if (!isPasswordValid) {
        return done(null, false, { message: 'Invalid username or password' });
      }

      // Пользователь успешно аутентифицирован
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));

// --- Google OAuth 2.0 (портировано из прод-линейки app.finman.money) ---------

// Включён ли вход через Google: нужны оба значения из config.google.
function googleEnabled() {
  return !!(config.google && config.google.clientId && config.google.clientSecret);
}

// Verify-колбэк стратегии. Вынесен отдельно, чтобы тестировать без сети:
//   1) известный google_id -> тот же пользователь;
//   2) совпал email зарегистрированного по паролю -> привязываем Google к нему
//      (без дубликата аккаунта);
//   3) иначе создаём нового пользователя и один раз уведомляем оператора.
async function googleVerify(accessToken, refreshToken, profile, done) {
  try {
    const googleId = profile && profile.id;
    if (!googleId) return done(null, false, { message: 'Google profile has no id' });
    const email = ((profile.emails && profile.emails[0] && profile.emails[0].value) || '').toLowerCase();
    // Google marks the address verified in emails[0].verified (passport-google-oauth20)
    // or in the raw userinfo email_verified. An unverified address is never
    // trusted for account creation or matching.
    const emailVerified = Boolean(
      (profile.emails && profile.emails[0] && profile.emails[0].verified === true) ||
      (profile._json && (profile._json.email_verified === true || profile._json.email_verified === 'true'))
    );
    const avatarUrl = profile.photos && profile.photos[0] && profile.photos[0].value;
    const fullName = profile.displayName || '';

    let user = await User.findByGoogleId(googleId);
    if (user) return done(null, user);

    if (!email || !emailVerified) {
      return done(null, false, { message: 'Google account has no verified email' });
    }

    // A password account with the same email is NOT linked automatically:
    // local emails are never verified, so anyone could pre-register the
    // victim's address and receive their Google sign-in. The user signs in
    // with the password instead (callback reports auth_error=email_exists).
    const existing = await User.findByEmail(email);
    if (existing) {
      return done(null, false, { message: 'email_exists' });
    }

    const created = await User.createFromGoogle({ googleId, email, fullName, avatarUrl });
    const fresh = await User.findById(created.id);
    // Уведомление оператора о новом аккаунте — никогда не блокирует вход.
    require('./signupNotify').notifySignup(
      { id: created.id, username: created.username, email, fullName },
      'google'
    );
    return done(null, fresh || created);
  } catch (error) {
    return done(error);
  }
}

// Регистрирует стратегию только при заданных GOOGLE_CLIENT_ID/SECRET, чтобы
// приложение без Google стартовало как раньше. Возвращает true, если включили.
function registerGoogleStrategy() {
  if (!googleEnabled()) {
    console.log('Passport: Google OAuth disabled (GOOGLE_CLIENT_ID/SECRET not set)');
    return false;
  }
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  passport.use(new GoogleStrategy({
    clientID: config.google.clientId,
    clientSecret: config.google.clientSecret,
    callbackURL: config.google.callbackUrl,
    scope: ['profile', 'email'],
    // OAuth state in the session: a callback carrying someone else's code
    // (login CSRF) is rejected.
    state: true,
  }, googleVerify));
  console.log('Passport: Google OAuth strategy enabled');
  return true;
}

registerGoogleStrategy();

// JWT-стратегия (для защищенных API-маршрутов)
passport.use(new JwtStrategy(jwtOptions, async function(jwtPayload, done) {
  try {
    // Поиск пользователя по ID из токена
    const user = await User.findById(jwtPayload.id);

    if (!user) {
      return done(null, false);
    }

    // Пользователь найден
    return done(null, user);
  } catch (error) {
    return done(error, false);
  }
}));

// Сериализация и десериализация для сессии
passport.serializeUser(function(user, done) {
  done(null, user.id);
});

passport.deserializeUser(async function(id, done) {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

module.exports = { googleEnabled, googleVerify, registerGoogleStrategy };
