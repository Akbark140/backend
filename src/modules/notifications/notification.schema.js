// notification.validation.js

const { body, param, query, validationResult } = require('express-validator');

/**
 * Middleware execution runner
 * Validates the request against the schema and intercepts if errors are found.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  next();
};

// ─── Validation Schemas ──────────────────────────────────────────

const subscribeSchema = [
  body('subscription').isObject().withMessage('subscription must be an object'),
  body('subscription.endpoint').isURL().withMessage('Invalid endpoint URL'),
  body('subscription.keys.p256dh').isString().notEmpty().withMessage('p256dh key is required'),
  body('subscription.keys.auth').isString().notEmpty().withMessage('auth key is required'),
  body('user_id').optional().isUUID().withMessage('user_id must be a valid UUID'),
];

const unsubscribeSchema = [
  body('endpoint').isURL().withMessage('A valid endpoint URL is required'),
];

const sendSchema = [
  param('userId').isUUID().withMessage('userId must be a valid UUID'),
  body('title').isString().trim().isLength({ min: 1, max: 100 }).withMessage('title is required (max 100 chars)'),
  body('body').isString().trim().isLength({ min: 1, max: 300 }).withMessage('body is required (max 300 chars)'),
  body('url').optional().isString().trim(),
  body('type').optional().isString().trim().isLength({ max: 50 }),
];

const broadcastSchema = [
  body('title').isString().trim().isLength({ min: 1, max: 100 }).withMessage('title is required (max 100 chars)'),
  body('body').isString().trim().isLength({ min: 1, max: 300 }).withMessage('body is required (max 300 chars)'),
  body('url').optional().isString().trim(),
  body('type').optional().isString().trim().isLength({ max: 50 }),
];

const historySchema = [
  param('userId').isUUID().withMessage('userId must be a valid UUID'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1–100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('offset must be ≥ 0'),
];

const preferenceSchema = [
  param('userId').isUUID().withMessage('userId must be a valid UUID'),
  body('type').isString().trim().notEmpty().withMessage('type is required'),
  body('enabled').isBoolean().withMessage('enabled must be a boolean'),
];

module.exports = {
  validate,
  subscribeSchema,
  unsubscribeSchema,
  sendSchema,
  broadcastSchema,
  historySchema,
  preferenceSchema,
};