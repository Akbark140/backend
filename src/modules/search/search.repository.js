const { query } = require('../../config/db.config');

async function searchTransactions(userId, searchTerm) {
  const sql = `
    SELECT
      t.id,
      t.user_id AS "userId",
      t.category_id AS "categoryId",
      c.name AS "categoryName",
      c.icon AS "categoryIcon",
      t.amount,
      t.currency,
      t.amount_in_base_currency AS "amountInBaseCurrency",
      t.type,
      t.description,
      t.note,
      t.date::text
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = $1
      AND t.deleted_at IS NULL
      AND (
        t.description ILIKE $2
        OR t.note ILIKE $2
        OR c.name ILIKE $2
      )
    ORDER BY t.date DESC, t.created_at DESC
    LIMIT 30;
  `;

  const result = await query(sql, [userId, `%${searchTerm}%`]);
  
  //  FIXED: Extract and return only the rows array instead of the raw pg wrapper object
  return result.rows ?? [];
}

module.exports = { searchTransactions };