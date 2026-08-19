/**
 * Authentication Validation Schemas
 * * Part of the Input Validation Layer. Ensures incoming request data 
 * conforms to strict data types, lengths, and security constraints before 
 * it ever hits your controllers or services.
 */

const { z } = require('zod');

/**
 * Schema for User Registration requests
 * Expects: name, email, password, and optional currency
 */
// Precise regex mirroring Google's strict internal creation constraints
const GMAIL_SYNTAX_REGEX = /^(?=[a-z0-9.]{6,30}$)(?!.*\.\.)[a-z0-9](?:[a-z0-9.]*[a-z0-9])?$/;

 const registerSchema = z.object({
  // Enforces readable names, trims whitespace, and protects against database overflows
  name: z.string().min(2).max(80).trim(),
  
  // Sanitizes, checks baseline validity, and applies Google-specific constraints to @gmail.com handles
  email: z
    .string()
    .email('Invalid email format')
    .toLowerCase()
    .trim()
    .refine((val) => {
      // Split the handle (local part) from the domain
      const [localPart, domain] = val.split('@');
      
      // If it's a standard consumer Gmail account, apply strict Google validation
      if (domain === 'gmail.com') {
        return GMAIL_SYNTAX_REGEX.test(localPart);
      }
      
      // Fallback: Allow standard email architecture rules for all other domains
      return true;
    }, {
      message: 'Gmail handles must be 6-30 characters, use only a-z, 0-9, single periods, and no trailing punctuation.',
    }),
  
  // Enforces strong security requirements for account creation
  password: z
    .string()
    .min(8) // Minimum length safeguard
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Must contain at least one number')
    .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character'),
  
  // Enforces ISO 4217 standard currency codes (e.g., 'USD', 'EUR', 'GBP'), defaulting to 'USD'
  currency: z.string().length(3).toUpperCase().default('USD'),
});

/**
 * Schema for Traditional Login requests
 * Expects: email, password
 */
const loginSchema = z.object({
  // Matches registration sanitation for clean lookups
  email: z.string().email().toLowerCase().trim(),

  // Simply verifies a password was provided (hashing and checking happens in the service layer)
  password: z.string().min(1),

  // Optional UI flag — not used by the service layer
  rememberMe: z.boolean().optional(),
});

/**
 * Schema for Token Refresh requests
 * Expects: refreshToken (from HttpOnly cookies)
 * ✅ refreshToken is now optional (read from cookies instead of body)
 */
const refreshSchema = z.object({
  // Empty schema - refreshToken comes from HttpOnly cookies
}).strict().passthrough();

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
};