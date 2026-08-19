// src/modules/accounts/accounts.repository.js

const db  = require('../../config/db.config'); // Your pg Pool instance

/**
 * Helper utility to safely extract rows regardless of the db.config wrapper structure
 */
function unpackRows(result) {
  return result && result.rows ? result.rows : result;
}

/**
 * Executes raw SQL insertions to create an account row in PostgreSQL
 */
async function createAccount(userId, data, isFirstAccount = false) {
  const query = `
    INSERT INTO accounts (
      user_id, name, type, currency, balance, is_default
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;

  const values = [
    userId,
    data.name,
    data.type.toUpperCase().trim(),
    data.currency || 'PKR',
    data.balance || 0.00,
    isFirstAccount || false
  ];

  try {
    const result = await db.query(query, values);
    const rows = unpackRows(result);

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`Database accepted query parameters but returned empty row lists.`);
    }

    return rows[0]; 
  } catch (dbError) {
    console.error("====== REAL REPO LAYER CATCH ======");
    console.error(dbError);
    throw dbError;
  }
}

/**
 * Queries the database for all active, non-deleted accounts belonging to a specific user
 * @param {string} userId - The unique UUID of the logged-in user
 */
async function findAllByUser(userId) {
  const query = `
    SELECT id, user_id, name, type, currency, balance,
           institution_name, account_number_masked, status, 
           is_default, created_at, updated_at 
    FROM accounts 
    WHERE user_id = $1 
      AND deleted_at IS NULL 
    ORDER BY is_default DESC, name ASC;
  `;
  
  const result = await db.query(query, [userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Queries a single account by ID and verifies owner access
 */
/**
 * Core lookups: Safely fetch a single account by its primary key integer ID
 * @param {number|string} accountId - The ID sent from req.params.id
 */
async function findById(accountId) {
  const query = `
    SELECT * FROM accounts 
    WHERE id = $1 
      AND deleted_at IS NULL;
  `;
  
  // Clean parameter formatting: Force string params from URL to a clean Integer base
  const parsedId = parseInt(accountId, 10);
  
  const result = await db.query(query, [parsedId]);
  
  // Unpack using your custom wrapper array structure
  const rows = result && result.rows ? result.rows : result;
  
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}
/**
 * Updates variable parameters using a single destructured configurations object
 */
async function updateAccount({ accountId, userId, data = {} }) {
  // Explicit Index Tracking:
  // $1 -> name, $2 -> type, $3 -> balance, $4 -> currency, $5 -> accountId, $6 -> userId
  const query = `
    UPDATE accounts 
    SET name = COALESCE($1, name),
        type = COALESCE($2, type),
        balance = COALESCE($3, balance),
        currency = COALESCE($4, currency),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $5 
      AND user_id = $6 
      AND deleted_at IS NULL
    RETURNING *;
  `;
  
  const values = [
    data.name !== undefined ? data.name : null,
    data.type !== undefined ? data.type.toUpperCase().trim() : null,
    data.balance !== undefined ? data.balance : null,
    data.currency !== undefined ? data.currency : null,
    parseInt(accountId, 10),
    userId // Safe UUID string position validation 
  ];

  const result = await db.query(query, values);
  const rows = result && result.rows ? result.rows : result;
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Atomically updates an account balance. Prevents dirty read race conditions.
 * @param {string} accountId 
 * @param {number} amount Positive for income, negative for expenses
 */
async function mutateBalance(accountId, userId, amount) {
  const query = `
    UPDATE accounts 
    SET balance = balance + $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $2 
      AND user_id = $3 
      AND status = 'ACTIVE' 
      AND deleted_at IS NULL
    RETURNING *;
  `;
  const result = await db.query(query, [amount, accountId, userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Fetches data grouped by currency to facilitate cross-currency aggregates
 */
async function getBalancesGroupedByCurrency(userId) {
  const query = `
    SELECT currency, 
           SUM(CASE WHEN type = 'CREDIT_CARD' THEN -balance ELSE balance END) as net_balance,
           SUM(CASE WHEN type != 'CREDIT_CARD' THEN balance ELSE 0 END) as assets,
           SUM(CASE WHEN type = 'CREDIT_CARD' THEN balance ELSE 0 END) as liabilities
    FROM accounts
    WHERE user_id = $1 
      AND status = 'ACTIVE' 
      AND deleted_at IS NULL
    GROUP BY currency;
  `;
  const result = await db.query(query, [userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Saves a daily net worth snapshot
 */
async function saveSnapshot(userId, { assets, liabilities, netWorth }) {
  const query = `
    INSERT INTO account_snapshots (user_id, total_assets, total_liabilities, net_worth)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, snapshot_date) 
    DO UPDATE SET 
      total_assets = EXCLUDED.total_assets,
      total_liabilities = EXCLUDED.total_liabilities,
      net_worth = EXCLUDED.net_worth
    RETURNING *;
  `;
  const result = await db.query(query, [userId, assets, liabilities, netWorth]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Soft deletes an account ledger record
 */
async function deleteAccount(accountId, userId) {
  const query = `
    UPDATE accounts 
    SET deleted_at = CURRENT_TIMESTAMP, 
        is_default = FALSE 
    WHERE id = $1 
      AND user_id = $2 
    RETURNING *;
  `;
  const result = await db.query(query, [accountId, userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Verifies if an account profile belongs to a given user security context
 */
async function verifyOwnership(accountId, userId) {
  const query = `SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL;`;
  const result = await db.query(query, [accountId, userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Calculates asset accumulation totals across active entities
 */
async function getTotalAssets(userId) {
  const query = `
    SELECT COALESCE(SUM(balance), 0) as total 
    FROM accounts 
    WHERE user_id = $1 
      AND type NOT IN ('CREDIT_CARD', 'LOAN') 
      AND status = 'ACTIVE' 
      AND deleted_at IS NULL;
  `;
  const result = await db.query(query, [userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? Number(rows[0].total) : 0;
}

/**
 * Calculates debt total values across liability vectors
 */
async function getTotalLiabilities(userId) {
  const query = `
    SELECT COALESCE(SUM(balance), 0) as total 
    FROM accounts 
    WHERE user_id = $1 
      AND type IN ('CREDIT_CARD', 'LOAN') 
      AND status = 'ACTIVE' 
      AND deleted_at IS NULL;
  `;
  const result = await db.query(query, [userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? Number(rows[0].total) : 0;
}

/**
 * Directly updates an account balance atomically without filtering by status restrictions
 */
async function mutateBalanceAtomically(accountId, amount) {
  const query = `
    UPDATE accounts 
    SET balance = balance + $1, 
        updated_at = CURRENT_TIMESTAMP 
    WHERE id = $2 
      AND deleted_at IS NULL 
    RETURNING *;
  `;
  const result = await db.query(query, [amount, accountId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? rows[0] : null; 
}

/**
 * Core restoration: Bypasses the NULL check to revert a soft-deleted account
 */
async function restoreAccount(accountId, userId) {
  const query = `
    UPDATE accounts 
    SET deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 
      AND user_id = $2 
      AND deleted_at IS NOT NULL
    RETURNING *;
  `;
  
  const result = await db.query(query, [parseInt(accountId, 10), userId]);
  const rows = result && result.rows ? result.rows : result;
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Context resetting: Clears the default flag from all active accounts for a specific user
 * @param {string} userId - The authenticated user's UUID
 */
async function clearDefaultFlag(userId) {
  const query = `
    UPDATE accounts
    SET is_default = FALSE,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1 
      AND is_default = TRUE
      AND deleted_at IS NULL;
  `;
  
  return await db.query(query, [userId]);
}

/**
 * Context lookup: Fetches the primary fallback record explicitly flagged as default
 * @param {string} userId - The unique UUID of the logged-in user
 */
async function findDefaultByUser(userId) {
  const query = `
    SELECT * FROM accounts
    WHERE user_id = $1
      AND is_default = TRUE
      AND deleted_at IS NULL
    LIMIT 1;
  `;
  
  const result = await db.query(query, [userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Partial update engine: Explicitly changes the default status flag on a specific account
 */
async function setDefaultAccount(accountId, userId) {
  const query = `
    UPDATE accounts
    SET is_default = TRUE,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
      AND user_id = $2
      AND deleted_at IS NULL
    RETURNING *;
  `;
  
  const result = await db.query(query, [parseInt(accountId, 10), userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Status management: Updates an account's systemic status flag (e.g., 'ACTIVE', 'ARCHIVED')
 */
async function updateStatus(accountId, userId, status) {
  const query = `
    UPDATE accounts
    SET status = $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
      AND user_id = $3
      AND deleted_at IS NULL
    RETURNING *;
  `;
  
  const cleanStatus = status.toUpperCase().trim();
  const result = await db.query(query, [cleanStatus, parseInt(accountId, 10), userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Bulk recovery engine: Recovers all soft-deleted records for a user profile at once
 */
async function restoreAllByUser(userId) {
  const query = `
    UPDATE accounts
    SET deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1
      AND deleted_at IS NOT NULL
    RETURNING *;
  `;
  
  const result = await db.query(query, [userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Audit lookup: Fetches an account regardless of its soft-deleted state
 */
async function findWithDeleted(accountId, userId) {
  const query = `
    SELECT * FROM accounts
    WHERE id = $1
      AND user_id = $2;
  `;
  
  const result = await db.query(query, [parseInt(accountId, 10), userId]);
  const rows = unpackRows(result);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}


module.exports = {
  createAccount,
  findAllByUser,
  findById,
  updateAccount,
  mutateBalance,
  getBalancesGroupedByCurrency,
  saveSnapshot,
  deleteAccount,
  verifyOwnership,
  getTotalAssets,
  getTotalLiabilities,
  mutateBalanceAtomically,
  restoreAccount,
  clearDefaultFlag,
  findDefaultByUser,    
  setDefaultAccount,   
  updateStatus,         
  restoreAllByUser,    
  findWithDeleted
};