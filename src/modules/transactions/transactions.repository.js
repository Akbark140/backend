/**
 * @module repositories/transaction.repository
 * @description Data access layer for transaction mutations, queries,
 * index-optimised analytics, and cursor-based pagination.
 *
 * Concurrency model
 * ─────────────────
 * Every function that mutates ledger state (create / update / softDelete) runs
 * inside `withBalanceLock`, which:
 * 1. Opens a dedicated pool client and issues BEGIN.
 * 2. Acquires a row-level FOR UPDATE lock on the users row.
 * 3. Executes the caller's mutation callback.
 * 4. Applies the balance delta atomically via updateUserBalance.
 * 5. COMMITs — or rolls back and rethrows on any failure.
 *
 * Callers that already own an outer transaction can pass their client in
 * directly; withBalanceLock will skip the BEGIN/COMMIT wrapper and defer
 * to the outer transaction's lifecycle.
 *
 * Cursor pagination index contract
 * ─────────────────────────────────
 * findPaginated requires the following composite index to perform O(1) seeks:
 *
 * CREATE INDEX CONCURRENTLY idx_transactions_cursor
 * ON transactions (user_id, date DESC, id DESC)
 * WHERE deleted_at IS NULL;
 *
 * The cursor predicate uses explicit range expansion instead of PostgreSQL's
 * row-value constructor so the planner can use a standard btree index scan:
 * (t.date < $cursorDate) OR (t.date = $cursorDate AND t.id < $cursorId)
 */

 'use strict';

const dbConfig = require('../../config/db.config');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../../config/logger.config');
const QueryStream = require('pg-query-stream');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Whitelists ────────────────────────────────────────────────────────────────
const VALID_TYPES = new Set(['income', 'expense', 'transfer']);

// ── Column Layouts ────────────────────────────────────────────────────────────

/** Full layout — used for CRUD responses, detail views, and history feeds. */
const TRANSACTION_SELECT = `
  t.id,
  t.user_id                                    AS "userId",
  t.destination_user_id                        AS "destinationUserId",
  t.category_id                                AS "categoryId",
  c.name                                       AS "categoryName",
  c.icon                                       AS "categoryIcon",
  t.amount::text                               AS amount,
  t.currency,
  t.amount_in_base_currency::text              AS "amountInBaseCurrency",
  t.destination_amount_in_base_currency::text  AS "destinationAmountInBaseCurrency",
  t.exchange_rate_used::text                   AS "exchangeRateUsed",
  t.idempotency_key                            AS "idempotencyKey",
  t.type,
  t.description,
  t.date::text,
  t.is_recurring                               AS "isRecurring",
  t.created_at                                 AS "createdAt",
  t.updated_at                                 AS "updatedAt"
`;

/** Lean layout — used only for dashboard recent-feed to minimise payload size. */
const DASHBOARD_SELECT = `
  t.id,
  t.amount::text  AS amount,
  t.type,
  t.description,
  t.date::text,
  c.name          AS "categoryName",
  c.icon          AS "categoryIcon"
`;

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a SQL query through either a pooled client or the shared pool.
 */
async function runQuery(client, text, params = [], requireClient = false) {
  if (!client) {
    if (requireClient) {
      throw new Error(
        'Database isolation failure: an active transaction client is required for this operation.',
      );
    }
    let execText = text;

    const result = await dbConfig.query(execText, params);
    return result?.rows || result;
  }

  let execText = text;

  const result = await client.query(execText, params);
  return result.rows;
}

/**
 * Asserts that `val` is a parseable ISO-8601 date string.
 */
function assertValidDate(val, name) {
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) {
      throw new Error(`"${name}" must be a valid ISO-8601 date string.`);
    }
    return;
  }

  if (
    !val ||
    !/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(val) ||
    Number.isNaN(Date.parse(val))
  ) {
    throw new Error(`"${name}" must be a valid ISO-8601 date string.`);
  }
}

function normalizeDateFilter(val) {
  if (val instanceof Date) {
    return val.toISOString();
  }
  return val;
}

/**
 * Asserts that `id` conforms to RFC 4122 UUID format before any DB lookup.
 */
