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
      
      // User authenticated successfully
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));

// Google OAuth 2.0 strategy — registered only when credentials are present,
// so the app keeps booting normally on deployments without Google configured.
if (config.google && config.google.clientId && config.google.clientSecret) {
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  passport.use(new GoogleStrategy({
    clientID: config.google.clientId,
    clientSecret: config.google.clientSecret,
    callbackURL: config.google.callbackUrl,
    scope: ['profile', 'email'],
  }, async function (accessToken, refreshToken, profile, done) {
    try {
      const googleId = profile.id;
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
      const avatarUrl = profile.photos && profile.photos[0] && profile.photos[0].value;
      const fullName = profile.displayName || '';

      let user = await User.findByGoogleId(googleId);
      if (user) return done(null, user);

      // Same person returning with Google after registering with a password:
      // link the accounts instead of creating a duplicate.
      if (email) {
        const existing = await User.findByEmail(email);
        if (existing) {
          await User.linkGoogle(existing.id, googleId, avatarUrl);
          return done(null, existing);
        }
      }

      if (!email) return done(null, false, { message: 'Google account has no usable email' });

      const created = await User.createFromGoogle({ googleId, email, fullName, avatarUrl });
      const fresh = await User.findById(created.id);
      // Operator notice for a brand-new Google account (never blocks sign-in).
      require('./signupNotify').notifySignup({ id: created.id, username: created.username, email, fullName }, 'google');
      return done(null, fresh || created);
    } catch (error) {
      return done(error);
    }
  }));
  console.log('Passport: Google OAuth strategy enabled');
} else {
  console.log('Passport: Google OAuth disabled (GOOGLE_CLIENT_ID/SECRET not set)');
}

// JWT strategy
passport.use(new JwtStrategy(jwtOptions, async function(jwtPayload, done) {
  try {
    const user = await User.findById(jwtPayload.id);
    if (!user) return done(null, false);
    // Attach orgId and role from JWT payload
    user.orgId = jwtPayload.orgId || user.org_id;
    user.role = jwtPayload.role || 'member';
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
