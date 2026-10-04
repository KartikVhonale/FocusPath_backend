import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const JWT_SECRET = process.env.JWT_SECRET || 'adaptive_study_tracker_jwt_secret_key_2026';

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (match) token = match[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No authorization token provided.',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'The user belonging to this token no longer exists.',
      });
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    console.error('JWT Verification Error:', error.message);
    return res.status(401).json({
      success: false,
      message: 'Token invalid or expired. Please log in again.',
    });
  }
};

/**
 * Role-Based Access Control (RBAC) Middleware
 * Checks req.user.role. If user's role is not in allowedRoles, returns 403 Forbidden.
 */
export const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required before checking permissions.',
      });
    }

    const currentRole =
      req.user.role || (req.user.accountMode === 'teacher' ? 'teacher' : 'student');

    if (!allowedRoles.includes(currentRole) && !allowedRoles.includes(req.user.accountMode)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: User role '${currentRole}' is not authorized to access this resource. Required role: ${allowedRoles.join(' or ')}.`,
      });
    }

    next();
  };
};

// Optional auth for public routes that can benefit from knowing the user if logged in
export const optionalAuth = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      if (user) {
        req.user = user;
        req.userId = user._id;
      }
    } catch (err) {
      // Ignore token failure for optional
    }
  }

  // If no user found from token, fallback to default user if available
  if (!req.user) {
    const defaultUser = await User.findOne();
    if (defaultUser) {
      req.user = defaultUser;
      req.userId = defaultUser._id;
    }
  }

  next();
};

export default protect;
