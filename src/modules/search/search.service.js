const repo = require('./search.repository');
const { searchCache } = require('./search.cache');
const searchLogger = require('./search.logger');
const { AppError } = require('../../shared/AppError');
const { mapTransactionResult } = require('./search.mapper');

const CACHE_TTL_SECONDS = 30;

async function executeGlobalSearch(userId, queryText, requestId) {
  const sanitizedQuery = queryText ? queryText.trim() : '';

  if (!sanitizedQuery || sanitizedQuery.length < 2) {
    return [];
  }

  if (sanitizedQuery.length > 100) {
    searchLogger.validationFailed({
      requestId,
      userId,
      reason: 'Query exceeds 100 character limit',
    });
    throw new AppError('Search query is too long', 400);
  }

  // ── Cache check ────────────────────────────────────────────────────────
  const cacheKey = `search:${userId}:${sanitizedQuery.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);

  if (cached !== undefined && cached !== null) {
    searchLogger.cacheHit({ requestId, userId, query: sanitizedQuery });
    return cached;
  }

  // ── DB fetch ───────────────────────────────────────────────────────────
  const startTime = Date.now();

 let rows;
try {
  rows = await repo.searchTransactions(userId, sanitizedQuery);

} catch (error) {
  searchLogger.queryFailed({ requestId, userId, query: sanitizedQuery, error });
  throw error;

}

  const durationMs = Date.now() - startTime;

  searchLogger.queryExecuted({
    requestId,
    userId,
    query: sanitizedQuery,
    durationMs,
    resultCount: rows.length,
  });

  // ── Map + cache ────────────────────────────────────────────────────────
  const results = rows.map(mapTransactionResult);

  searchCache.set(cacheKey, results, CACHE_TTL_SECONDS);
  searchLogger.cacheSet({ requestId, userId, query: sanitizedQuery, ttl: CACHE_TTL_SECONDS });

  return results;
}

module.exports = { executeGlobalSearch };