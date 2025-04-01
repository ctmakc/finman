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
        return done(null, false, { message: 'Неверное имя пользователя или пароль' });
      }
      
      // Проверка пароля
      const isPasswordValid = await User.verifyPassword(user, password);
      
      if (!isPasswordValid) {
        return done(null, false, { message: 'Неверное имя пользователя или пароль' });
      }
      
      // Пользователь успешно аутентифицирован
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));

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
