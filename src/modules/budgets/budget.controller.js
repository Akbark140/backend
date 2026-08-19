//budget.controller.js

const service = require('./budget.service');
const { sendSuccess } = require('../../shared/ApiResponse');


async function list(req, res, next) {
  try {
    const now = new Date();

    const month = Number(req.query.month ?? now.getMonth() + 1);
    const year = Number(req.query.year ?? now.getFullYear());

    const budgets = await service.list(req.user.id, month, year);

    sendSuccess(res, budgets);
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const budget = await service.getById(req.params.id, req.user.id);
    sendSuccess(res, budget);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const budget = await service.create(
      req.user.id,
      req.body
    );

    return sendSuccess(
      res,
      budget,
      'Budget created successfully',
      201
    );
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const updatedBudget = await service.update(
      id,
      userId,
      req.body
    );

    return sendSuccess(
      res,
      updatedBudget,
      'Budget updated successfully',
      200
    );
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    await service.remove(id, userId);

    return sendSuccess(
      res,
      null,
      'Budget deleted successfully',
      200
    );
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
};