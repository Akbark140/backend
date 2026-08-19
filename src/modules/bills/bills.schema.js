const Joi = require('joi');

const RECURRENCE_OPTIONS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const STATUS_OPTIONS     = ['unpaid', 'paid', 'overdue'];

// ── Create Bill ───────────────────────────────────────────
const createBillSchema = Joi.object({
  name:        Joi.string().trim().min(1).max(100).required()
                 .messages({ 'any.required': 'Bill name is required.', 'string.max': 'Name must not exceed 100 characters.' }),

  amount:      Joi.number().positive().precision(2).required()
                 .messages({ 'any.required': 'Amount is required.', 'number.positive': 'Amount must be greater than zero.' }),

  currency:    Joi.string().trim().length(3).uppercase().default('USD'),

  due_date:    Joi.date().iso().required()
                 .messages({ 'any.required': 'Due date is required.', 'date.format': 'Due date must be a valid ISO date.' }),

  category_id: Joi.string().uuid().optional().allow(null),

  recurrence:  Joi.string().valid(...RECURRENCE_OPTIONS).default('none'),

  status:      Joi.string().valid(...STATUS_OPTIONS).default('unpaid'),

  notes:       Joi.string().trim().max(500).optional().allow('', null),

  is_autopay:  Joi.boolean().default(false),
});

// ── Update Bill ───────────────────────────────────────────
const updateBillSchema = Joi.object({
  name:        Joi.string().trim().min(1).max(100).optional(),
  amount:      Joi.number().positive().precision(2).optional(),
  currency:    Joi.string().trim().length(3).uppercase().optional(),
  due_date:    Joi.date().iso().optional(),
  category_id: Joi.string().uuid().optional().allow(null),
  recurrence:  Joi.string().valid(...RECURRENCE_OPTIONS).optional(),
  status:      Joi.string().valid(...STATUS_OPTIONS).optional(),
  notes:       Joi.string().trim().max(500).optional().allow('', null),
  is_autopay:  Joi.boolean().optional(),
}).min(1).messages({ 'object.min': 'At least one field is required to update.' });

// ── UUID param ────────────────────────────────────────────
const idParamSchema = Joi.object({
  id: Joi.string().uuid().required()
        .messages({ 'string.guid': 'Invalid bill ID format.' }),
});

// ── Middleware ────────────────────────────────────────────
function validateBody(req, res, next) {
  console.log('BODY:', req.body);

  const schema =
    req.method === 'POST'
      ? createBillSchema
      : updateBillSchema;

  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    console.log(error.details);

    return res.status(400).json({
      success: false,
      errors: error.details.map(d => d.message),
    });
  }

  req.validatedBody = value;
  next();
}

function validateParams(req, res, next) {
  const { error } = idParamSchema.validate(req.params);

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.details?.[0]?.message || 'Invalid bill ID.',
    });
  }

  return next();
}

module.exports = { validateBody, validateParams };