// src/config/index.config.js
require('dotenv').config();

function required(name, defaultValue = null) {
  const value = process.env[name];

  // In test environment, allow missing variables with sensible defaults
  if (!value && process.env.NODE_ENV === 'test') {
    if (defaultValue !== null) return defaultValue;
    return `test_${name.toLowerCase()}`;
  }

  if (!value) {
    if (defaultValue !== null) return defaultValue;
    console.error(`❌ Missing environment variable: ${name}`);
    process.exit(1);
  }

  return value;
}

// Fixed optional helper logic so missing optional fields don't accidentally execute the required() exit handler
function optional(name, defaultValue = '') {
  const value = process.env[name];
  return value === undefined || value === null ? defaultValue : value;
}

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',

  PORT: Number(process.env.PORT) || 5000,

  // Database 
  // Bulletproof fallback protection: forces a real error if DATABASE_URL vanishes in production
  DATABASE_URL: isProduction 
    ? (process.env.DATABASE_URL || (() => { throw new Error("CRITICAL STARTUP ERROR: The DATABASE_URL environment variable is completely missing or blank in your Railway settings.") })())
    : (process.env.DATABASE_URL || required('DATABASE_URL', 'postgresql://postgres:@Math2029@localhost:5432/postgres')),

  ALLOW_INSECURE_DB: process.env.ALLOW_INSECURE_DB || 'false',
  DB_SSL_CERT: process.env.DB_SSL_CERT || null,

  // Redis
  REDIS_URL: isProduction 
    ? (process.env.REDIS_URL || (() => { throw new Error("CRITICAL STARTUP ERROR: The REDIS_URL environment variable is completely missing or blank in your Railway settings.") })())
    : required('REDIS_URL', 'redis://localhost:6379'),

  // JWT
  JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET', 'dev-access-secret'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET', 'dev-refresh-secret'),

  JWT_ACCESS_EXPIRES_IN:
    process.env.JWT_ACCESS_EXPIRES_IN || '15m',

  JWT_REFRESH_EXPIRES_IN:
    process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // OAuth
  GOOGLE_CLIENT_ID: optional('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: optional('GOOGLE_CLIENT_SECRET'),

  GITHUB_CLIENT_ID: optional('GITHUB_CLIENT_ID'),
  GITHUB_CLIENT_SECRET: optional('GITHUB_CLIENT_SECRET'),

  // SMTP
  SMTP_HOST: optional('SMTP_HOST', 'localhost'),

  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,

  SMTP_USER: optional('SMTP_USER'),
  SMTP_PASS: optional('SMTP_PASS'),

  EMAIL_FROM:
    process.env.EMAIL_FROM ||
    'BudgetManager <no-reply@example.com>',

  // Frontend
  FRONTEND_URL: required('FRONTEND_URL', 'https://wealth-flux.vercel.app/'),
};

module.exports = {
  config,
};
