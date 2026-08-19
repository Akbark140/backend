const { query } = require('../../config/db.config');

// ── Get all bills for a user ──────────────────────────────
async function findAllByUser(userId) {
  const sql = `
    SELECT
      b.id,
      b.user_id        AS "userId",
      b.category_id    AS "categoryId",
      c.name           AS "categoryName",
      c.icon           AS "categoryIcon",
      b.name,
      b.amount,
      b.currency,
      b.due_date::text AS "dueDate",
      b.recurrence,
      b.status,
      b.notes,
      b.is_autopay     AS "isAutopay",
      b.created_at::text AS "createdAt",
      b.updated_at::text AS "updatedAt"
    FROM bills b
    LEFT JOIN categories c ON c.id = b.category_id
    WHERE b.user_id = $1
      AND b.deleted_at IS NULL
    ORDER BY b.due_date ASC;
  `;
  const result = await query(sql, [userId]);
  return result.rows ?? [];
}

// ── Get single bill ───────────────────────────────────────
async function findById(billId, userId) {
  const sql = `
    SELECT
      b.id,
      b.user_id        AS "userId",
      b.category_id    AS "categoryId",
      c.name           AS "categoryName",
      c.icon           AS "categoryIcon",
      b.name,
      b.amount,
      b.currency,
      b.due_date::text AS "dueDate",
      b.recurrence,
      b.status,
      b.notes,
      b.is_autopay     AS "isAutopay",
      b.created_at::text AS "createdAt",
      b.updated_at::text AS "updatedAt"
    FROM bills b
    LEFT JOIN categories c ON c.id = b.category_id
    WHERE b.id = $1
      AND b.user_id = $2
      AND b.deleted_at IS NULL;
  `;
  const result = await query(sql, [billId, userId]);
  return result.rows[0] ?? null;
}

// ── Get overdue bills ─────────────────────────────────────
async function findOverdue(userId) {
  const sql = `
    SELECT
      b.id,
      b.user_id        AS "userId",
      b.category_id    AS "categoryId",
      c.name           AS "categoryName",
      c.icon           AS "categoryIcon",
      b.name,
      b.amount,
      b.currency,
      b.due_date::text AS "dueDate",
      b.recurrence,
      b.status,
      b.notes,
      b.is_autopay     AS "isAutopay",
      b.created_at::text AS "createdAt",
      b.updated_at::text AS "updatedAt"
    FROM bills b
    LEFT JOIN categories c ON c.id = b.category_id
    WHERE b.user_id = $1
      AND b.deleted_at IS NULL
      AND b.status != 'paid'
      AND b.due_date < CURRENT_DATE
    ORDER BY b.due_date ASC;
  `;
  const result = await query(sql, [userId]);
  return result.rows ?? [];
}

// ── Get upcoming bills (next 30 days) ─────────────────────
async function findUpcoming(userId) {
  const sql = `
    SELECT
      b.id,
      b.user_id        AS "userId",
      b.category_id    AS "categoryId",
      c.name           AS "categoryName",
      c.icon           AS "categoryIcon",
      b.name,
      b.amount,
      b.currency,
      b.due_date::text AS "dueDate",
      b.recurrence,
      b.status,
      b.notes,
      b.is_autopay     AS "isAutopay",
      b.created_at::text AS "createdAt",
      b.updated_at::text AS "updatedAt"
    FROM bills b
    LEFT JOIN categories c ON c.id = b.category_id
    WHERE b.user_id = $1
      AND b.deleted_at IS NULL
      AND b.status != 'paid'
      AND b.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    ORDER BY b.due_date ASC;
  `;
  const result = await query(sql, [userId]);
  return result.rows ?? [];
}

// ── Create bill ───────────────────────────────────────────
async function createBill(userId, data) {
  const sql = `
    INSERT INTO bills (
      user_id,
      category_id,
      name,
      amount,
      currency,
      due_date,
      recurrence,
      status,
      notes,
      is_autopay
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING
      id,
      user_id        AS "userId",
      category_id    AS "categoryId",
      name,
      amount,
      currency,
      due_date::text AS "dueDate",
      recurrence,
      status,
      notes,
      is_autopay     AS "isAutopay",
      created_at::text AS "createdAt",
      updated_at::text AS "updatedAt";
  `;
  const result = await query(sql, [
    userId,
    data.category_id ?? null,
    data.name,
    data.amount,
    data.currency,
    data.due_date,
    data.recurrence,
    data.status,
    data.notes ?? null,
    data.is_autopay,
  ]);

  return result.rows[0];
}

