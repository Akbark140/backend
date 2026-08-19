// src/modules/categories/categories.repository.js

const { query } = require('../../config/db.config');
const { v4: uuidv4 } = require('uuid');

const CATEGORY_SELECT = `
  id,
  user_id AS "userId",
  name,
  icon,
  color,
  type,
  is_default AS "isDefault",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function findAll(userId) {
  // 🟢 FIXED: Await the response and safely back up to an empty array
  const result = await query(
    `SELECT ${CATEGORY_SELECT}
     FROM categories
     WHERE user_id = $1
     ORDER BY is_default DESC, name ASC`,
    [userId]
  );
  return result.rows ?? [];
}

async function findByName(userId, name) {
  // 🟢 FIXED: Extract data from result.rows array safely
  const result = await query(
    `SELECT ${CATEGORY_SELECT}
     FROM categories
     WHERE user_id = $1
       AND LOWER(name) = LOWER($2)`,
    [userId, name]
  );

  return result.rows?.[0] || null;
}

async function findById(id, userId) {
  const result = await query(
    `SELECT id, user_id AS "userId", name, icon, color, type, is_default AS "isDefault"
     FROM categories WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return result.rows?.[0] || null;
}

async function create(userId, input) {
  const id = uuidv4();

    console.log('Inserting category with user_id:', userId, typeof userId);


  const result = await query(
    `INSERT INTO categories (id, user_id, name, icon, color, type, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     ON CONFLICT (user_id, name) DO NOTHING
     RETURNING id`, 
    [id, userId, input.name, input.icon, input.color, input.type]
  );

  const rowCount = result.rowCount !== undefined ? result.rowCount : (result.rows ? result.rows.length : 0);

  if (rowCount === 0) {
    return null; // Signals a duplicate conflict to the service layer
  }

  return findById(id, userId);
}

async function update(id, userId, input) {
  const fields = Object.keys(input);
  if (fields.length === 0) return findById(id, userId);

  const setClause = fields
    .map((field, index) => `"${field}" = $${index + 3}`)
    .join(', ');

  const values = fields.map(field => input[field]);

  try {
    const result = await query(
      `UPDATE categories 
       SET ${setClause}, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId, ...values]
    );

    if ((result.rowCount ?? result.rows?.length) === 0) return null;
    return findById(id, userId);
  } catch (err) {
    if (err.code === '23505') {
      return 'DUPLICATE';
    }
    throw err;
  }
}

async function remove(id, userId) {
  // 🟢 FIXED: Extract array values from wrapper to check length accurately
  const result = await query(
    `DELETE FROM categories
     WHERE id = $1
       AND user_id = $2
       AND is_default = false
     RETURNING id`,
    [id, userId]
  );

  return (result.rowCount ?? result.rows?.length) > 0;
}

module.exports = {
  findAll,
  findById,
  findByName,
  create,
  update,
  remove,
};
