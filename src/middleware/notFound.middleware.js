// notFound.middleware.js

/**
 * 404 Not Found Middleware
 * Handles all unknown routes
 */
function notFound(req, res, next) {
  res.status(404).json({
    success: false,
    message: `Route not found - ${req.originalUrl}`,
  });
}

module.exports = notFound;