// shared/request-id.js

const { randomUUID } = require('crypto');

/**
 * Reads request ID from request headers.
 * Falls back to null if not present.
 */
function readRequestId(req) {
  return (
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    null
  );
}

/**
 * Generates a request ID if one doesn't exist.
 */
function getOrCreateRequestId(req) {
  return readRequestId(req) || randomUUID();
}

module.exports = {
  readRequestId,
  getOrCreateRequestId,
};