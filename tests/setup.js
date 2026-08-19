// tests/setup.js
const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
});

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env.test'),
  override: false,
});

const { closePool, query } = require('../src/config/db.config');
const { disconnectRedis } = require('../src/config/redis.config');

// Increase timeout for DB operations
jest.setTimeout(30000);

// Global flag to indicate if database is available
global.DB_AVAILABLE = false;

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error(
    '❌ Unhandled Promise Rejection:',
    err
  );

  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error(
    '❌ Uncaught Exception:',
    err
  );

  process.exit(1);
});

beforeAll(async () => {
  console.log('🧪 Starting test suite...');
  
  // Check if database is available
  try {
    await query('SELECT 1');
    global.DB_AVAILABLE = true;
    console.log('✅ Database connection successful');
  } catch (err) {
    console.warn(
      '⚠️ Database not available - skipping DB-dependent tests. Error:',
      err.message
    );
    global.DB_AVAILABLE = false;
  }
});

afterAll(async () => {
  console.log('✅ Test suite finished');
  await closePool();
  await disconnectRedis();
});