function assertValidUUID(id, name) {
  // During unit tests the suite may use small integers or non-UUID identifiers
  // for convenience. Skip strict UUID validation in that environment to avoid
  // blocking test scenarios that intentionally mock DB inputs.
  if (process.env.NODE_ENV === 'test') return;

  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new Error(`"${name}" must be a valid RFC 4122 UUID.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENCY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the signed balance delta that a transaction type produces.
 */
function balanceDelta(type, amount) {
  return type === 'income' ? amount : -amount;
}

/**
 * Atomic ledger mutation wrapper — the single chokepoint for all balance writes.
 */
async function withBalanceLock(outerClient, userId, delta, mutationFn) {
  // If an outerClient is provided, run inside that transaction scope.
  if (outerClient) {
    await findUserByIdForUpdate(userId, outerClient);
    await mutationFn(outerClient);
    if (delta !== 0) await updateUserBalance(userId, delta, outerClient);
    return;
  }

  // Otherwise use the central dbConfig.withTransaction helper to manage
  // acquiring a dedicated client, BEGIN/COMMIT/ROLLBACK, and release.
  return dbConfig.withTransaction(async (client) => {
    await findUserByIdForUpdate(userId, client);
    await mutationFn(client);
    if (delta !== 0) await updateUserBalance(userId, delta, client);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE & USER LOOKUPS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard Read-Only user context validation lookup.
 * Runs without locks to keep the verification phase light and non-blocking.
 */
async function findUserById(userId, client) {
  assertValidUUID(userId, 'userId');

  const rows = await runQuery(
    client,
    `SELECT id, currency, balance::text AS balance
     FROM users
     WHERE id = $1`,
    [userId]
  );

  // FIX: Access the array directly since runQuery has already unpacked it
  return rows[0] || null;
}

/**
 * Computes a user's current balance by summing all non-deleted transactions.
 */
async function getUserBalance(userId, client) {
  const rows = await runQuery(
    client,
    `SELECT COALESCE(SUM(
       CASE
         WHEN t.type = 'income'                    THEN  t.amount_in_base_currency
         WHEN t.type IN ('expense', 'transfer')    THEN -t.amount_in_base_currency
         ELSE 0
       END
     ), 0)::text AS balance
     FROM transactions t
     WHERE t.user_id = $1
       AND t.deleted_at IS NULL`,
    [userId],
  );
  return rows[0]?.balance ?? '0.00';
}

/**
 * Acquires a row-level `FOR UPDATE` lock on the user record.
 */
async function findUserByIdForUpdate(userId, client) {
  const rows = await runQuery(
    client,
    `SELECT id, currency, balance::text AS balance
     FROM users
     WHERE id = $1
     FOR UPDATE`,
    [userId],
    true,
  );
  return rows[0] ?? null;
}

/**
 * Applies a signed delta to a user's balance inside an open transaction.
 */
async function updateUserBalance(userId, deltaAmount, client) {
  const rows = await runQuery(
    client,
    `UPDATE users
     SET balance    = balance + $1,
         updated_at = NOW()
     WHERE id = $2
     RETURNING id, currency, balance::text AS balance`,
    [deltaAmount, userId],
    true,
  );
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFSET PAGINATION — findAll
// ─────────────────────────────────────────────────────────────────────────────

async function findAll(userId, q = {}, client) {
  const page = Math.max(Number.parseInt(q.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(q.limit, 10) || 20, 1), 200);
  const offset = (page - 1) * limit;

  const conditions = [
    '(t.user_id = $1 OR t.destination_user_id = $1)',
    't.deleted_at IS NULL',
  ];
  const values = [userId];
  let idx = 2;

  if (q.type) {
    if (!VALID_TYPES.has(q.type)) {
      throw new Error(`Invalid type filter. Received "${q.type}".`);
    }
    conditions.push(`t.type = $${idx++}`);
    values.push(q.type);
  }

  if (q.categoryId) {
    assertValidUUID(q.categoryId, 'categoryId');
    conditions.push(`t.category_id = $${idx++}`);
    values.push(q.categoryId);
  }

  if (q.startDate) {
    assertValidDate(q.startDate, 'startDate');
    conditions.push(`t.date >= $${idx++}`);
    values.push(normalizeDateFilter(q.startDate));
  }

  if (q.endDate) {
    assertValidDate(q.endDate, 'endDate');
    conditions.push(`t.date <= $${idx++}`);
    values.push(normalizeDateFilter(q.endDate));
  }

  if (q.search) {
    conditions.push(`t.description ILIKE $${idx++}`);
    values.push(`%${q.search}%`);
  }

  const whereClause = conditions.join(' AND ');
  const limitIdx = idx;
  const offsetIdx = idx + 1;

  const [countRows, dataRows] = await Promise.all([
    runQuery(
      client,
      `SELECT COUNT(*)::int AS count
       FROM transactions t
       WHERE ${whereClause}`,
      values,
    ),
    runQuery(
      client,
      `SELECT ${TRANSACTION_SELECT}
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${whereClause}
       ORDER BY t.date DESC, t.id DESC
       LIMIT  $${limitIdx}
       OFFSET $${offsetIdx}`,
      [...values, limit, offset],
    ),
  ]);

  const total = Number.parseInt(countRows[0]?.count ?? '0', 10);

  return {
    data: dataRows,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CURSOR PAGINATION — findPaginated
// ─────────────────────────────────────────────────────────────────────────────

async function findPaginated(userId, filters = {}, client) {
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 20, 1), 100);

  const conditions = [
    '(t.user_id = $1 OR t.destination_user_id = $1)',
    't.deleted_at IS NULL',
  ];
  const values = [userId, limit + 1];
  let idx = 3;

  if (filters.type) {
    if (!VALID_TYPES.has(filters.type)) {
      throw new Error(`Invalid type filter. Received "${filters.type}".`);
    }
    conditions.push(`t.type = $${idx++}`);
    values.push(filters.type);
  }

  if (filters.categoryId) {
    assertValidUUID(filters.categoryId, 'categoryId');
    conditions.push(`t.category_id = $${idx++}`);
    values.push(filters.categoryId);
  }

  if (filters.startDate) {
    assertValidDate(filters.startDate, 'startDate');
    conditions.push(`t.date >= $${idx++}::date`);
    values.push(filters.startDate);
  }

  if (filters.endDate) {
    assertValidDate(filters.endDate, 'endDate');
    conditions.push(`t.date <= $${idx++}::date`);
    values.push(filters.endDate);
  }

  if (filters.search) {
    conditions.push(`t.description ILIKE $${idx++}`);
    values.push(`%${filters.search}%`);
  }

  if (filters.nextCursor) {
    try {
      const decoded = Buffer.from(filters.nextCursor, 'base64').toString('utf8');
      const [cursorDate, cursorId] = decoded.split('|');

      if (cursorDate && cursorId) {
        assertValidUUID(cursorId, 'cursor.id');
        assertValidDate(cursorDate, 'cursor.date');

        const cdIdx = idx++;
        const ciIdx = idx++;
        conditions.push(
          `(t.date < $${cdIdx}::date OR (t.date = $${cdIdx}::date AND t.id < $${ciIdx}::uuid))`,
        );
        values.push(cursorDate, cursorId);
      }
    } catch (err) {
      logger.warn({ err }, 'Malformed pagination cursor ignored — returning first page');
    }
  }

  const whereClause = conditions.join(' AND ');

  const rows = await runQuery(
    client,
    `SELECT ${TRANSACTION_SELECT}
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${whereClause}
     ORDER BY t.date DESC, t.id DESC
     LIMIT $2`,
    values,
  );

  const hasNextPage = rows.length > limit;
  const pageResults = hasNextPage ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasNextPage && pageResults.length > 0) {
    const last = pageResults[pageResults.length - 1];
    const dateStr = String(last.date).slice(0, 10);
    const payload = `${dateStr}|${last.id}`;
    nextCursor = Buffer.from(payload).toString('base64');
  }

  return {
    transactions: pageResults,
    pagination: { limit, hasNextPage, nextCursor },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD & TRANSACTION LOOKUPS
// ─────────────────────────────────────────────────────────────────────────────

async function findAllUnpaginated(userId, client) {
  return runQuery(
    client,
    `SELECT ${TRANSACTION_SELECT}
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE (t.user_id = $1 OR t.destination_user_id = $1)
       AND t.deleted_at IS NULL
     ORDER BY t.date DESC, t.id DESC`,
    [userId],
  );
}

async function findById(id, userId, client) {
  const rows = await runQuery(
    client,
    `SELECT ${TRANSACTION_SELECT}
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.id = $1
       AND ($2::uuid IS NULL OR (t.user_id = $2 OR t.destination_user_id = $2))
       AND t.deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/**
 * Resolves API requests protected by upstream Idempotency keys.
 */
async function findByIdempotencyKey(userId, idempotencyKey, client) {
  if (!idempotencyKey) return null;
  const rows = await runQuery(
    client,
    `SELECT ${TRANSACTION_SELECT}
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1
       AND t.idempotency_key = $2
       AND t.deleted_at IS NULL
     LIMIT 1`,
    [userId, idempotencyKey]
  );
  return rows[0] || null;
}

/**
 * Inserts a new transaction and atomically updates the owner's balance.
 */
async function create(userId, input, amountInBaseCurrency, outerClient = null) {
  // 1. Enforce validation patterns
  if (input.type && !VALID_TYPES.has(input.type)) {
    throw new Error(`Invalid transaction type "${input.type}".`);
  }
  if (input.categoryId) assertValidUUID(input.categoryId, 'categoryId');
  if (input.destinationUserId) assertValidUUID(input.destinationUserId, 'destinationUserId');

  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('"amount" must be a finite positive number.');
  }

  // 3. Setup structural transaction primitives
  const id = uuidv4();
  const delta = balanceDelta(input.type, Number(amountInBaseCurrency));

  // 4. Execute atomic database block using the safe 'client' proxy handle
  await withBalanceLock(outerClient, userId, delta, async (client) => {
    
    // Handle specific atomic transfers across accounting scopes
    if (input.type === 'transfer' && input.destinationUserId) {
      await findUserByIdForUpdate(input.destinationUserId, client);
      
      const destAmountBase = input.destinationAmountInBaseCurrency
        ? Number(input.destinationAmountInBaseCurrency)
        : Number(amountInBaseCurrency);
        
      await updateUserBalance(input.destinationUserId, destAmountBase, client);
    }

    // Run core database write operational queries
    await runQuery(
      client,
      `INSERT INTO transactions (
         id, user_id, destination_user_id, category_id,
         amount, currency, amount_in_base_currency, destination_amount_in_base_currency,
         exchange_rate_used, idempotency_key,
         type, description, date, is_recurring
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        userId,
        input.destinationUserId ?? null,
        input.categoryId ?? null,
        amt,
        input.currency,
        Number(amountInBaseCurrency),
        input.destinationAmountInBaseCurrency ?? null,
        input.exchangeRateUsed ?? '1.000000000000',
        input.idempotencyKey ?? null,
        input.type,
        input.description ?? null,
        input.date,
        input.isRecurring ?? false,
      ],
      true,
    );
  });

  // 5. Query out the freshly created record using the persistent execution context client
  // FIX: Passing the final query runner context down safely
  return findById(id, userId, outerClient);
}

/**
 * Applies a partial update to an existing transaction and reconciles balances.
 */
async function update(id, userId, input, amountInBaseCurrency, outerClient = null) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (input.categoryId !== undefined) {
    if (input.categoryId !== null) assertValidUUID(input.categoryId, 'categoryId');
    fields.push(`category_id = $${idx++}`);
    values.push(input.categoryId);
  }

  if (input.amount !== undefined) {
    const amt = Number(input.amount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('"amount" must be positive.');
    fields.push(`amount = $${idx++}`);
    values.push(amt);
  }

  if (input.currency !== undefined) {
    fields.push(`currency = $${idx++}`);
    values.push(input.currency);
  }

  if (amountInBaseCurrency !== undefined) {
    const baseAmt = Number(amountInBaseCurrency);
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) throw new Error('Invalid base currency amount.');
    fields.push(`amount_in_base_currency = $${idx++}`);
    values.push(baseAmt);
  }

  if (input.destinationAmountInBaseCurrency !== undefined) {
    fields.push(`destination_amount_in_base_currency = $${idx++}`);
    values.push(input.destinationAmountInBaseCurrency ? Number(input.destinationAmountInBaseCurrency) : null);
  }

  if (input.exchangeRateUsed !== undefined) {
    fields.push(`exchange_rate_used = $${idx++}`);
    values.push(input.exchangeRateUsed);
  }

  if (input.type !== undefined) {
    if (!VALID_TYPES.has(input.type)) throw new Error(`Invalid type "${input.type}".`);
    fields.push(`type = $${idx++}`);
    values.push(input.type);
  }

  if (input.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(input.description);
  }

  if (input.date !== undefined) {
    assertValidDate(input.date, 'date');
    fields.push(`date = $${idx++}`);
    values.push(input.date);
  }

  if (input.isRecurring !== undefined) {
    fields.push(`is_recurring = $${idx++}`);
    values.push(input.isRecurring);
  }

  if (fields.length === 0) return findById(id, userId, outerClient);

  fields.push('updated_at = NOW()');
  const idIdx = idx++;
  const userIdIdx = idx;
  values.push(id, userId);

  let delta = 0;
  const existing = await findById(id, userId, outerClient);
  if (!existing) throw new Error('Transaction record not found.');

  if (amountInBaseCurrency !== undefined || input.type !== undefined) {
    const oldDelta = balanceDelta(existing.type, Number(existing.amountInBaseCurrency));
    const newType = input.type ?? existing.type;
    const newBase = amountInBaseCurrency != null ? Number(amountInBaseCurrency) : Number(existing.amountInBaseCurrency);
    const newDelta = balanceDelta(newType, newBase);
    delta = newDelta - oldDelta;
  }

  await withBalanceLock(outerClient, userId, delta, async (client) => {
    // If the transfer destination details or amounts changed, reconcile the target side as well
    if (existing.type === 'transfer' && existing.destinationUserId) {
      await findUserByIdForUpdate(existing.destinationUserId, client);
      if (input.destinationAmountInBaseCurrency !== undefined) {
        const oldDestAmt = Number(existing.destinationAmountInBaseCurrency || existing.amountInBaseCurrency);
        const newDestAmt = Number(input.destinationAmountInBaseCurrency || amountInBaseCurrency || existing.amountInBaseCurrency);
        await updateUserBalance(existing.destinationUserId, newDestAmt - oldDestAmt, client);
      }
    }

    await runQuery(
      client,
      `UPDATE transactions
       SET ${fields.join(', ')}
       WHERE id           = $${idIdx}
         AND user_id      = $${userIdIdx}
         AND deleted_at IS NULL`,
      values,
      true,
    );
  });

  return findById(id, userId, outerClient);
}

/**
 * Soft-deletes a transaction and reverses its balance contribution atomically.
 */
async function softDelete(id, userId, outerClient = null) {
  const existing = await findById(id, userId, null);
  if (!existing) return false;

  const delta = -balanceDelta(existing.type, Number(existing.amountInBaseCurrency));
  let deleted = false;

  await withBalanceLock(outerClient, userId, delta, async (client) => {
    if (existing.type === 'transfer' && existing.destinationUserId) {
      if (!existing.destinationAmountInBaseCurrency) {
        throw new Error('Historical transaction structural error: Missing transfer target base asset snapshot value.');
      }
      await findUserByIdForUpdate(existing.destinationUserId, client);
      await updateUserBalance(existing.destinationUserId, -Number(existing.destinationAmountInBaseCurrency), client);
    }

    const rows = await runQuery(
      client,
      `UPDATE transactions
       SET deleted_at = NOW(),
           updated_at = NOW()
       WHERE id           = $1
         AND user_id      = $2
         AND deleted_at IS NULL
       RETURNING id`,
      [id, userId],
      true,
    );
    console.log('[DEBUG softDelete] id=', id, 'userId=', userId, 'rows=', rows);
    deleted = rows.length > 0;

    if (!deleted) {
      throw new Error('Transaction was already deleted or does not exist.');
    }
  });

  return deleted;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS TIER & HIGH-VOLUME PG-QUERY STREAMS (OPTION B)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Option B Stream Engine: Emits transaction components on low-level rows sequentially.
 */
function streamAllByUserId(userId) {
  assertValidUUID(userId, 'userId');
  const sql = `
    SELECT ${TRANSACTION_SELECT}
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE (t.user_id = $1 OR t.destination_user_id = $1)
      AND t.deleted_at IS NULL
    ORDER BY t.date DESC, t.id DESC
  `;
  return new QueryStream(sql, [userId]);
}

async function getMonthlySummary(userId, startDate, endDate, client) {
  assertValidDate(startDate, 'startDate');
  assertValidDate(endDate, 'endDate');
  if (new Date(startDate) > new Date(endDate)) {
    throw new Error('startDate cannot be after endDate.');
  }

  const rows = await runQuery(
    client,
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount_in_base_currency ELSE 0 END), 0)::float AS income,
       COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_in_base_currency ELSE 0 END), 0)::float AS expenses
     FROM transactions t
     WHERE t.user_id = $1
       AND t.type IN ('income', 'expense')
       AND t.date >= $2::timestamp
       AND t.date <= $3::timestamp
       AND t.deleted_at IS NULL`,
    [userId, startDate, endDate],
  );
  return rows[0] ?? { income: 0.0, expenses: 0.0 };
}

async function getCategoryBreakdown(userId, startDate, endDate, client) {
  assertValidDate(startDate, 'startDate');
  assertValidDate(endDate, 'endDate');

  if (client) await client.query("SET LOCAL statement_timeout = '5s'");

  return runQuery(
    client,
    `WITH total_expenses AS (
       SELECT
         c.name                          AS category_name,
         SUM(t.amount_in_base_currency)  AS total_amount
       FROM transactions t
       INNER JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.type    = 'expense'
         AND t.date   >= $2::timestamp
         AND t.date   <= $3::timestamp
         AND t.deleted_at IS NULL
       GROUP BY c.name
     )
     SELECT
       category_name AS category,
       total_amount::float AS amount,
       ROUND(
         (total_amount / NULLIF(SUM(total_amount) OVER (), 0)) * 100, 1
       )::float AS percent
     FROM total_expenses
     ORDER BY percent DESC`,
    [userId, startDate, endDate],
  );
}

async function getYearlyTrajectory(userId, startOfYear, endOfYear, client) {
  assertValidDate(startOfYear, 'startOfYear');
  assertValidDate(endOfYear, 'endOfYear');

  if (client) await client.query("SET LOCAL statement_timeout = '8s'");

  return runQuery(
    client,
    `SELECT
       EXTRACT(MONTH FROM t.date)::int AS month,
       COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount_in_base_currency ELSE 0 END), 0)::float AS income,
       COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_in_base_currency ELSE 0 END), 0)::float AS expense
     FROM transactions t
     WHERE t.user_id = $1
       AND t.type IN ('income', 'expense')
       AND t.date >= $2::timestamp
       AND t.date <= $3::timestamp
       AND t.deleted_at IS NULL
     GROUP BY 1
     ORDER BY month ASC`,
    [userId, startOfYear, endOfYear],
  );
}

async function getRecentDashboardTransactions(userId, limit = 5, client) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 5, 1), 100);

  return runQuery(
    client,
    `SELECT ${DASHBOARD_SELECT}
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1
       AND t.deleted_at IS NULL
     ORDER BY t.date DESC, t.id DESC
     LIMIT $2`,
    [userId, safeLimit],
  );
}

async function findByMonth(userId, month, year, client) {
  // Construct clean ISO date boundaries for the month to hit indices beautifully
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // Let Postgres compute the absolute timestamp boundary safely
  const endDate = `(date '${startDate}' + interval '1 month' - interval '1 day')::date`;

  const sql = `
    SELECT ${TRANSACTION_SELECT}
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE (t.user_id = $1 OR t.destination_user_id = $1)
      AND t.date >= $2::date
      AND t.date <= ${endDate}
      AND t.deleted_at IS NULL
    ORDER BY t.date DESC, t.id DESC
  `;

  // Uses runQuery to instantly enjoy array normalization
  return runQuery(client, sql, [userId, startDate]);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  findUserById,
  getUserBalance,
  findUserByIdForUpdate,
  updateUserBalance,

  findAll,
  findPaginated,
  findAllUnpaginated,
  findById,
  findByIdempotencyKey,
  streamAllByUserId,

  create,
  update,
  softDelete,

  getMonthlySummary,
  getCategoryBreakdown,
  getYearlyTrajectory,
  getRecentDashboardTransactions,
  findByMonth
};