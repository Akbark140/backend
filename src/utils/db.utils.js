// utils/db.utils.js
//
// Reusable helpers for PostgreSQL queries.
// Works with raw node-postgres (pg) pool.

// ─────────────────────────────────────────────
// paginate(query) → { page, limit, offset }
//
// Reads page & limit from query params with sane defaults.
// Hard caps limit at 100 to prevent abuse.
//
// Usage:
//   const { page, limit, offset } = paginate(req.query);
//   const rows = await pool.query(
//     'SELECT * FROM users WHERE deleted_at IS NULL LIMIT $1 OFFSET $2',
//     [limit, offset]
//   );
//   res.json(paginateResponse(rows.rows, total, page, limit));
// ─────────────────────────────────────────────
function paginate(query = {}) {
  const page   = Math.max(1, parseInt(query.page,  10) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ─────────────────────────────────────────────
// paginateResponse(rows, total, page, limit)
//
// Wraps a page of results in a standard envelope.
// ─────────────────────────────────────────────
function paginateResponse(rows, total, page, limit) {
  const totalPages = Math.ceil(total / limit);
  return {
    data: rows,
    meta: {
      total,
      totalPages,
      page,
      limit,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

// ─────────────────────────────────────────────
// buildUpdateQuery(table, id, fields)
//
// Dynamically builds a safe UPDATE query from an
// object of fields — only updates what's provided.
//
// Usage:
//   const { text, values } = buildUpdateQuery('users', userId, {
//     name: 'John',
//     email: 'john@example.com',
//   });
//   await pool.query(text, values);
// ─────────────────────────────────────────────
function buildUpdateQuery(table, id, fields) {
  const keys    = Object.keys(fields).filter((k) => fields[k] !== undefined);
  const values  = keys.map((k) => fields[k]);
  const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');

  if (!keys.length) throw new Error('No fields provided for update');

  return {
    text: `
      UPDATE "${table}"
      SET ${setClauses}, updated_at = NOW()
      WHERE id = $${keys.length + 1}
        AND deleted_at IS NULL
      RETURNING *
    `,
    values: [...values, id],
  };
}

// ─────────────────────────────────────────────
// softDelete(pool, table, id)
//
// Sets deleted_at instead of running DELETE.
// Assumes your table has a deleted_at TIMESTAMPTZ column.
//
// Migration to add soft delete to a table:
//   ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
//   CREATE INDEX idx_users_deleted_at ON users (deleted_at);
//
// Usage:
//   await softDelete(pool, 'users', userId);
// ─────────────────────────────────────────────
async function softDelete(pool, table, id) {
  const result = await pool.query(
    `UPDATE "${table}" SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id]
  );
  return result.rowCount > 0; // false means already deleted or not found
}

// ─────────────────────────────────────────────
// isNotFound(rows)
//
// Quick guard for empty query results.
// ─────────────────────────────────────────────
function isNotFound(rows) {
  return !rows || rows.length === 0;
}

module.exports = {
  paginate,
  paginateResponse,
  buildUpdateQuery,
  softDelete,
  isNotFound,
};