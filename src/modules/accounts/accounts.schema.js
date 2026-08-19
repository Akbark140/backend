// src/modules/accounts/accounts.schema.js

const Joi = require('joi');



const ACCOUNT_TYPES = ['CASH', 'BANK', 'CREDIT_CARD', 'SAVINGS', 'INVESTMENT', 'LOAN', 'DIGITAL_WALLET'];
const ACCOUNT_STATUS = ['ACTIVE', 'ARCHIVED', 'CLOSED', 'FROZEN'];

// Enforce strict runtime typing constraints
const validateCreateAccount = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  type: Joi.string().uppercase().valid(...ACCOUNT_TYPES).required(),
  currency: Joi.string().trim().uppercase().max(10).default('PKR'),
  balance: Joi.number().default(0.00),
  credit_limit: Joi.number().min(0).default(0.00),
  institution_name: Joi.string().trim().allow(null, ''),
  account_number_masked: Joi.string().trim().allow(null, '')
});

const validateUpdateAccount = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  type: Joi.string().uppercase().valid(...ACCOUNT_TYPES),
  currency: Joi.string().trim().uppercase().max(10),
  credit_limit: Joi.number().min(0),
  institution_name: Joi.string().trim().allow(null, ''),
  account_number_masked: Joi.string().trim().allow(null, '')
}).min(1);

const validateOperation = Joi.object({
  amount: Joi.number().positive().required()
});

const validateTransfer = Joi.object({
  targetAccountId: Joi.number().required(),
  amount: Joi.number().positive().required()
});

module.exports = {
  validateCreateAccount,
  validateUpdateAccount,
  validateOperation,
  validateTransfer,
  ACCOUNT_TYPES,
  ACCOUNT_STATUS
};