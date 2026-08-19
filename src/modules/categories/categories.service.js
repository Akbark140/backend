// categories.service.js

const repo = require('./categories.repository');
const { NotFoundError, ConflictError } = require('../../shared/AppError');

async function list(userId) {
  return repo.findAll(userId);
}

async function getById(id, userId) {
  const category = await repo.findById(
    id,
    userId
  );

  if (!category) {
    throw new NotFoundError('Category');
  }

  return category;
}

// Import your custom errors here (e.g., import { ConflictError, NotFoundError } from '../../errors';)

async function create(userId, input) {
  const newCategory = await repo.create(userId, input);

  if (!newCategory) {
    throw new ConflictError('Category already exists');
  }

  return newCategory;
}

async function update(id, userId, input) {
  // 1. Verify existence
  const existing = await repo.findById(id, userId);
  if (!existing) {
    throw new NotFoundError('Category');
  }

  // 2. Execute update
  const updatedCategory = await repo.update(id, userId, input);

  if (updatedCategory === 'DUPLICATE') {
    throw new ConflictError('A category with this name already exists.');
  }

  return updatedCategory;
}

async function remove(id, userId) {
  const deleted = await repo.remove(
    id,
    userId
  );

  if (!deleted) {
    throw new NotFoundError('Category');
  }
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
};