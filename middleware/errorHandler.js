/**
 * Production-Grade Express Error Handling Middleware
 * Scrubs sensitive database stack traces and internal query details.
 * Returns standard JSON format: { error: true, message: "Clean user-facing message", code: 400 }
 */
export default function errorHandler(err, req, res, next) {
  const statusCode = err.status || err.statusCode || (res.statusCode >= 400 ? res.statusCode : 500);

  // Default clean user-facing error message
  let message = err.message || 'An unexpected error occurred. Please try again.';

  // Scrub Mongoose ValidationError
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors || {}).map((e) => e.message);
    message = messages.length > 0 ? messages.join(', ') : 'Validation failed on input data.';
  }

  // Scrub MongoDB duplicate key error (E11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'Field';
    message = `${field.charAt(0).toUpperCase() + field.slice(1)} already exists. Please choose another.`;
  }

  // Scrub JWT errors
  if (err.name === 'JsonWebTokenError') {
    message = 'Invalid authentication token. Please log in again.';
  } else if (err.name === 'TokenExpiredError') {
    message = 'Your session has expired. Please log in again.';
  }

  // Log server-side diagnostic details without exposing to user
  console.error(`🚨 [API Error] ${req.method} ${req.originalUrl || req.url}:`, {
    message: err.message,
    statusCode,
    name: err.name,
    timestamp: new Date().toISOString(),
  });

  return res.status(statusCode).json({
    error: true,
    message,
    code: statusCode,
  });
}

