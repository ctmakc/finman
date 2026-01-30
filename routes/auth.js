const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const config = require('../config/config');

const router = express.Router();

// Валидация токена (для frontend)
router.get('/validate', passport.authenticate('jwt', { session: false }), (req, res) => {
  res.json({ valid: true, user: { id: req.user.id, username: req.user.username } });
});

// Регистрация
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;

    // Проверка, что обязательные поля заполнены
    if (!username || !email || !password) {
      return res.status(400).json({
        error: true,
        message: 'Необходимо указать имя пользователя, email и пароль'
      });
    }

    // Валидация email
    if (!config.isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: 'Некорректный формат email'
      });
    }

    // Валидация username (только буквы, цифры, подчёркивания, 3-30 символов)
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: true,
        message: 'Имя пользователя должно содержать 3-30 символов (буквы, цифры, подчёркивания)'
      });
    }

    // Валидация пароля (минимум 6 символов)
    if (password.length < 6) {
      return res.status(400).json({
        error: true,
        message: 'Пароль должен содержать минимум 6 символов'
      });
    }
    
    // Проверка, существует ли пользователь с таким именем
    const existingUser = await User.findByUsername(username);
    if (existingUser) {
      return res.status(400).json({ 
        error: true, 
        message: 'Пользователь с таким именем уже существует' 
      });
    }
    
    // Проверка, существует ли пользователь с таким email
    const existingEmail = await User.findByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ 
        error: true, 
        message: 'Пользователь с таким email уже существует' 
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
    const token = jwt.sign({ id: newUser.id }, config.jwtSecret, {
      expiresIn: config.jwtExpiration
    });
    
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
    console.error('Ошибка при регистрации:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при регистрации' 
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
        message: info.message || 'Неверное имя пользователя или пароль' 
      });
    }
    
    // Создание токена JWT
    const token = jwt.sign({ id: user.id }, config.jwtSecret, {
      expiresIn: config.jwtExpiration
    });
    
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
        message: 'Пользователь не найден' 
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
    console.error('Ошибка при получении данных пользователя:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при получении данных пользователя' 
    });
  }
});

// Обновление данных пользователя
router.put('/me', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const { email, fullName, password, currentPassword } = req.body;
    
    // Если меняется пароль, проверить текущий пароль
    if (password) {
      if (!currentPassword) {
        return res.status(400).json({ 
          error: true, 
          message: 'Необходимо указать текущий пароль' 
        });
      }
      
      const user = await User.findById(req.user.id);
      const isPasswordValid = await User.verifyPassword(user, currentPassword);
      
      if (!isPasswordValid) {
        return res.status(401).json({ 
          error: true, 
          message: 'Неверный текущий пароль' 
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
        updatedAt: updatedUser.updated_at
      });
    } else {
      res.status(400).json({ 
        error: true, 
        message: 'Не удалось обновить данные пользователя' 
      });
    }
  } catch (error) {
    console.error('Ошибка при обновлении данных пользователя:', error);
    res.status(500).json({ 
      error: true, 
      message: 'Произошла ошибка при обновлении данных пользователя' 
    });
  }
});

module.exports = router;