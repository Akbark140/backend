// requestLogger.middleware.js

const { logger } = require('../config/logger.config');

/**
 * Request Logger Middleware
 * Logs every incoming HTTP request (useful for debugging + production monitoring)
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  // When response finishes, log details
  res.on('finish', () => {
    const duration = Date.now() - start;

    logger.info(
      {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        duration: `${duration}ms`,
      },
      'HTTP Request'
    );
  });

  next();
}

module.exports = requestLogger;