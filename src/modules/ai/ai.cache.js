'use strict';

/**
 * @module ai/ai.cache
 * @description Redis-backed cache layer for all AI-generated content.
 *
 * Cache strategy (from the architecture plan §7.5):
 *  - Merchant categorization: 7-day TTL, keyed by normalised merchant name
 *  - Spending insights:       24-hour TTL, keyed by userId + YYYY-MM
 *  - Analysis results:        1-hour TTL, keyed by userId + date-range hash
 *  - Suggestions:             6-hour TTL, keyed by userId
 *
 * All values are JSON-serialised.  Cache misses return null — the caller decides
 * whether to generate and store.
 *
 * Graceful degradation: if Redis is unavailable, all operations silently no-op
 * (cache miss) so the AI pipeline continues without Redis.
 */

const crypto  = require('crypto');
const { logger } = require('../../config/logger.config');

// ─── Redis client ─────────────────────────────────────────────────────────────
let redis;
try {
  const redisConfig = require('../../config/redis.config');
  redis = redisConfig.client ?? redisConfig.default ?? redisConfig;
} catch {
  logger.warn('[AICache] redis.config not found — cache disabled.');
  redis = null;
}

// ─── TTL constants (seconds) ──────────────────────────────────────────────────
const TTL = {
  CATEGORIZATION: 7 * 24 * 60 * 60,   // 7 days
  INSIGHTS:       24 * 60 * 60,        // 24 hours
  ANALYSIS:        1 * 60 * 60,        // 1 hour
  SUGGESTIONS:     6 * 60 * 60,        // 6 hours
  REPORT_META:    12 * 60 * 60,        // 12 hours
  CATEGORIZED_SUMMARY: 1 * 60 * 60,    // 1 hour
};

// ─── Key builders ─────────────────────────────────────────────────────────────
const KEY = {
  categorization: (merchantNorm) =>
    `ai:cat:${merchantNorm.toLowerCase().replace(/\s+/g, '_').slice(0, 80)}`,

  insights: (userId, year, month) =>
    `ai:insights:${userId}:${year}-${String(month).padStart(2, '0')}`,

  analysis: (userId, startDate, endDate) => {
    const hash = crypto
      .createHash('sha256')
      .update(`${userId}:${startDate}:${endDate}`)
      .digest('hex')
      .slice(0, 16);
    return `ai:analysis:${hash}`;
  },

  suggestions: (userId) => `ai:suggest:${userId}`,

  reportMeta: (userId, month) => `ai:report:${userId}:${month}`,

  categorizedSummary: (userId, months) => {
    const normalized = Array.isArray(months) ? months : [];
    const suffix = normalized
      .map((monthReq) => `${monthReq?.year ?? 'na'}-${monthReq?.month ?? 'na'}`)
      .join('|');
    return `ai:categorized:${userId}:${suffix}`;
  },
};

// ─── Core get / set / del ─────────────────────────────────────────────────────

async function get(key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.warn({ key, err: err.message }, '[AICache] get failed — treating as miss.');
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    logger.warn({ key, err: err.message }, '[AICache] set failed — continuing without cache.');
  }
}

async function del(key) {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ key, err: err.message }, '[AICache] del failed.');
  }
}

// ─── Domain-specific helpers ──────────────────────────────────────────────────

/**
 * Returns cached categoryId for a normalised merchant name, or null on miss.
 * @param {string} merchantNorm
 * @returns {Promise<string|null>}
 */
async function getCategorization(merchantNorm) {
  return get(KEY.categorization(merchantNorm));
}

/**
 * Caches a categoryId for a normalised merchant name.
 * @param {string} merchantNorm
 * @param {string} categoryId
 */
async function setCategorization(merchantNorm, categoryId) {
  await set(KEY.categorization(merchantNorm), categoryId, TTL.CATEGORIZATION);
}

/**
 * Returns cached monthly insights object for a user, or null.
 * @param {string} userId
 * @param {number} year
 * @param {number} month
 * @returns {Promise<object|null>}
 */
async function getInsights(userId, year, month) {
  return get(KEY.insights(userId, year, month));
}

/**
 * Caches a monthly insights object.
 * @param {string} userId
 * @param {number} year
 * @param {number} month
 * @param {object} insights
 */
async function setInsights(userId, year, month, insights) {
  await set(KEY.insights(userId, year, month), insights, TTL.INSIGHTS);
}

/** Invalidates cached insights for a specific user/month (call after new transactions). */
async function invalidateInsights(userId, year, month) {
  await del(KEY.insights(userId, year, month));
}

/**
 * Returns cached analysis result, or null.
 * @param {string} userId
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<object|null>}
 */
async function getAnalysis(userId, startDate, endDate) {
  return get(KEY.analysis(userId, startDate, endDate));
}

/**
 * Caches an analysis result.
 */
async function setAnalysis(userId, startDate, endDate, result) {
  await set(KEY.analysis(userId, startDate, endDate), result, TTL.ANALYSIS);
}

/**
 * Returns cached suggestions, or null.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getSuggestions(userId) {
  return get(KEY.suggestions(userId));
}

/**
 * Caches suggestions.
 */
async function setSuggestions(userId, suggestions) {
  await set(KEY.suggestions(userId), suggestions, TTL.SUGGESTIONS);
}

/** Invalidates suggestions for a user (call after transactions change). */
async function invalidateSuggestions(userId) {
  await del(KEY.suggestions(userId));
}

/**
 * Returns cached report metadata, or null.
 */
async function getReportMeta(userId, month) {
  return get(KEY.reportMeta(userId, month));
}

/**
 * Caches report metadata (not the binary PDF — just the structured data).
 */
async function setReportMeta(userId, month, meta) {
  await set(KEY.reportMeta(userId, month), meta, TTL.REPORT_META);
}

async function getCategorizedSummary(userId, months) {
  return get(KEY.categorizedSummary(userId, months));
}

async function setCategorizedSummary(userId, months, summary) {
  await set(KEY.categorizedSummary(userId, months), summary, TTL.CATEGORIZED_SUMMARY);
}

module.exports = {
  TTL,
  KEY,
  get,
  set,
  del,
  getCategorization,
  setCategorization,
  getInsights,
  setInsights,
  invalidateInsights,
  getAnalysis,
  setAnalysis,
  getSuggestions,
  setSuggestions,
  invalidateSuggestions,
  getReportMeta,
  setReportMeta,
  getCategorizedSummary,
  setCategorizedSummary,
};