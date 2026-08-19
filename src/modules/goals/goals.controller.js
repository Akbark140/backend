// goals.controller.js

const service = require('./goals.service');
const { sendSuccess } = require('../../shared/ApiResponse');

/**
 * ─────────────────────────────────────────────
 * SAFE PROGRESS & TIME-BASED CALCULATION
 * ─────────────────────────────────────────────
 * NOTE:
 * Core business rules (status changes, completion logic) 
 * are strictly enforced in the SERVICE/DB layer.
 * This function derives UI-centric presentation fields dynamically.
 */
function calculateProgress(goal) {
  if (!goal) return null;

  const current = Number(goal.current_amount || 0);
  const target = Number(goal.target_amount || 0);
  const allowOverflow = !!goal.allow_overflow;

  // 3. Progress Calculation Logic (Avoid divide-by-zero)
  let completionPercentage = target > 0 
    ? Number(((current / target) * 100).toFixed(2)) 
    : 0;

  // Clamp between 0 - 100% unless overflow is enabled
  if (!allowOverflow && completionPercentage > 100) {
    completionPercentage = 100;
  }

  // 4. Time-Based Smart Logic
  let daysLeft = null;
  let requiredDailySavings = 0;

  if (goal.target_date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(goal.target_date);
    targetDate.setHours(0, 0, 0, 0);

    const timeDiff = targetDate.getTime() - today.getTime();
    daysLeft = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

    // If goal isn't completed and has time remaining, calculate run-rate
    if (daysLeft > 0 && current < target) {
      const remainingAmount = target - current;
      requiredDailySavings = Number((remainingAmount / daysLeft).toFixed(2));
    }
  }

  return {
    ...goal,
    completionPercentage,
    daysLeft: daysLeft !== null ? Math.max(0, daysLeft) : null,
    requiredDailySavings,
    isCompleted: goal.status === 'COMPLETED' || (current >= target && target > 0),
    isOverdue: goal.status === 'OVERDUE' || (daysLeft < 0 && current < target)
  };
}

/**
 * ─────────────────────────────────────────────
 * GET /api/goals
 * Get all goals for logged-in user
 * ─────────────────────────────────────────────
 */
async function list(req, res, next) {
  try {
    // Access Control: strictly tied to req.user.id
    const result = await service.list(req.user.id);

    const processedGoals = (result.data || []).map(calculateProgress);

    // FIXED: Combine data and metadata into one wrapper object in the 2nd argument
    return sendSuccess(
      res, 
      {
        items: processedGoals,
        total: result.meta?.total || processedGoals.length,
      }, 
      200
    );
  } catch (err) {
    next(err);
  }
}

/**
 * ─────────────────────────────────────────────
 * GET /api/goals/:id
 * Get single goal
 * ─────────────────────────────────────────────
 */
async function getById(req, res, next) {
  try {
    // FIX #3: Was service.getById(...) — correct method name is getGoalById
    const goal = await service.getGoalById(
      req.params.id,
      req.user.id
    );

    return sendSuccess(res, calculateProgress(goal));
  } catch (err) {
    next(err);
  }
}

/**
 * ─────────────────────────────────────────────
 * POST /api/goals
 * Create a new goal
 * ─────────────────────────────────────────────
 */
async function create(req, res, next) {
  try {
    // FIX #1: Destructure both snake_case and camelCase variants so neither
    // causes a ReferenceError when the other is absent.
    const { name, icon, target_amount, targetAmount, currency, allowOverflow, deadline } = req.body;

    // Consolidate the variable cleanly
    const finalTarget = target_amount || targetAmount;

    // Validation Guardrail
    if (!finalTarget || Number(finalTarget) <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Target amount must be greater than 0.' 
      });
    }

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Goal name is required.' });
    }

    // FIX #6: Was service.create(...) — correct method name is createGoal
    const newGoal = await service.createGoal(req.user.id, {
      name,
      icon: icon || '🎯',
      targetAmount: Number(finalTarget),
      currency: currency || 'USD',
      allowOverflow: !!allowOverflow,
      deadline: deadline || null
    });

    return res.status(201).json({
      success: true,
      data: newGoal
    });
  } catch (err) {
    next(err);
  }
}

/**
 * ─────────────────────────────────────────────
 * POST /api/goals/:id/contribute
 * Add money to goal
 * ─────────────────────────────────────────────
 */
async function contribute(req, res, next) {
  try {
    const { amount } = req.body;

    // Fast-fail check at controller level
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Contribution amount must be greater than zero.' });
    }

    // FIX #7: Was contribute(req.params.id, req.user.id, Number(amount)) — service
    // signature is contribute(goalId, userId, contributionPayload) and expects an
    // object payload, not a raw number.
    const updatedGoal = await service.contribute(
      req.params.id,
      req.user.id,
      { amount: Number(amount) }
    );

    const goalWithProgress = calculateProgress(updatedGoal);

    return sendSuccess(res, {
      ...goalWithProgress,
      // FIX #2: Was updatedGoal.status === false (always false); correct check
      // is whether the goal just transitioned into COMPLETED this request.
      justCompleted:
        goalWithProgress.isCompleted &&
        updatedGoal.justCompleted === true,
      message: `Successfully contributed Rs. ${Number(amount).toLocaleString()} toward your goal.`,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * ─────────────────────────────────────────────
 * PATCH /api/goals/:id
 * Update goal details safely
 * ─────────────────────────────────────────────
 */
async function update(req, res, next) {
  try {
    const { name, target_amount, target_date, status, allow_overflow } = req.body;
    
    // Whitelist acceptable payload parameters to block cross-user or malicious
    // updates (e.g. changing current_amount manually)
    const updatePayload = {};
    if (name !== undefined) updatePayload.name = name;
    if (target_amount !== undefined) updatePayload.targetAmount = Number(target_amount);
    if (target_date !== undefined) updatePayload.deadline = target_date;
    if (status !== undefined) updatePayload.status = status; // Reopen / Archive / Pause
    if (allow_overflow !== undefined) updatePayload.allowOverflow = allow_overflow;

    // FIX #4: Was service.update(...) — correct method name is patchGoal
    const updatedGoal = await service.patchGoal(
      req.params.id,
      req.user.id,
      updatePayload
    );

    return sendSuccess(res, calculateProgress(updatedGoal));
  } catch (err) {
    next(err);
  }
}

/**
 * ─────────────────────────────────────────────
 * DELETE /api/goals/:id
 * Remove or Archive goal
 * ─────────────────────────────────────────────
 */
async function remove(req, res, next) {
  try {
    // FIX #5: Was service.remove(...) — correct method name is deleteGoal
    await service.deleteGoal(req.params.id, req.user.id);

    return sendSuccess(res, {
      message: 'Financial goal deleted successfully.',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  getById,
  create,
  contribute,
  update,
  remove,
};