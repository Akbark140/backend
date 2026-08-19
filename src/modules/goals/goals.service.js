// src/services/goals.service.js
'use strict';

const goalsRepository = require('./goals.repository');
const { redis } = require('../../config/redis.config');
const { logger } = require('../../config/logger.config');

// ── Cache Configuration ───────────────────────────────────────────────────────
const CACHE_TTL = 600;                              // 10-minute window
const cacheKey = (userId) => `cache:goals:${userId}`;
const goalCacheKey = (goalId, userId) => `cache:goal:${userId}:${goalId}`;

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY — Safe Error Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a typed HTTP error with a status code attached,
 * avoiding repetitive inline boilerplate across every method.
 */
function createError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY — Goal Metrics Calculator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes runtime tracking fields that are never persisted to the DB:
 *   - progress             (0–100, or above if overflow is enabled)
 *   - daysLeft             (null if no deadline)
 *   - requiredDailySavings (null if no deadline)
 *   - derivedStatus        (OVERDUE upgrade when deadline passed and still ACTIVE)
 *
 * Accepts both camelCase and snake_case shapes so it works against raw DB rows
 * and already-transformed objects alike.
 */
function calculateGoalMetrics(goal) {
  const currentAmount = Number(goal.currentAmount ?? goal.current_amount ?? 0);
  const targetAmount = Number(goal.targetAmount ?? goal.target_amount ?? 0);
  const allowOverflow = !!(goal.allowOverflow ?? goal.allow_overflow);
  const deadline = goal.deadline ?? goal.targetDate;

  // ── 1. Progress ────────────────────────────────────────────────────────────
  let progress = 0;
  if (targetAmount > 0) {
    progress = (currentAmount / targetAmount) * 100;
    if (!allowOverflow && progress > 100) progress = 100;
    progress = Math.max(0, parseFloat(progress.toFixed(2)));
  }

  // ── 2. Time-Based Metrics ──────────────────────────────────────────────────
  let daysLeft = null;
  let requiredDailySavings = null;
  let isOverdue = false;

  if (deadline) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(deadline);
    targetDate.setHours(0, 0, 0, 0);

    daysLeft = Math.ceil((targetDate - today) / 86_400_000);

    if (daysLeft < 0 && goal.status !== 'COMPLETED') {
      isOverdue = true;
      daysLeft = 0;             // never expose negative days to clients
    }

    const remaining = targetAmount - currentAmount;
    if (remaining <= 0) {
      requiredDailySavings = 0;
    } else if (daysLeft > 0) {
      requiredDailySavings = parseFloat((remaining / daysLeft).toFixed(2));
    } else {
      requiredDailySavings = remaining; // full remainder due immediately
    }
  }

  // ── 3. Derived Status (non-persisted upgrade) ──────────────────────────────
  const derivedStatus =
    goal.status === 'ACTIVE' && isOverdue ? 'OVERDUE' : (goal.status ?? 'ACTIVE');

  return { progress, daysLeft, requiredDailySavings, derivedStatus };
}

/**
 * Merges persisted goal data with its calculated runtime metrics.
 * Keeps derivedStatus as the effective `status` only for ACTIVE goals
 * so PAUSED / COMPLETED / ARCHIVED statuses are never silently overwritten.
 */
