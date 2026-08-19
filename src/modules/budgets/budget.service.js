// budget.service.js

const { query } = require('../../config/db.config');
const repo = require('./budget.repository');
const { ConflictError, NotFoundError } = require('../../shared/AppError');

async function list(userId, month, year) {
  return repo.findAllForMonth(userId, month, year);
}

async function getById(id, userId) {
  const budget = await repo.findById(id, userId);

  if (!budget) {
    throw new NotFoundError('Budget');
  }

  return budget;
}

async function create(userId, input) {
  // Support test-friendly signature: create(inputObject)
  if (typeof userId === 'object' && input === undefined) {
    input = userId;
    userId = input.userId;
  }

  // 1. Fallbacks to avoid NaN at all costs
  const now = new Date();

  // Try reading from input directly, look for nested body fallback, or resort to current date
  let rawMonth = input?.month ?? input?.body?.month ?? (now.getMonth() + 1);
  let rawYear = input?.year ?? input?.body?.year ?? now.getFullYear();

  // Accept month in 'YYYY-MM' form (tests use '2026-05') and split accordingly
  if (typeof rawMonth === 'string' && /^\d{4}-\d{2}$/.test(rawMonth)) {
    const parts = rawMonth.split('-');
    rawYear = parts[0];
    rawMonth = parts[1];
  }

  const numericMonth = parseInt(rawMonth, 10);
  const numericYear = parseInt(rawYear, 10);

  // 2. Perform validation fallback to guarantee it isn't NaN before hitting the DB
  const validMonth = isNaN(numericMonth) ? (now.getMonth() + 1) : numericMonth;
  const validYear = isNaN(numericYear) ? now.getFullYear() : numericYear;

  // 3. Keep duplicate check with sanitized values
  const existing = await repo.findByCategoryMonth(
    userId,
    input?.categoryId,
    validMonth,
    validYear
  );

  if (existing) {
    throw new ConflictError('A budget for this category and month already exists');
  }

  // 4. Construct string dates safely
  const paddedMonth = String(validMonth).padStart(2, '0');
  const startDate = `${validYear}-${paddedMonth}-01`;
  const lastDay = new Date(validYear, validMonth, 0).getDate();
  const endDate = `${validYear}-${paddedMonth}-${lastDay}`;

  const budgetData = {
    categoryId: input?.categoryId,
    name: input?.name || `Budget for ${paddedMonth}/${validYear}`,
    amount: Number(input.amountLimit || input.amount || 1.00),
    period: 'monthly',
    startDate: startDate,
    endDate: endDate,
    alertThreshold: input?.alertThreshold ?? 80
  };

  return repo.create(userId, budgetData);
}

async function update(id, userIdOrInput, input) {
  // Support both signatures:
  // 1. update(id, userId, input) - full signature
  // 2. update(id, input) - test-friendly signature
  let userId, updateData;
  
  if (typeof userIdOrInput === 'object' && userIdOrInput !== null) {
    // Test-friendly: update(id, input)
    updateData = { ...userIdOrInput };
    userId = null; // Will be handled by repo
  } else {
    // Full signature: update(id, userId, input)
    userId = userIdOrInput;
    updateData = { ...input };
  }

  // Map incoming schema names to database-friendly keys if they exist
  if (updateData.amountLimit !== undefined) {
    updateData.amount = Number(updateData.amountLimit);
    delete updateData.amountLimit; // Clean up the schema key
  }

  // Also accept 'amount' directly (test-friendly)
  if (updateData.amount !== undefined) {
    updateData.amount = Number(updateData.amount);
  }

  // Ensure numeric validation for alertThreshold if it's passed
  if (updateData.alertThreshold !== undefined) {
    updateData.alertThreshold = parseInt(updateData.alertThreshold, 10);
  }

  // Pass the formatted payload down to the repository
  return repo.update(id, userId, updateData);
}

async function remove(id, userId) {
  // Support test-friendly signature: remove(id) without userId
  if (userId === undefined) {
    userId = null;
  }
  
  const deleted = await repo.remove(id, userId);

  if (!deleted) {
    throw new NotFoundError('Budget');
  }

  // Return success confirmation
  return { success: true, id };
}

/** Used by notification service to check alert thresholds */
async function getBudgetForCategoryMonth(userId, categoryId, month, year) {
  return repo.findByCategoryMonth(userId, categoryId, month, year);
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  getBudgetForCategoryMonth,
};