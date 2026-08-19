// transactions.routes.js

const { Router } = require('express');

const { authenticate } = require('../../middleware/authorize.middleware');
const { validate } = require('../../middleware/validate.middleware');

const {
  createTransactionSchema,
  updateTransactionSchema,
  listTransactionsSchema,
} = require('./transactions.schema');

const controller = require('./transactions.controller');

const router = Router();

// Protect all transaction endpoints via your authorization session gate
router.use(authenticate);

// ── Transaction Routes ───────────────────────────────────────────

// Get all authenticated, filtered, and paginated transactions
router.get(
  '/',
  validate(listTransactionsSchema, 'query'),
  controller.getAllTransactions
);

// Get a single transaction by ID
router.get(
  '/:id',
  controller.getTransactionById
);

// Add this route right inside transactions.routes.js:

router.get(
  '/reports/monthly',
  controller.getMonthlyReport
);

// Create a transaction (with strict balance verification rules)
router.post(
  '/',
  validate(createTransactionSchema),
  controller.createTransaction
);

// Update a transaction's properties safely
router.patch(
  '/:id',
  validate(updateTransactionSchema),
  controller.updateTransaction
);


// Soft delete a single transaction record
router.delete(
  '/:id',
  controller.deleteTransaction
);

module.exports = router;