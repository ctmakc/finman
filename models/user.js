const { query, get, run } = require('../db/database');
const bcrypt = require('bcrypt');

class User {
  // Создание пользователя
  static async create(userData) {
    try {
      // Хеширование пароля
      const hashedPassword = await bcrypt.hash(userData.password, 10);
      
      const result = await run(
        `INSERT INTO users (username, email, password, full_name) 
         VALUES (?, ?, ?, ?)`,
        [userData.username, userData.email, hashedPassword, userData.fullName || '']
      );
      
      return { id: result.id, ...userData, password: undefined };
    } catch (error) {
      throw error;
    }
  }
  
  // Поиск пользователя по ID
  static async findById(id) {
    try {
      const user = await get(
        `SELECT id, username, email, full_name, created_at, updated_at 
         FROM users WHERE id = ?`,
        [id]
      );
      
      return user;
    } catch (error) {
      throw error;
    }
  }
  
  // Поиск пользователя по имени пользователя
  static async findByUsername(username) {
    try {
      const user = await get(
        `SELECT * FROM users WHERE username = ?`,
        [username]
      );
      
      return user;
    } catch (error) {
      throw error;
    }
  }
  
  // Поиск пользователя по email
  static async findByEmail(email) {
    try {
      const user = await get(
        `SELECT * FROM users WHERE email = ?`,
        [email]
      );
      
      return user;
    } catch (error) {
      throw error;
    }
  }
  
  // Обновление данных пользователя
  static async update(id, userData) {
    try {
      let updateFields = [];
      let params = [];
      
      if (userData.email) {
        updateFields.push('email = ?');
        params.push(userData.email);
      }
      
      if (userData.fullName) {
        updateFields.push('full_name = ?');
        params.push(userData.fullName);
      }
      
      if (userData.password) {
        const hashedPassword = await bcrypt.hash(userData.password, 10);
        updateFields.push('password = ?');
        params.push(hashedPassword);
      }
      
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      
      const result = await run(
        `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
        params
      );
      
      return result.changes > 0;
    } catch (error) {
      throw error;
    }
  }
  
  // Проверка пароля
  static async verifyPassword(user, password) {
    try {
      return await bcrypt.compare(password, user.password);
    } catch (error) {
      throw error;
    }
  }
}

module.exports = User;
  