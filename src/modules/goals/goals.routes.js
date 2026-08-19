// goals.routes.js

const express = require('express');
const router = express.Router();
const goalsController = require('./goals.controller');

// Import your authentication middleware (adjust path based on your project structure)
const { authenticate } = require('../../middleware/authorize.middleware');

/**
 * ─────────────────────────────────────────────────────────────────
 * FINANCIAL GOALS ROUTES
 * All routes are strictly protected to ensure isolated user sessions.
 * ─────────────────────────────────────────────────────────────────
 */

// Apply authentication middleware to all routes in this router
router.use(authenticate);

// Global Goal Collection Management
router.route('/')
  .get(goalsController.list)       // GET /api/goals - Fetch all active/completed goals for the user
  .post(goalsController.create);   // POST /api/goals - Initialize a brand new goal

// Individual Goal Lifecycle Management
router.route('/:id')
  .get(goalsController.getById)    // GET /api/goals/:id - Retrieve specific goal details
  .patch(goalsController.update)   // PATCH /api/goals/:id - Dynamically modify properties (reopen, pause, edit amount)
  .delete(goalsController.remove); // DELETE /api/goals/:id - Remove or archive the goal safely

// Contribution & Ledger Processing
router.route('/:id/contribute')
  .post(goalsController.contribute); // POST /api/goals/:id/contribute - Inject funds & create ledger history

module.exports = router;