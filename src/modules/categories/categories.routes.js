// categories.routes.js 

const { Router } = require('express');
const { authenticate } = require('../../middleware/authorize.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { createCategorySchema, updateCategorySchema } = require('./categories.schema');
const controller = require('./categories.controller');


const router = Router();

router.use(authenticate);

router.get('/', controller.list);

router.get('/:id', controller.getOne);

router.post(
  '/',
  validate(createCategorySchema),
  controller.create
);

router.patch(
  '/:id',
  validate(updateCategorySchema),
  controller.update
);

router.delete('/:id', controller.remove);

module.exports = {
  categoriesRouter: router,
};