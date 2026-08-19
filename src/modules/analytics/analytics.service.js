// src/modules/analytics/analytics.service.js

// Thin service layer. Validates params and delegates to the repository.

const repo = require('./analytics.repository');

/**
 * Returns category breakdown for pie chart.
 * Defaults to the current calendar month if no range provided.
 */
async function getCategoryBreakdown(userId, startDate, endDate) {
  const now   = new Date();
  const start = startDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const end   = endDate   || now.toISOString().split('T')[0];
  return repo.getCategoryBreakdown(userId, start, end);
}

/**
 * Returns monthly income vs expense trend.
 * months: 1–24 (capped for safety)
 */
async function getMonthlyTrend(userId, months) {
  const safeMonths = Math.min(Math.max(Number(months) || 6, 1), 24);
  return repo.getMonthlyTrend(userId, safeMonths);
}

/**
 * Returns weekly daily expense breakdown.
 * weeks: 1–12 (capped for safety)
 */
async function getWeeklyTrend(userId, weeks) {
  const safeWeeks = Math.min(Math.max(Number(weeks) || 4, 1), 12);
  return repo.getWeeklyTrend(userId, safeWeeks);
}

/**
 * Returns the summary card data for a given month (defaults to current month).
 */
async function getMonthlySummary(userId, month) {
  const now         = new Date();
  const safeMonth   = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const summary     = await repo.getMonthlySummary(userId, safeMonth);

  // Ensure numeric types even if no transactions exist yet
  return {
    income:   Number(summary?.income   || 0),
    expenses: Number(summary?.expenses || 0),
    savings:  Number(summary?.savings  || 0),
    month:    safeMonth,
  };
}

module.exports = { 
  getCategoryBreakdown, 
  getMonthlyTrend, 
  getWeeklyTrend, 
  getMonthlySummary 
};