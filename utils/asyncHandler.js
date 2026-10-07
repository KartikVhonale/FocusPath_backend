/**
 * asyncHandler — Zero-Crash Express Wrapper
 *
 * Wraps any async Express controller function so that any thrown error or
 * rejected promise is automatically forwarded to next(error) instead of
 * crashing the Node process with an unhandled rejection.
 *
 * Usage:
 *   router.get('/route', asyncHandler(async (req, res) => { ... }));
 *
 * @param {Function} fn - An async Express route handler (req, res, next) => Promise
 * @returns {Function} Express middleware that catches all async errors
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
