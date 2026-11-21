// engine/shims/tracker.js — replaces services/tracker.js: nothing about vault activity
// leaves the device from inside the engine (the app shell sends its own content-free events).
'use strict';

const TEST_EMAIL = /(\.test$|\+smoke@|@example\.(com|org)$)/i;

module.exports = {
  normalizeAttribution: () => null,
  sourceLabel: () => null,
  deviceFromUa: () => null,
  clientIp: () => null,
  isTestEmail: (email) => TEST_EMAIL.test(String(email || '')),
  track: () => {},
  identify: () => {},
  recordAcquisition: async () => null,
  appOpen: async () => null,
  getAcquisition: async () => null,
  opConfig: () => null,
  flush: async () => {},
};
