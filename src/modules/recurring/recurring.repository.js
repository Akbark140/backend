// recurring.repository.js
const { pool } = require('../../config/db.config');

/**
 * Fetch all expense transactions for a user — only fields needed for detection.
 */
async function getAllExpensesForDetection(userId) {
  const { rows } = await pool.query(
    `SELECT id, description, amount, date
     FROM transactions
     WHERE user_id = $1 AND type = 'expense'
     ORDER BY date ASC`,
    [userId]
  );
  return rows;
}

/**
 * Bulk-mark an array of transaction IDs as recurring.
 */
async function markAsRecurring(ids, label, nextExpectedDate) {
  if (!ids.length) return;
  await pool.query(
    `UPDATE transactions
     SET
       is_recurring       = TRUE,
       recurring_label    = $1,
       next_expected_date = $2
     WHERE id = ANY($3::uuid[])`,
    [label, nextExpectedDate, ids]
  );
}

/**
 * Returns distinct recurring merchants with their next expected date,
 * filtered to those within the next N days.
 */
async function getUpcomingRecurring(userId, days = 30) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (recurring_label)
       id,
       recurring_label            AS label,
       amount                     AS last_amount,
       next_expected_date,
       (next_expected_date - CURRENT_DATE) AS days_until
     FROM transactions
     WHERE user_id          = $1
       AND is_recurring     = TRUE
       AND next_expected_date IS NOT NULL
       AND next_expected_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2
     ORDER BY recurring_label, next_expected_date ASC`,
    [userId, days]
  );
  return rows;
}

module.exports = { getAllExpensesForDetection, markAsRecurring, getUpcomingRecurring };