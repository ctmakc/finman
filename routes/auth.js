const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const Organization = require('../models/organization');
const config = require('../config/config');
const { get } = require('../db/database');

const router = express.Router();

// Validate token (for frontend)
router.get('/validate', passport.authenticate('jwt', { session: false }), (req, res) => {
  res.json({ valid: true, user: { id: req.user.id, username: req.user.username, orgId: req.user.orgId } });
});

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: true, message: 'Username, email and password are required' });
    }

    if (!config.isValidEmail(email)) {
      return res.status(400).json({ error: true, message: 'Invalid email format' });
    }

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: true, message: 'Username must be 3-30 characters (letters, digits, underscores)' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: true, message: 'Password must be at least 6 characters' });
    }

    const existingUser = await User.findByUsername(username);
    if (existingUser) {
      return res.status(400).json({ error: true, message: 'Username already taken' });
    }

    const existingEmail = await User.findByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ error: true, message: 'Email already registered' });
    }

    const newUser = await User.create({ username, email, password, fullName });

    // Create personal organization for new user
    const org = await Organization.create({ name: fullName || username, ownerId: newUser.id });

    const token = jwt.sign(
      { id: newUser.id, orgId: org.id, role: 'owner' },
      config.jwtSecret,
      { expiresIn: config.jwtExpiration }
    );

    res.json({
      token,
      user: { id: newUser.id, username: newUser.username, email: newUser.email, fullName: newUser.fullName, orgId: org.id }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: true, message: 'Registration failed' });
  }
});

// Login
router.post('/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err) return next(err);

    if (!user) {
      return res.status(401).json({ error: true, message: info.message || 'Invalid username or password' });
    }

    // Auto-create org for legacy users without one
    let orgId = user.org_id;
    let role = 'owner';
    if (!orgId) {
      try {
        const org = await Organization.create({ name: user.username, ownerId: user.id });
        orgId = org.id;
      } catch (e) {
        console.error('Failed to auto-create org for user', user.id, e);
        const row = await get('SELECT org_id FROM users WHERE id = ?', [user.id]);
        orgId = row?.org_id ?? null;
        if (!orgId) {
          return res.status(500).json({ error: true, message: 'Login failed: could not establish organization context' });
        }
      }
    }

    const token = jwt.sign(
      { id: user.id, orgId, role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiration }
    );

    return res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, fullName: user.full_name, orgId, role }
    });
  })(req, res, next);
});

// Get current user
router.get('/me', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: true, message: 'User not found' });

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      orgId: req.user.orgId,
      role: req.user.role,
      createdAt: user.created_at
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: true, message: 'Failed to get user data' });
  }
});

// Update current user
router.put('/me', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const { email, fullName, password, currentPassword } = req.body;

    if (password) {
      if (!currentPassword) {
        return res.status(400).json({ error: true, message: 'Current password required' });
      }
      const user = await User.findById(req.user.id);
      const isPasswordValid = await User.verifyPassword(user, currentPassword);
      if (!isPasswordValid) {
        return res.status(401).json({ error: true, message: 'Invalid current password' });
      }
    }

    const success = await User.update(req.user.id, { email, fullName, password });

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
      res.status(400).json({ error: true, message: 'Failed to update user data' });
    }
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: true, message: 'Failed to update user data' });
  }
});

module.exports = router;
