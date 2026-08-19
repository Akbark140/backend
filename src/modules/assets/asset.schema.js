const { z } = require('zod');

const createAssetSchema = z.object({
  name: z.string().min(1, 'Asset name is required').max(150),
  type: z.enum(['property', 'currency', 'digital', 'valuable']),
  quantity: z.coerce.number().nonnegative('Quantity cannot be negative').default(1.0),
  currency: z.string().min(1).max(10).default('USD'),
  purchase_price: z.coerce.number().positive('Purchase price must be greater than 0'),
  purchase_date: z.string().datetime({ message: 'Invalid ISO date string' }).or(z.string().date()),
  institution_or_location: z.string().optional(),
  note: z.string().optional(),
  exchange_rate_used: z.coerce.number().positive().optional().default(1.0)
});

const updateValuationSchema = z.object({
  unit_price: z.coerce.number().positive('Unit price must be greater than 0'),
  exchange_rate_used: z.coerce.number().positive().optional().default(1.0)
});

module.exports = {
  createAssetSchema,
  updateValuationSchema,
};
  