const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentController = require('./payments.controller');
const { walletCheckoutSchema } = require('./payments.schema');
// const authMiddleware = require('../middleware/auth'); // Import your authentication validation middleware here

// Protect transactional nodes from high-frequency payment spam
const checkoutRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minute window
  max: 10, // Limit each client IP to 10 processing initiatives per window
  message: {
    status: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many financial transactions attempted from this endpoint. Please verify status and retry in 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Zod Validation Interceptor Middleware
const validateWalletPayload = (req, res, next) => {
  // Inject headers into request body context so Zod can parse them uniformly
  if (req.headers['idempotency-key']) {
    req.body.idempotencyKey = req.headers['idempotency-key'];
  }

  const result = walletCheckoutSchema.safeParse(req.body);
  
  if (!result.success) {
    return res.status(400).json({
      status: 'VALIDATION_FAILED',
      errors: result.error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message
      }))
    });
  }

  req.body = result.data; // Overwrite body with thoroughly sanitized data transformations
  next();
};

// Route Configuration Mapping
router.post(
  '/api/payments/wallet-checkout',
  // authMiddleware, // <-- Reactivate to populate req.user dynamically inside your controller
  checkoutRateLimiter,
  validateWalletPayload,
  paymentController.initiateWalletCheckout
);

module.exports = router;