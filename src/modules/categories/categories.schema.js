// categories.schema.js

const { z } = require('zod');

const createCategorySchema = z.object({
  name: z.string().min(2).max(50).trim(),
  icon: z.string().min(1).max(20),
  color: z.string().regex(/^#([0-9A-Fa-f]{3}){1,2}$/), // Validates hex codes like #006c49
  type: z.enum(['income', 'expense']),
});

// For updates, all fields are optional (.partial())

const updateCategorySchema = createCategorySchema.partial();


module.exports = {
  createCategorySchema,
  updateCategorySchema,
};
