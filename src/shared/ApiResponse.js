/**
 * @file ApiResponse.js
 * @description Standardized API response helpers.
 */

class ApiResponse {
  constructor(statusCode, message, data = null, success = true, meta = null) {
    this.success = success;
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;

    if (meta) {
      this.meta = meta;
    }
  }

  static success(message = 'Success', data = null, statusCode = 200, meta = null) {
    return new ApiResponse(
      statusCode,
      message,
      data,
      true,
      meta
    );
  }

  static created(message = 'Created successfully', data = null, meta = null) {
    return new ApiResponse(
      201,
      message,
      data,
      true,
      meta
    );
  }

  static error(message = 'Something went wrong', statusCode = 500, data = null) {
    return new ApiResponse(
      statusCode,
      message,
      data,
      false
    );
  }
}

/**
 * Send a successful response.
 *
 * @param {Object} res
 * @param {*} data
 * @param {String} message
 * @param {Number} statusCode
 * @param {Object|null} meta
 */
function sendSuccess(
  res,
  data = null,
  message = 'Success',
  statusCode = 200,
  meta = null
) {
  const response = {
    success: true,
    message,
    data,
  };

  if (meta) {
    response.meta = meta;
  }

  return res.status(statusCode).json(response);
}

/**
 * Send a created response (201).
 *
 * @param {Object} res
 * @param {*} data
 * @param {String} message
 */
function sendCreated(
  res,
  data = null,
  message = 'Created successfully'
) {
  return sendSuccess(
    res,
    data,
    message,
    201
  );
}

/**
 * Send an error response.
 *
 * @param {Object} res
 * @param {String} message
 * @param {Number} statusCode
 * @param {*} data
 */
function sendError(
  res,
  message = 'Something went wrong',
  statusCode = 500,
  data = null
) {
  return res.status(statusCode).json({
    success: false,
    message,
    data,
  });
}

module.exports = {
  ApiResponse,
  sendSuccess,
  sendCreated,
  sendError,
};