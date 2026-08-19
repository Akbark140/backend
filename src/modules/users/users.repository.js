const { query } = require('../../config/db.config');

// ==========================================
//  USER CRUD
// ==========================================

/**
 * Get user by ID
 */
async function getUserById(id) {
  const result = await query(
    `SELECT * FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

/**
 * Get user by email
 */
async function getUserByEmail(email) {
  const result = await query(
    `SELECT * FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0];
}

/**
 * Create new user
 */
async function createUser({
  id,
  name,
  email,
  password_hash,
  role = 'user',
  currency = 'USD',
}) {
  const result = await query(
    `INSERT INTO users 
    (id, name, email, password_hash, role, currency, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING *`,
    [id, name, email, password_hash, role, currency]
  );

  return result.rows[0];
}

/**
 * Update general user fields (flexible)
 */
async function updateUser(id, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);

  const setClause = keys
    .map((key, index) => `${key} = $${index + 2}`)
    .join(', ');

  const result = await query(
    `UPDATE users 
     SET ${setClause}, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, ...values]
  );

  return result.rows[0];
}

/**
 * Delete user permanently
 */
async function deleteUser(id) {
  const result = await query(
    `DELETE FROM users WHERE id = $1 RETURNING *`,
    [id]
  );

  return result.rows[0];
}

// ==========================================
//  PROFILE FIELDS
// ==========================================

async function updateName(id, name) {
  const result = await query(
    `UPDATE users SET name = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, name]
  );

  return result.rows[0];
}

async function updateAvatarUrl(id, avatar_url) {
  const result = await query(
    `UPDATE users SET avatar_url = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, avatar_url]
  );

  return result.rows[0];
}

async function updateCurrency(id, currency) {
  const result = await query(
    `UPDATE users SET currency = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, currency]
  );

  return result.rows[0];
}

async function updateTimezone(id, timezone) {
  const result = await query(
    `UPDATE users SET timezone = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, timezone]
  );

  return result.rows[0];
}

// ==========================================
//  SECURITY FIELDS
// ==========================================

async function updatePasswordHash(id, password_hash) {
  const result = await query(
    `UPDATE users SET password_hash = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, password_hash]
  );

  return result.rows[0];
}

async function setEmailVerified(id, value = true) {
  const result = await query(
    `UPDATE users SET isverified = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, value]
  );

  return result.rows[0];
}

async function storeVerificationToken(id, token, expiresAt) {
  const result = await query(
    `UPDATE users 
     SET verification_token = $2,
         verification_token_expires_at = $3,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, token, expiresAt]
  );

  return result.rows[0];
}

async function clearVerificationToken(id) {
  const result = await query(
    `UPDATE users 
     SET verification_token = NULL,
         verification_token_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows[0];
}

// ==========================================
// ACCOUNT STATE
// ==========================================

async function setActiveStatus(id, is_active) {
  const result = await query(
    `UPDATE users SET is_active = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, is_active]
  );

  return result.rows[0];
}

async function softDeleteUser(id) {
  const result = await query(
    `UPDATE users 
     SET is_active = false,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows[0];
}

async function restoreUser(id) {
  const result = await query(
    `UPDATE users 
     SET is_active = true,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows[0];
}

// ==========================================
// BALANCE / FINANCE
// ==========================================

/**
 * Get balance
 */
async function getBalance(id) {
  const result = await query(
    `SELECT balance FROM users WHERE id = $1`,
    [id]
  );

  return result.rows[0]?.balance;
}

/**
 * Lock user row (FOR UPDATE)
 * IMPORTANT: must be used inside transaction
 */
async function lockUserRow(client, id) {
  const result = await client.query(
    `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
    [id]
  );

  return result.rows[0];
}

/**
 * Update balance (TRANSACTION SAFE)
 * IMPORTANT: must be called inside BEGIN/COMMIT
 */
async function updateBalance(client, id, newBalance) {
  const result = await client.query(
    `UPDATE users 
     SET balance = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, newBalance]
  );

  return result.rows[0];
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  // CRUD
  getUserById,
  getUserByEmail,
  createUser,
  updateUser,
  deleteUser,

  // Profile
  updateName,
  updateAvatarUrl,
  updateCurrency,
  updateTimezone,

  // Security
  updatePasswordHash,
  setEmailVerified,
  storeVerificationToken,
  clearVerificationToken,

  // Account state
  setActiveStatus,
  softDeleteUser,
  restoreUser,

  // Finance
  getBalance,
  lockUserRow,
  updateBalance,
};


/** 
updateBalance MUST be used like this:


await withTransaction(async (client) => {
  const user = await lockUserRow(client, userId);

  const newBalance = user.balance + amount;

  await updateBalance(client, userId, newBalance);
});
*/