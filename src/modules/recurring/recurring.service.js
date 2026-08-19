// recurring.service.js
// Detects recurring transactions by finding the same merchant/description
// appearing in 2+ distinct calendar months, then predicts the next occurrence.

const repo = require('./recurring.repository');

/**
 * Runs recurring detection for a user.
 * 1. Groups all expense transactions by cleanDescription (normalized).
 * 2. Finds any merchant that appears in 2+ different months.
 * 3. Marks matching transactions as is_recurring = true in the DB.
 * 4. Calculates next_expected_date based on average interval between occurrences.
 *
 * Returns a summary of detected recurring items.
 */
async function detectAndMarkRecurring(userId) {
  // Fetch all expenses with their date and description
  const expenses = await repo.getAllExpensesForDetection(userId);

  // Group by normalized merchant label
  const merchantMap = {};
  for (const tx of expenses) {
    const key = normalizeLabel(tx.description);
    if (!merchantMap[key]) {
      merchantMap[key] = { label: key, transactions: [] };
    }
    merchantMap[key].transactions.push(tx);
  }

  const detected = [];

  for (const [label, group] of Object.entries(merchantMap)) {
    const { transactions } = group;

    // Collect unique months this merchant appeared in
    const months = [...new Set(
      transactions.map(tx => tx.date.substring(0, 7)) // 'YYYY-MM'
    )];

    if (months.length < 2) continue; // Not recurring — only 1 month

    // Calculate average interval in days between occurrences
    const dates = transactions
      .map(tx => new Date(tx.date))
      .sort((a, b) => a - b);

    const avgIntervalDays = calculateAverageInterval(dates);
    const lastDate        = dates[dates.length - 1];
    const nextExpected    = addDays(lastDate, Math.round(avgIntervalDays));

    // Mark all matching transaction IDs as recurring in DB
    const ids = transactions.map(tx => tx.id);
    await repo.markAsRecurring(ids, label, nextExpected.toISOString().split('T')[0]);

    detected.push({
      label,
      occurrences:       transactions.length,
      avgIntervalDays:   Math.round(avgIntervalDays),
      nextExpectedDate:  nextExpected.toISOString().split('T')[0],
      lastAmount:        transactions[transactions.length - 1].amount,
    });
  }

  return detected;
}

/**
 * Returns upcoming recurring bills within the next N days.
 * Default: next 30 days.
 */
async function getUpcomingBills(userId, days = 30) {
  return repo.getUpcomingRecurring(userId, days);
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Normalize a transaction description for grouping.
 * Lowercases, strips numbers/punctuation, trims.
 * "KFC Gulberg - Rs. 2500" → "kfc gulberg"
 */
function normalizeLabel(description = '') {
  return description
    .toLowerCase()
    .replace(/rs\.?\s*[\d,]+/gi, '')   // strip currency amounts
    .replace(/[^a-z\s]/g, '')          // strip non-alpha
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

/**
 * Calculates average number of days between a sorted array of dates.
 */
function calculateAverageInterval(sortedDates) {
  if (sortedDates.length < 2) return 30; // default monthly

  let totalDays = 0;
  for (let i = 1; i < sortedDates.length; i++) {
    totalDays += (sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24);
  }
  return totalDays / (sortedDates.length - 1);
}

/**
 * Adds N days to a Date object and returns a new Date.
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

module.exports = { detectAndMarkRecurring, getUpcomingBills };