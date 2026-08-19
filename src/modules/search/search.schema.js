const Joi = require('joi');

const searchQuerySchema = Joi.object({
  q: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .required()
    .messages({
      'any.required': 'A search query (q) is required.',
      'string.base': 'Search query must be text.',
      'string.empty': 'A search query (q) is required.',
      'string.min': 'Search query must be at least 2 characters.',
      'string.max': 'Search query must not exceed 100 characters.',
    }),
});

module.exports = { searchQuerySchema };
