// goals.repository.js

const { query, withTransaction } = require('../../config/db.config');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AUXILIARY HELPERS / STATUS FRAGMENT
 * Used to compute dynamic status (ACTIVE, COMPLETED, OVERDUE) based on target,
 * current amounts, and the deadline timestamp.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const STATUS_EXPRESSION = `
  CASE 
    WHEN status = 'COMPLETED' OR current_amount >= target_amount THEN 'COMPLETED'
    WHEN deadline IS NOT NULL AND deadline < NOW() THEN 'OVERDUE'
    ELSE 'ACTIVE'
  END AS computed_status
`;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET ALL GOALS (USER SCOPED)
 * Includes dynamic progress calculations, currency defaults, and live statuses.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function findAllByUser(userId) {
  const { rows } = await query(
    `SELECT
        id,
        user_id,
        name,
        icon,
        target_amount,
        current_amount,
        currency,
        allow_overflow,
        deadline,
        status,
        ${STATUS_EXPRESSION},
        ROUND(
          CASE 
            WHEN target_amount IS NULL OR target_amount = 0 THEN 0
            ELSE (current_amount::numeric / target_amount) * 100
          END,
          2
        ) AS progress_percentage,
        CASE 
          WHEN deadline IS NOT NULL AND deadline > NOW() AND current_amount < target_amount THEN
            GREATEST(CEIL(EXTRACT(EPOCH FROM (deadline - NOW())) / 86400), 1)
          ELSE 0
        END AS days_remaining,
        created_at,
        updated_at
     FROM goals
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return rows;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET GOAL BY ID (SECURE)
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function findById(id, userId) {
  const sql = `
    SELECT
      id,
      user_id,
      name,
      target_amount,
      current_amount,
      currency,
      status,
      allow_overflow,
      deadline,
      created_at,
      updated_at
    FROM goals
    WHERE id = $1
      AND user_id = $2;
  `;

  const result = await query(sql, [id, userId]);

  return result.rows[0] || null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CREATE GOAL
 * Enforces schema validation baselines like target_amount > 0.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function create({
  userId,
  name,
  icon = '🎯',
  target_amount,
  current_amount = 0,
  currency = 'USD',
  allow_overflow = false,
  deadline = null
}) {
  // Defensive validation in the repository layer
  if (!name || !userId || target_amount <= 0) {
    throw new Error("Invalid payload: Name, User ID, and a positive Target Amount are required.");
  }

  const { rows } = await query(
    `INSERT INTO goals (
        user_id,
        name,
        icon,
        target_amount,
        current_amount,
        currency,
        allow_overflow,
        deadline,
        status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *, ${STATUS_EXPRESSION}`,
    [
      userId, 
      name, 
      icon, 
      target_amount, 
      current_amount, 
      currency, 
      allow_overflow, 
      deadline, 
      current_amount >= target_amount ? 'COMPLETED' : 'ACTIVE'
    ]
  );

  return rows[0];
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REPOSITORY LAYER: PROCESS GOAL CONTRIBUTION (LEDGER TRANSACTION)
 * ─────────────────────────────────────────────────────────────────────────────
 * Handled inside an atomic database transaction using FOR UPDATE
 * locking to prevent financial race conditions in concurrent requests.
 */
async function contribute({ goalId, userId, amount, source = 'manual', note = null }) {
  // Defensive validation rule
  if (!amount || Number(amount) <= 0) {
    throw new Error('Contribution amount must be greater than 0');
  }

  return withTransaction(async (tx) => {
    // 1. Fetch current goal state with an exclusive lock
    const goalRes = await tx.query(
      `SELECT
          id,
          current_amount,
          target_amount,
          allow_overflow,
          status
       FROM goals
       WHERE id = $1
         AND user_id = $2
       FOR UPDATE`,
      [goalId, userId]
    );

    const goal = goalRes.rows[0];

    if (!goal) {
      throw new Error('Goal not found or access denied.');
    }

    // Guardrail: Completed goals should not accept contributions
    if (goal.status === 'COMPLETED') {
      throw new Error(
        'Cannot contribute to a completed goal unless explicitly reopened.'
      );
    }

    // 2. Calculate new balance
    let newAmount =
      Number(goal.current_amount || 0) +
      Number(amount);

    const target = Number(goal.target_amount || 0);

    // Clamp amount if overflow is disabled
    if (newAmount > target && !goal.allow_overflow) {
      newAmount = target;
    }

    // 3. Determine next status
    const nextStatus =
      newAmount >= target
        ? 'COMPLETED'
        : goal.status;

    // 4. Update goal
    const updatedGoalRes = await tx.query(
      `UPDATE goals
       SET
         current_amount = $1,
         status = $2,
         updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [newAmount, nextStatus, goalId]
    );

    // 5. Record contribution event
    // NOTE: user_id is intentionally omitted — the column does not exist on
    // goal_contributions yet. Once the ALTER TABLE migration has been applied,
    // add user_id back to both the column list and the values array.
    await tx.query(
      `INSERT INTO goal_contributions (
          goal_id,
          amount,
          source,
          note,
          created_at
       )
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        goalId,
        Number(amount),
        source,
        note
      ]
    );

    // withTransaction() automatically commits here
    return updatedGoalRes.rows[0];
  });
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE GOAL (PARTIAL UPDATE WITH CONSTRAINTS)
 * Prevents dropping the target below the current accumulated balance.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function update(goalId, userId, fields) {
  // FIX #9: `status` was never destructured from `fields`, so explicit status
  // changes passed from the service (PAUSED, ARCHIVED, FAILED, ACTIVE, COMPLETED)
  // were silently ignored. Added `status` to the destructure and the UPDATE query.
  const {
    name,
    icon,
    target_amount,
    deadline,
    allowOverflow,
    status,
    current_amount,
  } = fields;

  return withTransaction(async (tx) => {
    // Lock current goal row
    const goalRes = await tx.query(
      `SELECT
          current_amount,
          status
       FROM goals
       WHERE id = $1
         AND user_id = $2
       FOR UPDATE`,
      [goalId, userId]
    );

    const currentGoal = goalRes.rows[0];

    if (!currentGoal) {
      throw new Error('Goal not found or access denied.');
    }

    // Prevent target from dropping below current progress
    if (
      target_amount !== undefined &&
      Number(target_amount) < Number(currentGoal.current_amount)
    ) {
      throw new Error(
        'Cannot update target amount to be lower than the current accumulated progress.'
      );
    }

    const result = await tx.query(
      `UPDATE goals
       SET
         name           = COALESCE($1, name),
         icon           = COALESCE($2, icon),
         target_amount  = COALESCE($3, target_amount),
         deadline       = COALESCE($4, deadline),
         allow_overflow = COALESCE($5::BOOLEAN, allow_overflow),
         current_amount = COALESCE($6::NUMERIC, current_amount),

         status = CASE
           WHEN $7::TEXT IS NOT NULL THEN $7::TEXT
           WHEN COALESCE($3, target_amount) <= current_amount THEN 'COMPLETED'
           ELSE status
         END,

         updated_at = NOW()
       WHERE id = $8
         AND user_id = $9
       RETURNING *,
         ${STATUS_EXPRESSION}`,
      [
        name          ?? null,
        icon          ?? null,
        target_amount ?? null,
        deadline      ?? null,
        allowOverflow ?? null,
        current_amount ?? null,
        status        ?? null,
        goalId,
        userId
      ]
    );

    return result.rows[0] || null;
  });
} 

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DELETE GOAL
 * Cascades or securely detaches contributions automatically if FK is setup.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function remove(goalId, userId) {
  const result = await query(
    `DELETE FROM goals
     WHERE id = $1
       AND user_id = $2`,
    [goalId, userId]
  );

  return result.rowCount > 0;
}

module.exports = {
  findAllByUser,
  findById,
  create,
  contribute,
  update,
  remove
};