const Joi = require('joi');

// ==========================================
// 🔹 CONSTANTS
// ==========================================

const USER_ROLES = {
  USER: 'user',
  ADMIN: 'admin',
};

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_TIMEZONE = 'UTC';

// ==========================================
// 🔹 USER VALIDATION SCHEMA (JOI)
// ==========================================

const createUserSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
  role: Joi.string()
    .valid(USER_ROLES.USER, USER_ROLES.ADMIN)
    .default(USER_ROLES.USER),
  avatar_url: Joi.string().uri().optional(),
  currency: Joi.string().default(DEFAULT_CURRENCY),
  timezone: Joi.string().default(DEFAULT_TIMEZONE),
});

// ==========================================
// 🔹 UPDATE USER (SAFE FIELDS ONLY)
// ==========================================

const updateUserSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  avatar_url: Joi.string().uri().optional(),
  currency: Joi.string().optional(),
  timezone: Joi.string().optional(),
  preferences: Joi.object().optional(),
}).min(1); // must update at least one field

// ==========================================
// 🔹 LOGIN / AUTH VALIDATION
// ==========================================

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

// ==========================================
// 🔹 PASSWORD UPDATE
// ==========================================

const updatePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(6).max(100).required(),
});

// ==========================================
// 🔹 EMAIL UPDATE
// ==========================================

const updateEmailSchema = Joi.object({
  newEmail: Joi.string().email().required(),
});

// ==========================================
// 🔹 PREFERENCES
// ==========================================

const updatePreferencesSchema = Joi.object({
  theme: Joi.string().valid('light', 'dark').optional(),
  language: Joi.string().optional(),
  notifications: Joi.boolean().optional(),
});

// ==========================================
// 🔹 EXPORTS
// ==========================================

module.exports = {
  USER_ROLES,
  DEFAULT_CURRENCY,
  DEFAULT_TIMEZONE,

  createUserSchema,
  updateUserSchema,
  loginSchema,
  updatePasswordSchema,
  updateEmailSchema,
  updatePreferencesSchema,
};