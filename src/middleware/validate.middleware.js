// middleware/validate.middleware.js

const { randomUUID } = require('crypto');

const { searchQuerySchema } = require('../modules/search/search.schema');
const searchLogger = require('../modules/search/search.logger');

// If you have this helper elsewhere, import it.
// Otherwise remove it and rely on randomUUID().
const { readRequestId } = require('../shared/request-id') || {};

/**
 * Generic Zod Validation Middleware
 * Supports body, query, params, or any request source.
 *
 * Example:
 * router.post('/',
 *   validate(createUserSchema, 'body'),
 *   controller.createUser
 * );
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      // Safety check
      if (!schema || typeof schema.safeParse !== 'function') {
        throw new Error(
          'The schema passed to the validation middleware is invalid or undefined.'
        );
      }

      const result = schema.safeParse(req[source]);

      if (!result.success) {
        console.warn(
          '⚠️ [Validation Failed]:',
          result.error.errors || result.error.issues
        );

        const fieldErrors =
          result.error?.errors || result.error?.issues || [];

        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: fieldErrors.map((err) => ({
            field: err.path?.join('.') || 'unknown',
            message: err.message,
          })),
        });
      }

      // Replace payload with sanitized parsed data
      req[source] = result.data;

      return next();
    } catch (error) {
      console.error('[Validation Critical Error]:', {
        message: error.message,
        stack: error.stack,
        sourceType: source,
      });

      const fieldErrors =
        error?.errors && Array.isArray(error.errors)
          ? error.errors.map((err) => ({
              field: err.path?.join('.') || 'unknown',
              message: err.message,
            }))
          : [
              {
                field: source,
                message: error.message || 'Validation failed',
              },
            ];

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: fieldErrors,
      });
    }
  };
}

/**
 * Search Query Validation Middleware (Joi)
 */
function validateSearchQuery(req, res, next) {
  const { error, value } = searchQuerySchema.validate(req.query, {
    abortEarly: true,
    stripUnknown: true,
  });

  if (error) {
    const reason =
      error.details?.[0]?.message || 'Invalid search query.';

    const requestId =
      req.searchRequestId ||
      (typeof readRequestId === 'function'
        ? readRequestId(req)
        : null) ||
      randomUUID();

    res.setHeader('X-Request-Id', requestId);

    searchLogger.validationFailed({
      requestId,
      userId: req.user?.id,
      reason,
    });

    return res.status(400).json({
      success: false,
      message: reason,
      requestId,
    });
  }

  req.validatedSearchQuery = value;

  return next();
}

/**
 * Generic Joi Body Validation Middleware
 *
 * Example:
 * router.post(
 *   '/',
 *   validateBody(createSchema),
 *   controller.create
 * );
 */
const validateBody = (schema) => {
  return (req, res, next) => {
    try {
      const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        return res.status(400).json({
          success: false,
          message: 'Data validation constraints breached.',
          errors: error.details.map((detail) => ({
            field: detail.path.join('.'),
            message: detail.message,
          })),
        });
      }

      req.body = value;

      return next();
    } catch (err) {
      console.error('[Joi Validation Error]:', {
        message: err.message,
        stack: err.stack,
      });

      return res.status(500).json({
        success: false,
        message: 'Validation middleware error',
      });
    }
  };
};

module.exports = {
  validate,
  validateSearchQuery,
  validateBody,
};