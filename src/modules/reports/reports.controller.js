// reports.controller.js

const service = require('./reports.service');
const { sendSuccess } = require('../../shared/ApiResponse');

// ── Monthly Report ───────────────────────────────────────────────
async function getMonthlyReport(req, res, next) {
  try {
    const now = new Date();

    const month = Number(
      req.query.month ??
      now.getMonth() + 1
    );

    const year = Number(
      req.query.year ??
      now.getFullYear()
    );

    const data =
      await service.getMonthlySummary(
        req.user.id,
        month,
        year
      );

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ── Yearly Report ────────────────────────────────────────────────
async function getYearlyReport(req, res, next) {
  try {
    const year = Number(
      req.query.year ??
      new Date().getFullYear()
    );

    const data =
      await service.getYearlySummary(
        req.user.id,
        year
      );

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ── Category Breakdown ───────────────────────────────────────────
async function getCategoryBreakdown(req, res, next) {
  try {
    const now = new Date();

    const month = Number(
      req.query.month ??
      now.getMonth() + 1
    );

    const year = Number(
      req.query.year ??
      now.getFullYear()
    );

    const data =
      await service.getCategoryBreakdown(
        req.user.id,
        month,
        year
      );

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getMonthlyReport,
  getYearlyReport,
  getCategoryBreakdown,
};