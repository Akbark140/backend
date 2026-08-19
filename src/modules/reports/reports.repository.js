// src/modules/reports/reports.repository.js

'use strict';

const { query } = require('../../config/db.config');

async function getMonthlyTotals(userId, month, year) {
  const result = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN type='income'  THEN amount_in_base_currency END), 0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount_in_base_currency END), 0) AS expenses
     FROM transactions
     WHERE user_id=$1
       AND EXTRACT(MONTH FROM date)=$2
       AND EXTRACT(YEAR  FROM date)=$3
       AND deleted_at IS NULL`,
    [userId, month, year]
  );

  // FIX: Was `result[0] || result.rows?.[0]` — inconsistent with every other
  // function in this file which returns result.rows. Always use result.rows[0]
  // so the service reliably receives { income, expenses } and never undefined.
  return result.rows[0] || {};
}

async function getMonthlyTopCategories(userId, month, year) {
  const result = await query(
    `SELECT
       c.name AS "categoryName",
       c.icon AS "categoryIcon",
       SUM(t.amount_in_base_currency)::float AS total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.user_id=$1
       AND t.type='expense'
       AND EXTRACT(MONTH FROM t.date)=$2
       AND EXTRACT(YEAR  FROM t.date)=$3
       AND t.deleted_at IS NULL
     GROUP BY c.name, c.icon
     ORDER BY total DESC
     LIMIT 5`,
    [userId, month, year]
  );

  return result.rows || result;
}

async function getMonthlyCategoryBreakdown(userId, month, year) {
  const result = await query(
    `SELECT
       c.name  AS "categoryName",
       c.icon  AS "categoryIcon",
       c.color AS "categoryColor",
       COALESCE(SUM(t.amount_in_base_currency), 0)::float AS total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.user_id=$1
       AND t.type='expense'
       AND EXTRACT(MONTH FROM t.date)=$2
       AND EXTRACT(YEAR  FROM t.date)=$3
       AND t.deleted_at IS NULL
     GROUP BY c.name, c.icon, c.color
     ORDER BY total DESC`,
    [userId, month, year]
  );

  return result.rows || result;
}

async function getYearlyTotals(userId, year) {
  const result = await query(
    `SELECT
       EXTRACT(MONTH FROM date)::int AS month,
       COALESCE(SUM(CASE WHEN type='income'  THEN amount_in_base_currency END), 0)::float AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount_in_base_currency END), 0)::float AS expenses
     FROM transactions
     WHERE user_id=$1
       AND EXTRACT(YEAR FROM date)=$2
       AND deleted_at IS NULL
     GROUP BY EXTRACT(MONTH FROM date)`,
    [userId, year]
  );

  return result.rows || result;
}

async function getYearlyBreakdown(userId, year) {
  const result = await query(
    `SELECT
       EXTRACT(MONTH FROM t.date)::int AS month,
       c.name  AS "categoryName",
       c.icon  AS "categoryIcon",
       c.color AS "categoryColor",
       SUM(t.amount_in_base_currency)::float AS total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.user_id=$1
       AND t.type='expense'
       AND EXTRACT(YEAR FROM t.date)=$2
       AND t.deleted_at IS NULL
     GROUP BY EXTRACT(MONTH FROM t.date), c.name, c.icon, c.color
     ORDER BY month ASC, total DESC`,
    [userId, year]
  );

  return result.rows || result;
}

module.exports = {
  getMonthlyTotals,
  getMonthlyTopCategories,
  getMonthlyCategoryBreakdown,
  getYearlyTotals,
  getYearlyBreakdown,
};