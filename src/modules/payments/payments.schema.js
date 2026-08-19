const { z } = require('zod');

// 1. Define the Currency Schema independently
const currencySchema = z.enum(['PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR'], {
  errorMap: () => ({ message: "Supported currencies are PKR, USD, EUR, GBP, AED, or SAR." })
});

// 2. Define the Money Schema independently
const moneySchema = z
  .number({ required_error: "Transaction amount is required" })
  .positive("Amount must be greater than zero")
  .or(
    z.string().transform((val) => {
      const parsed = parseFloat(val);
      if (isNaN(parsed)) throw new Error("Invalid financial number format");
      return parsed;
    })
  );

// 3. Main Wallet Checkout Schema Definition
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
  walletCheckoutSchema
};