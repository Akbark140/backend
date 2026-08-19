const service = require('./users.service');
const schemas = require('./users.schema');
const { sendSuccess } = require('../../shared/ApiResponse');

// Optional helper (if you are not using middleware yet)
function validate(schema, data) {
  const { error, value } = schema.validate(data);
  if (error) throw new Error(error.details[0].message);
  return value;
}

/**
 * ─────────────────────────────────────────────
 * CURRENT USER (ME)
 * ─────────────────────────────────────────────
 */

const getMe = async (req, res, next) => {
  try {
    const data = await service.getMe(req.user.id);
    // 💡 FIXED: Removed the hardcoded 200 to match your standard (res, data, message) signature
    return sendSuccess(res, data, 'User fetched successfully');
  } catch (err) {
    next(err);
  }
};

const updateMe = async (req, res, next) => {
  try {
    const validData = validate(schemas.updateUserSchema, req.body);

    const data = await service.updateMe(req.user.id, validData);

    return sendSuccess(res, data, 'User updated successfully');
  } catch (err) {
    next(err);
  }
};

const deleteMe = async (req, res, next) => {
  try {
    const data = await service.deleteMe(req.user.id);
    return sendSuccess(res, data, 'User deleted successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * ─────────────────────────────────────────────
 * ADMIN / OTHER USER OPERATIONS
 * ─────────────────────────────────────────────
 */

const getUserById = async (req, res, next) => {
  try {
    const data = await service.getUserById(req.params.id);
    return sendSuccess(res, data, 'User fetched successfully');
  } catch (err) {
    next(err);
  }
};

const updateUserById = async (req, res, next) => {
  try {
    const validData = validate(schemas.updateUserSchema, req.body);

    const data = await service.updateUserById(req.params.id, validData);

    return sendSuccess(res, data, 'User updated successfully');
  } catch (err) {
    next(err);
  }
};

const deleteUserById = async (req, res, next) => {
  try {
    const data = await service.deleteUserById(req.params.id);
    return sendSuccess(res, data, 'User deleted successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * ─────────────────────────────────────────────
 * SECURITY / ACCOUNT
 * ─────────────────────────────────────────────
 */

const updatePassword = async (req, res, next) => {
  try {
    const validData = validate(schemas.updatePasswordSchema, req.body);

    const data = await service.updatePassword(
      req.user.id,
      validData.currentPassword,
      validData.newPassword
    );

    return sendSuccess(res, data, 'Password updated successfully');
  } catch (err) {
    next(err);
  }
};

const updateEmail = async (req, res, next) => {
  try {
    const validData = validate(schemas.updateEmailSchema, req.body);

    const data = await service.updateEmail(
      req.user.id,
      validData.newEmail
    );

    return sendSuccess(res, data, 'Email updated successfully');
  } catch (err) {
    next(err);
  }
};

const uploadAvatar = async (req, res, next) => {
  try {
    await service.validateImageUpload(req.file);

    const imageUrl = req.file.path || req.file.location;

    const data = await service.updateAvatar(req.user.id, imageUrl);

    return sendSuccess(res, data, 'Avatar uploaded successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * ─────────────────────────────────────────────
 * ANALYTICS / ACTIVITY
 * ─────────────────────────────────────────────
 */

const getMyActivity = async (req, res, next) => {
  try {
    const data = await service.getMyActivity(req.user.id);
    return sendSuccess(res, data, 'Activity fetched successfully');
  } catch (err) {
    next(err);
  }
};

const getMyStats = async (req, res, next) => {
  try {
    const data = await service.getMyStats(req.user.id);
    return sendSuccess(res, data, 'Stats fetched successfully');
  } catch (err) {
    next(err);
  }
};

const updateMyPreferences = async (req, res, next) => {
  try {
    const validData = validate(
      schemas.updatePreferencesSchema,
      req.body
    );

    const data = await service.updatePreferences(
      req.user.id,
      validData
    );

    return sendSuccess(res, data, 'Preferences updated successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getMe,
  updateMe,
  deleteMe,
  getUserById,
  updateUserById,
  deleteUserById,
  updatePassword,
  updateEmail,
  uploadAvatar,
  getMyActivity,
  getMyStats,
  updateMyPreferences,
};