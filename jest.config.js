module.exports = {
  testEnvironment: 'node',

  verbose: true,

  setupFilesAfterEnv: [
    '<rootDir>/tests/setup.js',
  ],

  testMatch: [
    '**/tests/**/*.test.js',
  ],
};