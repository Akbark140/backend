// reports.routes.js

const { Router } = require('express');
const { authenticate } = require('../../middleware/authorize.middleware');
const { readOperationLimiter } = require('../../middleware/rateLimiter.middleware');
const controller = require('./reports.controller');

const router = Router();

router.use(authenticate);

router.get('/monthly', readOperationLimiter, controller.getMonthlyReport);
router.get('/yearly', readOperationLimiter, controller.getYearlyReport);
router.get('/breakdown', readOperationLimiter, controller.getCategoryBreakdown);

module.exports = { reportsRouter: router };
