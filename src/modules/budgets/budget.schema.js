// budget.schema.js

const { z } = require('zod');

/**
 * CREATE BUDGET
 * Matches frontend request exactly
 */
const createBudgetSchema = z.object({
  categoryId: z.string().min(1, 'Category is required'),

  amountLimit: z
    .number({
      required_error: 'Amount limit is required',
      invalid_type_error: 'Amount limit must be a number',
    })
    .positive('Amount must be greater than 0'),

  currency: z.string().default('USD'),

  month: z
    .number({
      required_error: 'Month is required',
      invalid_type_error: 'Month must be a number',
    })
    .int()
    .min(1)
    .max(12),

  year: z
    .number({
      required_error: 'Year is required',
      invalid_type_error: 'Year must be a number',
    })
    .int()
    .min(2020)
    .max(2100),
});

/**
 * UPDATE BUDGET
 */
const updateBudgetSchema = z.object({
  categoryId: z.string().min(1).optional(),
  amountLimit: z.number().positive().optional(),
  currency: z.string().optional(),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2020).max(2100).optional(),

  status: z.enum(['active', 'inactive']).optional(),
});

module.exports = {
  createBudgetSchema,
  updateBudgetSchema,
};