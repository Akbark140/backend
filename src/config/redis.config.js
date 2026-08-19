// redis.config.js

const Redis = require('ioredis');

const { config } = require('./index.config');
const { logger } = require('./logger.config');

// ── Redis Client ─────────────────────────────────────────────────
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// ── Redis Events ─────────────────────────────────────────────────
redis.on('connect', () => {
  logger.info('✅ Redis connected');
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis error');
});

// ── Connect Redis ────────────────────────────────────────────────

// ── Token Blacklist Helpers ──────────────────────────────────────
const BLACKLIST_PREFIX = 'token:blacklist:';

/**
 * Blacklist a JWT
 * Used during logout or refresh token rotation
 */
async function blacklistToken(jti, ttlSeconds) {
  await redis.set(
    `${BLACKLIST_PREFIX}${jti}`,
    '1',
    'EX',
    ttlSeconds
  );
}

/**
 * Check if token is blacklisted
 */
async function isTokenBlacklisted(jti) {
  const value = await redis.get(
    `${BLACKLIST_PREFIX}${jti}`
  );

  return value !== null;
}

// ── Alert Rate Limit Helpers ─────────────────────────────────────
const ALERT_PREFIX = 'alert:sent:';

/**
 * Check if alert was already sent today
 */
async function wasAlertSentToday(userId, alertType) {
  const key = `${ALERT_PREFIX}${userId}:${alertType}`;

  const value = await redis.get(key);

  return value !== null;
}

/**
 * Mark alert as sent for today
 */
async function markAlertSentToday(userId, alertType) {
  const key = `${ALERT_PREFIX}${userId}:${alertType}`;

  const secondsUntilMidnight =
    getSecondsUntilMidnight();

  await redis.set(
    key,
    '1',
    'EX',
    secondsUntilMidnight
  );
}

// ── Helpers ──────────────────────────────────────────────────────
function getSecondsUntilMidnight() {
  const now = new Date();

  const midnight = new Date(now);

  midnight.setHours(24, 0, 0, 0);

  return Math.floor(
    (midnight.getTime() - now.getTime()) / 1000
  );
}

async function disconnectRedis() {
  await redis.quit();
  logger.info('Redis disconnected');
}

// ── Exports ──────────────────────────────────────────────────────
module.exports = {
  redis,
  disconnectRedis,

  blacklistToken,
  isTokenBlacklisted,

  wasAlertSentToday,
  markAlertSentToday,
};