// ── Update bill ───────────────────────────────────────────
async function updateBill(billId, userId, data) {
  const fields = [];
  const values = [];
  let idx = 1;

  const allowed = ['name', 'amount', 'currency', 'due_date', 'category_id', 'recurrence', 'status', 'notes', 'is_autopay'];

  const updateData = data || {};

  // 1. Build the dynamic body updates
  for (const key of allowed) {
    if (updateData[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(updateData[key]);
    }
  }

  // If nothing was passed to update, exit early safely
  if (fields.length === 0) return null;

  // 2. Add fixed fields
  fields.push(`updated_at = NOW()`);

  // 3. Map WHERE clause conditions using the correct sequential indexes
  const billIdIdx = idx++;  // Next available index number
  const userIdIdx = idx++;  // Following index number

  values.push(billId, userId); // Pushed in identical order to match indexes above

  const sql = `
    UPDATE bills
    SET ${fields.join(', ')}
    WHERE id = $${billIdIdx}
      AND user_id = $${userIdIdx}
      AND deleted_at IS NULL
    RETURNING
      id,
      user_id        AS "userId",
      category_id    AS "categoryId",
      name,
      amount,
      currency,
      due_date::text AS "dueDate",
      recurrence,
      status,
      notes,
      is_autopay     AS "isAutopay",
      created_at::text AS "createdAt",
      updated_at::text AS "updatedAt";
  `;

  const result = await query(sql, values);
  return result.rows[0] ?? null;
}

// ── Mark as paid ──────────────────────────────────────────
async function markAsPaid(billId, userId) {
  const sql = `
    UPDATE bills
    SET status = 'paid', updated_at = NOW()
    WHERE id = $1
      AND user_id = $2
      AND deleted_at IS NULL
    RETURNING
      id,
      user_id        AS "userId",
      name,
      amount,
      currency,
      due_date::text AS "dueDate",
      status,
      updated_at::text AS "updatedAt";
  `;
  const result = await query(sql, [billId, userId]);
  return result.rows[0] ?? null;
}

// ── Mark as unpaid ────────────────────────────────────────
async function markAsUnpaid(billId, userId) {
  const sql = `
    UPDATE bills
    SET status = 'unpaid', updated_at = NOW()
    WHERE id = $1
      AND user_id = $2
      AND deleted_at IS NULL
    RETURNING
      id,
      user_id        AS "userId",
      name,
      amount,
      currency,
      due_date::text AS "dueDate",
      status,
      updated_at::text AS "updatedAt";
  `;
  const result = await query(sql, [billId, userId]);
  return result.rows[0] ?? null;
}

// ── Soft delete ───────────────────────────────────────────
async function deleteBill(billId, userId) {
  const sql = `
    UPDATE bills
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = $1
      AND user_id = $2
      AND deleted_at IS NULL
    RETURNING id;
  `;
  const result = await query(sql, [billId, userId]);
  return result.rows[0] ?? null;
}

async function clearAll() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Safety Guard: Cannot execute clearAll() in production environments!');
  }
  const sql = `TRUNCATE TABLE bills RESTART IDENTITY CASCADE;`;
  return await query(sql);
}

/**
 * Helper to programmatically construct mock implementations if your Unit Suite requires 
 * standalone, database-free repository stubs without invoking real DB connection footprints.
 */
function createMock() {
  return {
    findAllByUser: jest.fn(),
    findById: jest.fn(),
    findOverdue: jest.fn(),
    findUpcoming: jest.fn(),
    createBill: jest.fn(),
    updateBill: jest.fn(),
    markAsPaid: jest.fn(),
    markAsUnpaid: jest.fn(),
    deleteBill: jest.fn(),
    clearAll: jest.fn()
  };
}

module.exports = {
  findAllByUser,
  findById,
  findOverdue,
  findUpcoming,
  createBill,
  updateBill,
  markAsPaid,
  markAsUnpaid,
  deleteBill,
  clearAll,
  createMock
};