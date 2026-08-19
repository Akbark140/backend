const { z } = require('zod');

const MAX_NUMERIC_12_2_MINOR_UNITS = 999999999999n;

function normalizeMoney(value, ctx) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Amount must be a finite decimal value',
    });
    return z.NEVER;
  }

  const raw = String(value).trim();

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Amount must be a positive decimal with at most 2 fractional digits',
    });
    return z.NEVER;
  }

  const [wholePart, fractionPart = ''] = raw.split('.');
  const whole = BigInt(wholePart);
  const cents = BigInt(fractionPart.padEnd(2, '0'));
  const minorUnits = whole * 100n + cents;

  if (minorUnits <= 0n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Amount must be positive',
    });
    return z.NEVER;
  }

  if (minorUnits > MAX_NUMERIC_12_2_MINOR_UNITS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Amount exceeds the supported financial limit',
    });
    return z.NEVER;
  }

  return `${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

const moneySchema = z.union([z.string(), z.number()]).transform(normalizeMoney);

const currencySchema = z
  .string()
  .trim()
  .length(3, 'Currency must be a 3-letter ISO code')
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), {
    message: 'Currency must contain only letters',
  });

const transactionTypeSchema = z.enum(['income', 'expense', 'transfer']);

const baseTransactionSchema = z.object({
  categoryId: z.string().uuid().optional(),
  amount: moneySchema,
  currency: currencySchema.default('USD'),
  type: transactionTypeSchema,
  destinationUserId: z.string().uuid().optional(),
  description: z.string().trim().max(500).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  isRecurring: z.boolean().default(false),
});

const createTransactionSchema = baseTransactionSchema.superRefine((data, ctx) => {
  if (data.type === 'transfer') {
    if (!data.destinationUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'destinationUserId is required when transaction type is transfer',
        path: ['destinationUserId'],
      });
    }
    return;
  }

  if (!data.categoryId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'categoryId is required for income and expense transactions',
      path: ['categoryId'],
    });
  }

  if (data.destinationUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'destinationUserId is only allowed for transfer transactions',
      path: ['destinationUserId'],
    });
  }
});

const updateTransactionSchema = baseTransactionSchema.partial().superRefine((data, ctx) => {
  if (data.type && data.type !== 'transfer' && data.destinationUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'destinationUserId is only allowed for transfer transactions',
      path: ['destinationUserId'],
    });
  }
});

const listTransactionsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  type: transactionTypeSchema.optional(),
  categoryId: z.string().uuid().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().trim().max(100).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATED WALLET VALIDATION SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const walletCheckoutSchema = z.object({
  amount: moneySchema,
  currency: currencySchema.default('PKR'),
  provider: z.enum(['EASYPAISA', 'JAZZCASH'], {
    errorMap: () => ({ message: "Provider selection must be explicitly 'EASYPAISA' or 'JAZZCASH'." })
  }),
  mobileNumber: z
    .string()
    .trim()
    .regex(/^(03\d{9}|923\d{9})$/, 'Valid Pakistani mobile wallet format required (e.g., 03001234567)'),
  categoryId: z.string().uuid('Category connection must be a valid system UUID').optional(),
  userId: z.string().uuid('User parameter validation context failed').optional(), // Optional if parsed via JWT middleware
  idempotencyKey: z.string().max(255).optional()
});

module.exports = {
  createTransactionSchema,
  updateTransactionSchema,
  listTransactionsSchema,
  walletCheckoutSchema,
};