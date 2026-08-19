const repo = require('./users.repository');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ==========================================
// IDENTITY (SELF-SERVICE)
// ==========================================

async function getMe(userId) {
  return await repo.getUserById(userId);
}

async function updateMe(userId, data) {
  // Only allow safe fields
  const allowed = {
    name: data.name,
    timezone: data.timezone,
    currency: data.currency,
  };

  return await repo.updateUser(userId, allowed);
}

async function deleteMe(userId) {
  // soft delete for safety
  return await repo.softDeleteUser(userId);
}

// ==========================================
// ADMIN FUNCTIONS
// ==========================================

async function getUserById(userId) {
  return await repo.getUserById(userId);
}

async function updateUserById(userId, data) {
  return await repo.updateUser(userId, data);
}

async function deleteUserById(userId) {
  return await repo.deleteUser(userId);
}

// ==========================================
// SECURITY (CRITICAL LOGIC)
// ==========================================

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(12);
  return await bcrypt.hash(password, salt);
}

async function verifyCurrentPassword(plainPassword, hashedPassword) {
  return await bcrypt.compare(plainPassword, hashedPassword);
}

async function updatePassword(userId, currentPassword, newPassword) {
  const user = await repo.getUserById(userId);

  const isValid = await verifyCurrentPassword(
    currentPassword,
    user.password_hash
  );

  if (!isValid) {
    throw new Error('Current password is incorrect');
  }

  const newHash = await hashPassword(newPassword);

  return await repo.updatePasswordHash(userId, newHash);
}

async function updateEmail(userId, newEmail) {
  return await repo.updateUser(userId, {
    email: newEmail,
    isverified: false, // force re-verification
  });
}

// ==========================================
//  MEDIA / AVATAR
// ==========================================

async function validateImageUpload(file) {
  if (!file) throw new Error('No file uploaded');

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

  if (!allowedTypes.includes(file.mimetype)) {
    throw new Error('Invalid image format');
  }

  const maxSize = 2 * 1024 * 1024; // 2MB
  if (file.size > maxSize) {
    throw new Error('Image too large (max 2MB)');
  }

  return true;
}

async function updateAvatar(userId, imageUrl) {
  return await repo.updateAvatarUrl(userId, imageUrl);
}

// ==========================================
// 🔹 ANALYTICS (USER BEHAVIOR LAYER)
// ==========================================

async function getMyActivity(userId) {
  // Placeholder (depends on your logs/activity table)
  return {
    userId,
    recentActions: [],
  };
}

async function getMyStats(userId) {
  const user = await repo.getUserById(userId);

  return {
    userId,
    balance: user.balance,
    isActive: user.is_active,
    isVerified: user.isverified,
    accountAgeDays:
      Math.floor(
        (Date.now() - new Date(user.created_at)) / (1000 * 60 * 60 * 24)
      ),
  };
}

// ==========================================
//  PREFERENCES SYSTEM
// ==========================================

async function updatePreferences(userId, preferences) {
  // Store preferences inside JSON column OR extend later
  return await repo.updateUser(userId, {
    preferences: preferences,
  });
}

async function getPreferences(userId) {
  const user = await repo.getUserById(userId);
  return user.preferences || {};
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  // Identity
  getMe,
  updateMe,
  deleteMe,

  // Admin
  getUserById,
  updateUserById,
  deleteUserById,

  // Security
  updatePassword,
  verifyCurrentPassword,
  updateEmail,
  hashPassword,

  // Media
  updateAvatar,
  validateImageUpload,

  // Analytics
  getMyActivity,
  getMyStats,

  // Preferences
  updatePreferences,
  getPreferences,
};

