// categories.controller.js

const service = require('./categories.service');
const { sendSuccess } = require('../../shared/ApiResponse');


async function list(req, res, next) {
  try {
    const categories = await service.list(req.user.id);

    sendSuccess(res, categories);
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const category = await service.getById(
      req.params.id,
      req.user.id
    );

    sendSuccess(res, category);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const category = await service.create(req.user.id, req.body);
    sendSuccess(res, category, 201);
  } catch (err) {
    next(err); // Automatically handles ConflictError via your global middleware
  }
}

async function update(req, res, next) {
  try {
    const category = await service.update(req.params.id, req.user.id, req.body);
    sendSuccess(res, category, 200);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.remove(
      req.params.id,
      req.user.id
    );

    sendSuccess(res, {
      message: 'Category deleted',
    });
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




