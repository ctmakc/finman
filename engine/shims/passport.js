// engine/shims/passport.js — inside the vault the user is already known (the vault was
// opened with their key), so authenticate() only checks that the engine set req.user.
'use strict';

function authenticate(strategy, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  return function vaultAuth(req, res, next) {
    if (typeof callback === 'function') return callback(null, req.user || false, null);
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
    return next();
  };
}

const passport = {
  authenticate,
  use() { return passport; },
  initialize: () => (req, res, next) => next(),
  session: () => (req, res, next) => next(),
  serializeUser() {},
  deserializeUser() {},
};

module.exports = passport;
module.exports.Passport = function Passport() { return passport; };
module.exports.Strategy = function Strategy() {};
