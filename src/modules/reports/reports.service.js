// src/modules/reports/reports.service.js

'use strict';

const reportsRepo     = require('./reports.repository');
const transactionRepo = require('../transactions/transactions.repository');
const { generateMonthlyInsights } = require('../insights/insights.service');

/* ─────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────── */

function sumByType(transactions, type) {
  return transactions
    .filter((t) => t.type === type)
    .reduce((sum, t) => sum + Number(t.amount), 0);
}

function groupByCategory(transactions) {
  const map = {};

  for (const t of transactions) {
    const key = t.category_name || 'uncategorized';
    if (!map[key]) map[key] = 0;
    map[key] += Number(t.amount);
  }

  return Object.entries(map).map(([category, total]) => ({
    category,
    total,
  }));
}

/* ─────────────────────────────────────────────
   1. MONTHLY SUMMARY
   ───────────────────────────────────────────── */

async function getMonthlySummary(userId, month, year) {
  const totals = await reportsRepo.getMonthlyTotals(userId, month, year);

  const topCategories = await reportsRepo.getMonthlyTopCategories(
    userId,
    month,
    year
  );

  const totalIncome   = Number(totals.income   || 0);
  const totalExpenses = Number(totals.expenses || 0);

  return {
    month,
    year,
    totalIncome,
    totalExpenses,
    netSavings: totalIncome - totalExpenses,
    topCategories,
  };
}

/* ─────────────────────────────────────────────
   2. CATEGORY BREAKDOWN
   ───────────────────────────────────────────── */

async function getCategoryBreakdown(userId, month, year) {
  const rows = await reportsRepo.getMonthlyCategoryBreakdown(
    userId,
    month,
    year
  );

  if (!rows.length) return [];

  const grandTotal = rows.reduce(
    (sum, row) => sum + Number(row.total || 0),
    0
  );

  return rows.map((row) => ({
    categoryName:  row.categoryName,
    categoryIcon:  row.categoryIcon,
    categoryColor: row.categoryColor,
    total:         Number(row.total || 0),
    percentage:
      grandTotal > 0
        ? (Number(row.total || 0) / grandTotal) * 100
        : 0,
  }));
}

/* ─────────────────────────────────────────────
   3. MONTHLY ANALYTICS REPORT
   ───────────────────────────────────────────── */

async function getMonthlyAnalyticsReport(userId, month, year) {
  const summary   = await getMonthlySummary(userId, month, year);
  const breakdown = await getCategoryBreakdown(userId, month, year);
  const insights  = generateMonthlyInsights(summary, breakdown);

  return {
    ...summary,
    breakdown,
    insights,
  };
}

/* ─────────────────────────────────────────────
   4. YEARLY SUMMARY
   ───────────────────────────────────────────── */

async function getYearlySummary(userId, year) {
  const [totalsRows, breakdownRows] = await Promise.all([
    reportsRepo.getYearlyTotals(userId, year),
    reportsRepo.getYearlyBreakdown(userId, year),
  ]);

  // Index totals by month number for O(1) lookup
  const totalsByMonth = {};
  totalsRows.forEach((row) => {
    totalsByMonth[row.month] = row;
  });

  // Group breakdown rows by month
  const breakdownByMonth = {};
  breakdownRows.forEach((row) => {
    if (!breakdownByMonth[row.month]) {
      breakdownByMonth[row.month] = [];
    }
    breakdownByMonth[row.month].push({
      categoryName:  row.categoryName,
      categoryIcon:  row.categoryIcon,
      categoryColor: row.categoryColor,
      total:         Number(row.total),
    });
  });

  const results = [];

  for (let month = 1; month <= 12; month++) {
    const monthTotals  = totalsByMonth[month]    || { income: 0, expenses: 0 };
    const rawBreakdown = breakdownByMonth[month] || [];

    const totalIncome   = Number(monthTotals.income   || 0);
    const totalExpenses = Number(monthTotals.expenses || 0);

    const grandTotal = rawBreakdown.reduce((sum, row) => sum + row.total, 0);

    const breakdown = rawBreakdown.map((row) => ({
      ...row,
      percentage: grandTotal > 0 ? (row.total / grandTotal) * 100 : 0,
    }));

    const topCategories = breakdown.slice(0, 5).map((row) => ({
      categoryName: row.categoryName,
      categoryIcon: row.categoryIcon,
      total:        row.total,
    }));

    const summary = {
      month,
      year:         Number(year),
      totalIncome,
      totalExpenses,
      netSavings:   totalIncome - totalExpenses,
      topCategories,
    };

    const insights = generateMonthlyInsights(summary, breakdown);

    results.push({
      ...summary,
      breakdown,
      insights,
    });
  }

  return results;
}

/* ─────────────────────────────────────────────
   5. MONTHLY TRANSACTION REPORT
   ───────────────────────────────────────────── */

async function getMonthlyTransactionReport(userId, month, year) {
  const transactions = await transactionRepo.findByMonth(userId, month, year);

  const income  = sumByType(transactions, 'income');
  const expense = sumByType(transactions, 'expense');

  return {
    income,
    expense,
    balance:    income - expense,
    byCategory: groupByCategory(transactions),
    transactions,
  };
}

/* ─────────────────────────────────────────────
   EXPORTS
   ───────────────────────────────────────────── */

module.exports = {
  getMonthlySummary,
  getCategoryBreakdown,
  getMonthlyAnalyticsReport,
  getYearlySummary,
  getMonthlyTransactionReport,
};