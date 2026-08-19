'use strict';

/**
 * @module ai/ai.router
 * @description Express router for all AI endpoints.
 *
 * Route summary:
 *
 *  Chat
 *    GET    /chat/history                  → chat history from DB
 *    DELETE /chat/history                  → clear user's chat history
 *    POST   /chat                          → streaming SSE chat (sync)
 *
 *  Async AI jobs (returns jobId immediately)
 *    POST   /analyze                       → enqueue analysis job
 *    POST   /suggest                       → enqueue suggestions job
 *    POST   /insights/:year/:month         → enqueue monthly insights job
 *
 *  Job polling
 *    GET    /jobs/:jobId                   → poll job status + result
 *
 *  Insights history (from ai_insights table)
 *    GET    /insights                      → list persisted insights
 *    PATCH  /insights/:id/apply            → mark insight as applied
 *
 *  Reports
 *    POST   /report/:month                 → enqueue PDF report (YYYY-MM)
 *
 *  Receipt
 *    POST   /receipt                       → synchronous receipt scan
 *
 *  Education
 *    GET    /education/topics
 *    GET    /education/tip/:index
 *    GET    /education/topic/:name
 *
 *  Ops
 *    GET    /circuit-status                → circuit-breaker health
 */

const { Router }     = require('express');
const   multer       = require('multer');
const controller     = require('./ai.controller');

// Multer: receipt uploads (memory, 10 MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Middleware placeholders — replace with your actual auth + rate-limit middleware
const { authenticate } = require('../../middleware/authorize.middleware');
const { aiRateLimiter } = require('../../middleware/rateLimiter.middleware');

const router = Router();

// Apply auth to all AI routes
router.use(authenticate);

// ─── Chat ────────────────────────────────────────────────────────────────────
router.get   ('/chat/history',        aiRateLimiter, controller.getChatHistory);
router.delete('/chat/history',        aiRateLimiter, controller.clearChatHistory);
router.post  ('/chat',                aiRateLimiter, controller.chat);

// ─── Async AI jobs ────────────────────────────────────────────────────────────
router.post('/analyze',              aiRateLimiter, controller.analyze);
router.post('/suggest',              aiRateLimiter, controller.suggest);
router.post('/insights/:year/:month', aiRateLimiter, controller.requestInsights);

// ─── Job polling ──────────────────────────────────────────────────────────────
router.get('/jobs/:jobId', aiRateLimiter, controller.getJobStatus);

// ─── Insights history ─────────────────────────────────────────────────────────
router.get  ('/insights',           aiRateLimiter, controller.getInsightsHistory);
router.patch('/insights/:id/apply', aiRateLimiter, controller.markInsightApplied);

// ─── Reports ─────────────────────────────────────────────────────────────────
router.post('/report/:month', aiRateLimiter, controller.getMonthlyReport);

// ─── Receipt ─────────────────────────────────────────────────────────────────
router.post('/receipt', aiRateLimiter, upload.single('receipt'), controller.scanReceipt);

// ─── Education ───────────────────────────────────────────────────────────────
router.get('/education/topics',        controller.getEducationTopics);
router.get('/education/tip/:index',    controller.getEducationTip);
router.get('/education/topic/:name',   controller.getEducationTipByTopic);

// ─── Ops ─────────────────────────────────────────────────────────────────────
router.get('/circuit-status', controller.getCircuitStatus);

module.exports = router;