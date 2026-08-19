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

function optional(name, defaultValue = '') {
  return required(name, defaultValue);
}

const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',

  PORT: Number(process.env.PORT) || 5000,

  // Database
  DATABASE_URL: required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/wealthflux'),

  // Redis
  REDIS_URL: required('REDIS_URL', 'redis://localhost:6379'),

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