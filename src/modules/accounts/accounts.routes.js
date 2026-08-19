// src/modules/accounts/accounts.routes.js

const express = require('express');
const router = express.Router();
const ctrl = require('./accounts.controller');
const { authenticate } = require('../../middleware/authorize.middleware');
const { readOperationLimiter } = require('../../middleware/rateLimiter.middleware');

router.use(authenticate);

// Main collection endpoints
router.route('/')
  .post(ctrl.create)
  .get(ctrl.list);

// Core analytical aggregates (expensive operations)
router.get('/summary', readOperationLimiter, ctrl.summary);
router.get('/net-worth', readOperationLimiter, ctrl.netWorth);
router.get('/ai-context', readOperationLimiter, ctrl.getAIContext);

router.patch('/recover-all', ctrl.recoverAll);

// Instance specific pathways
router.route('/:id')
  .get(ctrl.getById)
  .put(ctrl.update)
  .delete(ctrl.remove);

// Modification modifiers
router.patch('/:id/archive', ctrl.archive);  
router.patch('/:id/restore', ctrl.restore);
router.patch('/:id/default', ctrl.setDefault);

// Ledger balance mutation channels
router.post('/:id/deposit', ctrl.deposit);
router.post('/:id/withdraw', ctrl.withdraw);
router.post('/:id/transfer', ctrl.transfer);

module.exports = router;