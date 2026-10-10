module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // SQLite is a single shared file per test process; keep workers serial.
  maxWorkers: 1,
  clearMocks: true,
  // Schema bootstrap (45 tables) in beforeAll can exceed the 5s default.
  testTimeout: 30000,
};
