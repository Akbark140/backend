// src/modules/analytics/analytics.repository.js

// PostgreSQL aggregation queries powering pie charts, monthly trends, and weekly trends.

const { pool } = require('../../config/db.config');

/**
 * Category breakdown for the pie chart.
 * Returns each category's total spend and percentage of overall expenses
 * for the given date range.
 *
 * @param {string} userId
 * @param {string} startDate  'YYYY-MM-DD'
 * @param {string} endDate    'YYYY-MM-DD'
 */
async function getCategoryBreakdown(userId, startDate, endDate) {
  const { rows } = await pool.query(
    `WITH expense_totals AS (
       SELECT
         c.id            AS category_id,
         c.name          AS category_name,
         c.color         AS category_color,
         SUM(t.amount)   AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.type    = 'expense'
         AND t.date BETWEEN $2 AND $3
       GROUP BY c.id, c.name, c.color
     ),
     grand_total AS (
       SELECT SUM(total) AS grand FROM expense_totals
     )
     SELECT
       et.category_id,
       et.category_name,
       et.category_color,
       et.total,
       ROUND((et.total / gt.grand) * 100, 1) AS percentage
     FROM expense_totals et, grand_total gt
     ORDER BY et.total DESC`,
    [userId, startDate, endDate]
  );
  return rows;
}

/**
 * Monthly trend — income vs expenses for the last N months.
 * Returns one row per month with income_total and expense_total.
 *
 * @param {string} userId
 * @param {number} months   How many months back (default 6)
 */
async function getMonthlyTrend(userId, months = 6) {
  const { rows } = await pool.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', date), 'YYYY-MM') AS month,
       SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END) AS income_total,
       SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense_total,
       SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END)
         - SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS net_savings
     FROM transactions
     WHERE user_id = $1
       AND date >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month' * $2
     GROUP BY DATE_TRUNC('month', date)
     ORDER BY DATE_TRUNC('month', date) ASC`,
    [userId, months]
  );
  return rows;
}

/**
 * Weekly trend — daily expense totals for the last N weeks.
 * Returns one row per day (only days with transactions).
 *
 * @param {string} userId
 * @param {number} weeks  How many weeks back (default 4)
 */
async function getWeeklyTrend(userId, weeks = 4) {
  const { rows } = await pool.query(
    `SELECT
       date::TEXT            AS day,
       TO_CHAR(date, 'Dy')   AS day_label,
       SUM(amount)           AS expense_total
     FROM transactions
     WHERE user_id = $1
       AND type    = 'expense'
       AND date   >= NOW() - INTERVAL '1 week' * $2
     GROUP BY date
     ORDER BY date ASC`,
    [userId, weeks]
  );
  return rows;
}

/**
 * Summary card data — total income, expenses, savings for a given month.
 *
 * @param {string} userId
 * @param {string} month  'YYYY-MM'
 */
async function getMonthlySummary(userId, month) {
  const startDate = `${month}-01`;
  const { rows } = await pool.query(
    `SELECT
       SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END) AS income,
       SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expenses,
       SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END)
         - SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS savings
     FROM transactions
     WHERE user_id = $1
       AND DATE_TRUNC('month', date) = DATE_TRUNC('month', $2::DATE)`,
    [userId, startDate]
  );
  return rows[0];
}

module.exports = {
  getCategoryBreakdown,
  getMonthlyTrend,
  getWeeklyTrend,
  getMonthlySummary,
};