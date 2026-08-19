// recurring.controller.js
const service = require('./recurring.service');
const { sendSuccess } = require('../../shared/ApiResponse');

/**
 * POST /api/recurring/detect
 * Runs the recurring detection algorithm for the authenticated user.
 * Call this after bulk transaction import, or on a schedule.
 */
async function detect(req, res, next) {
  try {
    const detected = await service.detectAndMarkRecurring(req.user.id);
    return sendSuccess(res, {
      detected,
      count: detected.length,
      message: `${detected.length} recurring pattern(s) found and marked.`,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/recurring/upcoming?days=30
 * Returns upcoming recurring bills within the next N days.
 */
async function upcoming(req, res, next) {
  try {
    const days  = parseInt(req.query.days, 10) || 30;
    const bills = await service.getUpcomingBills(req.user.id, days);
    return sendSuccess(res, bills);
  } catch (err) {
    next(err);
  }
}

module.exports = { detect, upcoming };