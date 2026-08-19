//

const express = require('express');
const { authenticate } = require('../../middleware/authorize.middleware');
const controller = require('./bills.controller');
const { validateBody, validateParams } = require('./bills.schema');

const router = express.Router();

// All bill routes require authentication
router.use(authenticate);

// ── List & Create ─────────────────────────────────────────
router.get('/',         controller.getAllBills);       // GET  /api/bills
router.post('/',        validateBody, controller.createBill);  // POST /api/bills

// ── Single Bill ───────────────────────────────────────────
router.get('/:id',      validateParams, controller.getBillById);   // GET    /api/bills/:id
router.patch('/:id',    validateParams, controller.updateBill);    // PATCH  /api/bills/:id
router.delete('/:id',   validateParams, controller.deleteBill);    // DELETE /api/bills/:id

// ── Actions ───────────────────────────────────────────────
router.patch('/:id/pay',    validateParams, controller.markAsPaid);     // PATCH /api/bills/:id/pay
router.patch('/:id/unpay',  validateParams, controller.markAsUnpaid);   // PATCH /api/bills/:id/unpay

// ── Filtered views ────────────────────────────────────────
router.get('/filter/overdue',   controller.getOverdueBills);    // GET /api/bills/filter/overdue
router.get('/filter/upcoming',  controller.getUpcomingBills);   // GET /api/bills/filter/upcoming

module.exports = router;
