const { Router } = require('express');

const { authenticate, authorize } = require('../../middleware/authorize.middleware');
const { readOperationLimiter } = require('../../middleware/rateLimiter.middleware');
const notificationController = require('./notification.controller');
const {
  validate,
  subscribeSchema,
  unsubscribeSchema,
  sendSchema,
  broadcastSchema,
  historySchema,
  preferenceSchema,
} = require('./notification.schema');

const router = Router();

// ── Public Endpoints ─────────────────────────────────────────────────────────
router.get('/vapid-public-key', notificationController.getVapidPublicKey);

// ── Authenticated User Endpoints (Implicit Session Context) ──────────────────
router.post('/subscribe', authenticate, subscribeSchema, validate, notificationController.subscribe);
router.post('/unsubscribe', authenticate, unsubscribeSchema, validate, notificationController.unsubscribe);

router.get('/history', authenticate, readOperationLimiter, historySchema, validate, notificationController.getHistory);
router.get('/preferences', authenticate, notificationController.getPreferences);
router.patch('/preferences', authenticate, preferenceSchema, validate, notificationController.updatePreference);

// ── Privileged Administrative Endpoints ──────────────────────────────────────
router.post('/send/:userId', authenticate, authorize('admin'), sendSchema, validate, notificationController.sendToUser);
router.post('/broadcast', authenticate, authorize('admin'), broadcastSchema, validate, notificationController.broadcast);

module.exports = router;