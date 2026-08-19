const express = require('express');
const { publicLimiter } = require('../../middleware/rateLimiter.middleware');
const featureController = require('./feature.controller');
// const { protect, admin } = require('../middleware/authMiddleware'); // Uncomment when ready to secure tonight

// ─── Create Router ────────────────────────────────────────────────
const router = express.Router();

// ─── Public Endpoint ──────────────────────────────────────────────
// This is what your UpcomingFeatures.jsx page calls on mount
router.get('/', publicLimiter, featureController.getFeatures);

// ─── Protected Admin Endpoint ─────────────────────────────────────
// This is what you call from Postman to update or add features
// Swap in your auth middlewares (e.g., protect, admin) to lock it down
router.post('/', publicLimiter, featureController.upsertFeature);

module.exports = router;