function enrichGoal(goal) {
  const metrics = calculateGoalMetrics(goal);
  return {
    ...goal,
    progress: metrics.progress,
    daysLeft: metrics.daysLeft,
    requiredDailySavings: metrics.requiredDailySavings,
    status: goal.status === 'ACTIVE' ? metrics.derivedStatus : goal.status,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED STATUSES (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_STATUSES = new Set(['ACTIVE', 'COMPLETED', 'PAUSED', 'FAILED', 'ARCHIVED']);

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CLASS
// ─────────────────────────────────────────────────────────────────────────────

class GoalsService {

  // ── LIST ───────────────────────────────────────────────────────────────────

  /**
   * Returns all goals for a user, enriched with runtime metrics.
   * Results are cached in Redis for CACHE_TTL seconds.
   */
  async list(userId) {
    const key = cacheKey(userId);

    // ── Cache read ────────────────────────────────────────────────────────────
    try {
      const cached = await redis.get(key);
      if (cached) {
        logger.debug({ userId }, 'Goals cache hit');
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.error({ err }, 'Redis cache read error — listUserGoals');
      // Non-fatal: fall through to DB
    }

    const goals = await goalsRepository.findAllByUser(userId);
    const enrichedGoals = goals.map(enrichGoal);

    const response = {
      data: enrichedGoals,
      meta: { total: enrichedGoals.length },
    };

    // ── Cache write ───────────────────────────────────────────────────────────
    try {
      await redis.set(key, JSON.stringify(response), 'EX', CACHE_TTL);
    } catch (err) {
      logger.error({ err }, 'Redis cache write error — listUserGoals');
    }

    return response;
  }

  // ── GET BY ID ──────────────────────────────────────────────────────────────

  /**
   * Fetches a single goal with ownership check and metric enrichment.
   * Per-goal cache avoids repeated DB hits for frequently polled goals.
   */
  async getGoalById(goalId, userId) {
    const key = goalCacheKey(goalId, userId);

    try {
      const cached = await redis.get(key);
      if (cached) {
        logger.debug({ userId, goalId }, 'Single-goal cache hit');
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.error({ err }, 'Redis cache read error — getGoalById');
    }

    const goal = await goalsRepository.findById(goalId, userId);
    if (!goal) throw createError('Goal not found', 404);

    const enriched = enrichGoal(goal);

    try {
      await redis.set(key, JSON.stringify(enriched), 'EX', CACHE_TTL);
    } catch (err) {
      logger.error({ err }, 'Redis cache write error — getGoalById');
    }

    return enriched;
  }

  // ── CREATE ─────────────────────────────────────────────────────────────────

  /**
   * Validates, normalises, and persists a new goal.
   * Automatically marks the goal COMPLETED when the initial deposit already
   * meets or exceeds the target.
   */
  async createGoal(userId, body) {
    // ── Input validation ──────────────────────────────────────────────────────
    if (!userId) throw createError('userId is required', 400);
    if (!body.name) throw createError('name is required', 400);

    if (body.targetAmount === undefined || body.targetAmount === null) {
      throw createError('targetAmount is required', 400);
    }

    const targetAmount = Math.floor(Number(body.targetAmount));
    if (isNaN(targetAmount) || targetAmount <= 0) {
      throw createError('targetAmount must be a positive number', 400);
    }

    if (!body.currency) throw createError('currency is required', 400);

    const currentAmount = body.currentAmount ? Math.floor(Number(body.currentAmount)) : 0;

    const payload = {
      userId,
      name: body.name.trim(),
      icon: body.icon ?? null,
      target_amount: targetAmount,
      current_amount: currentAmount,
      currency: body.currency,
      allow_overflow: !!body.allowOverflow,
      deadline: body.deadline ? new Date(body.deadline) : null,
      // Auto-complete when initial deposit already satisfies the target
      status: currentAmount >= targetAmount ? 'COMPLETED' : 'ACTIVE',
    };

    const goal = await goalsRepository.create(payload);
    await this._invalidateUserCache(userId);

    return enrichGoal(goal);
  }

  // ── CONTRIBUTE ─────────────────────────────────────────────────────────────

  /**
   * Applies a monetary contribution to a goal.
   *
   * Business rules enforced:
   *   1. Amount must be a positive number.
   *   2. Goal must exist and belong to the requesting user.
   *   3. Lifecycle gate: COMPLETED / PAUSED / FAILED goals reject contributions.
   *   4. Overflow logic: caps actual contribution at remaining balance when
   *      allow_overflow is false.
   *   5. Automatically transitions goal to COMPLETED when target is reached.
   *   6. Writes an immutable audit record to goal_contributions.
   *
   * FIX #8: Parameter order corrected to (goalId, userId, contributionPayload)
   * to match the controller call-site and repository conventions.
   */
async contribute(goalId, userId, contributionPayload) {
    const { source = 'manual', note = null } = contributionPayload ?? {};
    
    // Parse input securely keeping fractional currency units intact
    const amount = Number(contributionPayload?.amount);

    if (isNaN(amount) || amount <= 0) {
      throw createError('Contribution amount must be a positive number', 400);
    }

    const goal = await goalsRepository.findById(goalId, userId);
    if (!goal) throw createError('Goal not found or unauthorized', 404);

    // ── Extract numeric balances securely ─────────────────────────────────────
    const currentAmount = Number(goal.currentAmount ?? goal.current_amount ?? 0);
    const targetAmount  = Number(goal.targetAmount  ?? goal.target_amount  ?? 0);
    const allowOverflow = !!(goal.allowOverflow      ?? goal.allow_overflow);

    // ── Lifecycle gates ───────────────────────────────────────────────────────
    const currentStatus = (goal.status ?? goal.computed_status ?? '').toUpperCase();

    // Only block if it's marked COMPLETED *AND* the money target is fully met
    if (currentStatus === 'COMPLETED' && currentAmount >= targetAmount) {
      throw createError(
        'Completed goals cannot accept contributions unless explicitly reopened',
        400,
      );
    }
    
    if (currentStatus === 'PAUSED' || currentStatus === 'FAILED') {
      throw createError(
        `Cannot contribute to a goal that is currently ${currentStatus}`,
        400,
      );
    }

    // ── Strict Overflow / Target Cap Logic ────────────────────────────────────
    const potentialNewAmount = currentAmount + amount;

    // If the contribution exceeds the target amount and overflow is not allowed, throw an error
    if (potentialNewAmount > targetAmount && !allowOverflow) {
      const maxAllowedContribution = targetAmount - currentAmount;
      
      if (maxAllowedContribution <= 0) {
        throw createError('Goal is already fully funded and overflow is disabled', 400);
      } else {
        throw createError(
          `Contribution exceeds target amount. Maximum allowed contribution remaining is ${goal.currency ?? 'Rs.'} ${maxAllowedContribution.toLocaleString()}`,
          400,
        );
      }
    }

    // ── Calculate final numbers ───────────────────────────────────────────────
    const newAmount = potentialNewAmount;
    const actualContribution = amount;

    // ── Determine final status ────────────────────────────────────────────────
    const finalStatus = newAmount >= targetAmount ? 'COMPLETED' : 'ACTIVE';

    // ── Persist updates ───────────────────────────────────────────────────────
    const updatedGoal = await goalsRepository.update(goalId, userId, {
      current_amount: newAmount,
      status:         finalStatus,
    });

    // Immutable audit trail
    await goalsRepository.contribute({
      goalId,
      userId,
      amount: actualContribution,
      source,
      note,
      date: new Date(),
    });

    await this._invalidateUserCache(userId);
    await this._invalidateSingleCache(goalId, userId);

    const justCompleted = finalStatus === 'COMPLETED' && currentStatus !== 'COMPLETED';

    if (justCompleted) {
      logger.info({ userId, goalId }, 'Goal milestone target reached');
      // TODO (Week 6): dispatch COMPLETED event to BullMQ notification queue
    }

    return {
      ...enrichGoal(updatedGoal),
      justCompleted,
      actualContribution,
      message: `Successfully contributed ${updatedGoal.currency ?? 'Rs.'} ${actualContribution.toLocaleString()} toward your goal.`,
    };
  }
  
  // ── UPDATE ─────────────────────────────────────────────────────────────────

  /**
   * Applies partial updates to a goal with full constraint enforcement.
   *
   * Rules:
   *   - Completed goals are read-only unless the update explicitly changes status.
   *   - target_amount cannot go below current progress.
   *   - Updating target_amount to exactly what's already saved auto-completes the goal.
   *   - Status must be a member of ALLOWED_STATUSES.
   */
  async patchGoal(goalId, userId, body) {
    const existingGoal = await goalsRepository.findById(goalId, userId);
    if (!existingGoal) throw createError('Goal not found', 404);

    // Block edits on completed goals unless status itself is being changed
    if (existingGoal.status === 'COMPLETED' && body.status === undefined) {
      throw createError(
        'Cannot modify a completed goal unless updating status to reopen it',
        400,
      );
    }

    const currentAmount = Number(
      existingGoal.currentAmount ?? existingGoal.current_amount ?? 0,
    );
    const updatePayload = {};

    // ── target_amount ─────────────────────────────────────────────────────────
    if (body.targetAmount !== undefined) {
      const numericTarget = Math.floor(Number(body.targetAmount));
      if (isNaN(numericTarget) || numericTarget <= 0) {
        throw createError('targetAmount must be a positive number', 400);
      }
      if (numericTarget < currentAmount) {
        throw createError(
          `targetAmount cannot be set below current progress of ${currentAmount}`,
          400,
        );
      }
      updatePayload.target_amount = numericTarget;
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (body.status !== undefined) {
      if (!ALLOWED_STATUSES.has(body.status)) {
        throw createError(`Invalid status: must be one of ${[...ALLOWED_STATUSES].join(', ')}`, 400);
      }
      updatePayload.status = body.status;
    }

    // ── scalar fields ─────────────────────────────────────────────────────────
    if (body.name !== undefined) updatePayload.name = body.name.trim();
    if (body.icon !== undefined) updatePayload.icon = body.icon;
    if (body.deadline !== undefined) updatePayload.deadline = body.deadline ? new Date(body.deadline) : null;
    if (body.allowOverflow !== undefined) updatePayload.allow_overflow = !!body.allowOverflow;

    const updated = await goalsRepository.update(goalId, userId, updatePayload);

    await this._invalidateUserCache(userId);
    await this._invalidateSingleCache(goalId, userId);

    // Auto-complete if the new target_amount is now met by existing savings
    const metrics = calculateGoalMetrics(updated);
    if (updated.status === 'ACTIVE' && metrics.progress >= 100) {
      const autoCompleted = await goalsRepository.update(goalId, userId, {
        status: 'COMPLETED',
      });
      await this._invalidateSingleCache(goalId, userId);
      return enrichGoal(autoCompleted);
    }

    return enrichGoal(updated);
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────

  /**
   * Hard-deletes a goal after verifying ownership.
   * Invalidates both the per-goal and the user-level list cache.
   */
  async deleteGoal(goalId, userId) {
    const existingGoal = await goalsRepository.findById(goalId, userId);
    if (!existingGoal) throw createError('Goal not found', 404);

    const deleted = await goalsRepository.remove(goalId, userId);
    if (!deleted) throw createError('Goal could not be deleted', 500);

    await this._invalidateUserCache(userId);
    await this._invalidateSingleCache(goalId, userId);

    return {
      success: true,
      message: 'Goal deleted successfully',
    };
  }

  // ── CACHE HELPERS (private) ────────────────────────────────────────────────

  async _invalidateUserCache(userId) {
    try {
      await redis.del(cacheKey(userId));
    } catch (err) {
      logger.error({ err, userId }, 'Redis cache invalidation error — user list');
    }
  }

  async _invalidateSingleCache(goalId, userId) {
    try {
      await redis.del(goalCacheKey(goalId, userId));
    } catch (err) {
      logger.error({ err, goalId, userId }, 'Redis cache invalidation error — single goal');
    }
  }
}

module.exports = new GoalsService();