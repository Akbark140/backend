// authorize.middleware.js

const jwt = require('jsonwebtoken');

const { config } = require('../config/index.config');
const { logger } = require('../config/logger.config');

/**
 * Resolve access token from Authorization header or HttpOnly cookie.
 * Supports both legacy Bearer-header clients and cookie-based auth.
 */
function extractAccessToken(req) {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const parts = authHeader.split(' ');

    if (parts.length === 2 && parts[0] === 'Bearer') {
      const token = parts[1];
      if (token && token !== 'undefined' && token !== 'null') {
        return token;
      }
    }
  }

  if (req.cookies?.accessToken) {
    return req.cookies.accessToken;
  }

  return null;
}

/**
 * Authentication Middleware
 * Verifies JWT access token
 */
function authenticate(req, res, next) {
  try {
    const token = extractAccessToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token missing',
      });
    }

    const decoded = jwt.verify(
      token,
      config.JWT_ACCESS_SECRET
    );

    let rawUserId = decoded.sub ?? decoded.id;

    if (typeof rawUserId === 'string') {
      rawUserId = rawUserId.trim().toLowerCase();
    }

    req.user = {
      id: rawUserId,
      email: decoded.email,
      role: decoded.role,
      jti: decoded.jti,
    };


    next();
  } catch (err) {
    logger.error({ err }, 'Authentication error');
    console.log("JWT VERIFY ERROR:", err.message);

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
}

/**
 * Role-based Authorization Middleware
 * Example:
 * authorize('admin')
 * authorize('admin', 'manager')
 */
function authorize(...roles) {
  return (req, res, next) => {
    try {
      // Ensure user exists
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Unauthorized',
        });
      }

      // Check role access
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Access denied',
        });
      }

      next();
    } catch (err) {
      logger.error(
        { err },
        'Authorization error'
      );

      return res.status(500).json({
        success: false,
        message: 'Server error',
      });
    }
  };
}

module.exports = {
  authenticate,
  authorize,
};