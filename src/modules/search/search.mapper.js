// search.mapper.js

/**
 * Maps a raw transaction DB row into a clean frontend-ready object.
 * Matches the columns returned by search.repository.js
 */
function mapTransactionResult(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    userId: row.userId,
    categoryId: row.categoryId ?? null,
    categoryName: row.categoryName ?? null,
    categoryIcon: row.categoryIcon ?? null,
    amount: row.amount,
    currency: row.currency,
    amountInBaseCurrency: row.amountInBaseCurrency ?? null,
    type: row.type,
    description: row.description ?? '',
    date: row.date,
  };
}

function mapTransactionResults(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(mapTransactionResult).filter(Boolean);
}

module.exports = { mapTransactionResult, mapTransactionResults };