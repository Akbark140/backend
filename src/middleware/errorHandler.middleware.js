// errorHandler.middleware.js

const {logger} = require('../config/logger.config');

// ─────────────────────────────────────────────
// AppError — use this for all intentional errors
// ─────────────────────────────────────────────
class AppError extends Error {
  /**
   * @param {string}  message    - Human-readable message
   * @param {number}  statusCode - HTTP status code
   * @param {object}  [meta]     - Extra fields merged into the response
   */
  constructor(message, statusCode = 500, meta = {}) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true; // distinguishes known errors from bugs
    this.meta       = meta;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─────────────────────────────────────────────
// catchAsync — wraps async route handlers so you
// never need a try/catch block in controllers.
//
// Usage:
//   router.post('/register', catchAsync(authController.register));
// ─────────────────────────────────────────────
const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─────────────────────────────────────────────
// 404 handler — mount BEFORE errorHandler
// ─────────────────────────────────────────────
function notFound(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

// ─────────────────────────────────────────────
// Normalise raw errors into a consistent shape
// ─────────────────────────────────────────────
function normalise(err) {
  let statusCode = err.statusCode || 500;
  let message    = err.message    || 'Internal Server Error';
  let extra      = {};            // merged into response body

  // ── Bad JSON body (SyntaxError from express.json()) ──────────────
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return { statusCode: 400, message: 'Malformed JSON in request body', extra };
  }

  // ── PostgreSQL / node-postgres errors ────────────────────────────
  if (err.code && typeof err.code === 'string' && err.code.length === 5) {
    switch (err.code) {
      case '23505': {                          // unique violation
        // err.detail looks like: Key (email)=(foo@bar.com) already exists.
        const field = err.detail?.match(/Key \((.+?)\)/)?.[1] ?? 'field';
        return { statusCode: 409, message: `${field} already exists`, extra };
      }
      case '23503':                            // foreign key violation
        return { statusCode: 400, message: 'Invalid reference: related record not found', extra };
      case '23502': {                          // not-null violation
        const field = err.column ?? 'field';
        return { statusCode: 400, message: `Required field missing: ${field}`, extra };
      }
      case '22P02':                            // invalid text representation
        return { statusCode: 400, message: 'Invalid input format', extra };
      case '42P01':                            // undefined table
        return { statusCode: 500, message: 'Database schema error', extra };
      case 'ECONNREFUSED':                     // DB not reachable
      case '57P03':
        return { statusCode: 503, message: 'Database unavailable', extra };
      default:
        break;
    }
  }

  // ── JWT errors ───────────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    return { statusCode: 401, message: 'Invalid token', extra };
  }
  if (err.name === 'TokenExpiredError') {
    return { statusCode: 401, message: 'Token expired', extra };
  }
  if (err.name === 'NotBeforeError') {
    return { statusCode: 401, message: 'Token not yet active', extra };
  }

  // ── Zod validation errors ────────────────────────────────────────
  if (err.name === 'ZodError') {
    return {
      statusCode: 400,
      message: 'Validation failed',
      extra: {
        errors: err.errors.map((e) => ({
          field:   e.path.join('.'),
          message: e.message,
        })),
      },
    };
  }

  // ── Multer (file upload) errors ──────────────────────────────────
  if (err.name === 'MulterError') {
    const multerMessages = {
      LIMIT_FILE_SIZE:  'File too large',
      LIMIT_FILE_COUNT: 'Too many files',
      LIMIT_FIELD_KEY:  'Field name too long',
      LIMIT_UNEXPECTED_FILE: `Unexpected field: ${err.field}`,
    };
    return {
      statusCode: 400,
      message: multerMessages[err.code] ?? 'File upload error',
      extra,
    };
  }

  // ── Mongoose (if ever mixed in) ──────────────────────────────────
  if (err.name === 'CastError') {
    return { statusCode: 400, message: `Invalid ${err.path}: ${err.value}`, extra };
  }
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path, message: e.message,
    }));
    return { statusCode: 400, message: 'Validation failed', extra: { errors } };
  }

  // ── Known AppError (operational) ────────────────────────────────
  if (err.isOperational) {
    return { statusCode, message, extra: err.meta ?? {} };
  }

  // ── Unknown / programming error — hide details in production ─────
  if (process.env.NODE_ENV === 'production') {
    return { statusCode: 500, message: 'Internal Server Error', extra };
  }

  return { statusCode, message, extra };
}

// ─────────────────────────────────────────────
// Global error handling middleware
// ─────────────────────────────────────────────
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const { statusCode, message, extra } = normalise(err);
  const isDev = process.env.NODE_ENV === 'development';

  // Log — only use logger.error for 5xx; warn for 4xx
  const logPayload = {
    method:     req.method,
    url:        req.originalUrl,
    ip:         req.ip,
    statusCode,
    error:      err.message,
    ...(isDev && { stack: err.stack }),
  };

  if (statusCode >= 500) {
    logger.error(logPayload, 'Server Error');
  } else {
    logger.warn(logPayload, 'Client Error');
  }

  return res.status(statusCode).json({
    success: false,
    message,
    ...extra,
    ...(isDev && statusCode >= 500 && { stack: err.stack }),
  });
}

// ─────────────────────────────────────────────
// Process-level safety nets
// Call once in server.js / app.js
// ─────────────────────────────────────────────
function registerProcessHandlers(server) {
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled Promise Rejection — shutting down');
    server.close(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    logger.error({ error: err.message, stack: err.stack }, 'Uncaught Exception — shutting down');
    server.close(() => process.exit(1));
  });
}

module.exports = {
  AppError,
  catchAsync,
  notFound,
  errorHandler,
  registerProcessHandlers,
};