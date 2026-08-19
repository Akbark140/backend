const logger = require('../../shared/logger');

const MODULE_TAG = { module: 'search' };

function withModule(meta = {}) {
  return { ...MODULE_TAG, ...meta };
}

/**
 * Search-scoped Pino logger.
 *
 * Pino expects calls as (metadataObject, messageString). Keeping that shape in
 * one small wrapper prevents old Winston-style argument ordering from leaking
 * into controllers or services.
 */
const searchLogger = {
  debug: (meta = {}, message = 'search_debug') =>
    logger.debug(withModule(meta), message),

  info: (meta = {}, message = 'search_info') =>
    logger.info(withModule(meta), message),

  warn: (meta = {}, message = 'search_warn') =>
    logger.warn(withModule(meta), message),

  error: (meta = {}, message = 'search_error') =>
    logger.error(withModule(meta), message),

  queryExecuted: ({ requestId, userId, query, durationMs, resultCount }) => {
    const level = durationMs > 500 ? 'warn' : 'info';
    const message = durationMs > 500 ? 'slow_query' : 'query_executed';

    logger[level](
      withModule({
        requestId,
        userId,
        query,
        durationMs,
        resultCount,
        ...(durationMs > 500 && { alert: 'Query exceeded 500ms threshold' }),
      }),
      message,
    );
  },

  cacheHit: ({ requestId, userId, query }) =>
    logger.debug(withModule({ requestId, userId, query }), 'cache_hit'),

  cacheSet: ({ requestId, userId, query, ttl }) =>
    logger.debug(withModule({ requestId, userId, query, ttl }), 'cache_set'),

  validationFailed: ({ requestId, userId, reason }) =>
    logger.warn(withModule({ requestId, userId, reason }), 'validation_failed'),

  rateLimited: ({ requestId, userId, ip, key }) =>
    logger.warn(withModule({ requestId, userId, ip, key }), 'rate_limited'),

  queryFailed: ({ requestId, userId, query, error }) =>
    logger.error(
      withModule({
        requestId,
        userId,
        query,
        error: error?.message || String(error),
        stack: error?.stack,
      }),
      'query_failed',
    ),
};

module.exports = searchLogger;
