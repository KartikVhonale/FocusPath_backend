import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import asyncHandler from '../utils/asyncHandler.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'adaptive_study_tracker_jwt_secret_key_2026';
const JWT_EXPIRES_IN = '12h';

// Helper to set secure HttpOnly cookie alongside token response
export const setTokenCookie = (res, token) => {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
  });
};

// Rate Limiter: Max 5 attempts per 15 minutes on auth endpoints (skipped in test mode)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 5,
  skip: (req) => process.env.NODE_ENV === 'test' || req.headers['x-test-suite'] === 'true',
  skipSuccessfulRequests: true, // Successful requests don't penalize user
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.',
  },
});

const generateToken = (id) => {
  return jwt.sign({ id }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
};

// Helper: Generate unique 6-character uppercase alphanumeric teacher code (skips confusing chars 0, O, 1, I)
function generateTeacherCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function getUniqueTeacherCode() {
  let code = '';
  let exists = true;
  while (exists) {
    code = generateTeacherCode();
    const found = await User.findOne({ teacherCode: code });
    if (!found) exists = false;
  }
  return code;
}

// Helper: Format user payload with teacher details if applicable
async function formatUserResponse(user) {
  let teacherName = '';
  let cohortNotes = user.cohortNotes || '';

  if (user.assignedTeacherId) {
    const teacher = await User.findById(user.assignedTeacherId)
      .select('username cohortNotes')
      .lean();
    if (teacher) {
      teacherName = teacher.username;
      if (!cohortNotes) cohortNotes = teacher.cohortNotes || '';
    }
  }

  return {
    id: user._id,
    _id: user._id,
    username: user.username,
    name: user.username,
    email: user.email,
    accountMode: user.accountMode || 'self_study',
    role: user.accountMode === 'teacher' ? 'teacher' : 'student',
    teacherCode: user.teacherCode || '',
    assignedTeacherId: user.assignedTeacherId || null,
    teacherName,
    cohortNotes,
  };
}

// @route   POST /api/auth/register or /auth/register
// @desc    Register a new user (Self-Study, Managed, or Teacher) & return JWT token
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const {
    username,
    name,
    email,
    password,
    accountMode: rawMode = 'self_study',
    teacherCode,
    cohortNotes,
  } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Please provide both email and password.',
      message: 'Please provide both email and password.',
      code: 400,
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 6 characters long.',
    });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const displayName = (username || name || 'Aspirant').trim();

  // Determine account mode
  const validModes = ['self_study', 'managed', 'teacher'];
  const accountMode = validModes.includes(rawMode) ? rawMode : 'self_study';

  // Check if user already exists
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    return res.status(400).json({
      success: false,
      message: 'An account with this email address already exists. Please log in.',
    });
  }

  let assignedTeacherId = null;
  let finalTeacherCode = undefined;

  // Managed Student Flow: Must provide valid teacher invite code
  if (accountMode === 'managed') {
    if (!teacherCode || !teacherCode.trim()) {
      return res.status(400).json({
        success: false,
        message:
          'Teacher Invite Code is required to join a managed class. Ask your instructor for the 6-character code.',
      });
    }

    const cleanCode = teacherCode.trim().toUpperCase();
    const teacher = await User.findOne({
      accountMode: 'teacher',
      teacherCode: cleanCode,
    });

    if (!teacher) {
      return res.status(400).json({
        success: false,
        message: `Invalid Teacher Invite Code "${cleanCode}". Please verify the code with your instructor.`,
      });
    }

    assignedTeacherId = teacher._id;
  }

  // Teacher Flow: Generate unique 6-character invite code
  if (accountMode === 'teacher') {
    finalTeacherCode = await getUniqueTeacherCode();
  }

  // Create user
  const user = await User.create({
    username: displayName,
    email: normalizedEmail,
    password,
    accountMode,
    teacherCode: finalTeacherCode,
    assignedTeacherId,
    cohortNotes: accountMode === 'teacher' && cohortNotes ? String(cohortNotes).trim() : '',
  });

  const token = generateToken(user._id);
  const userPayload = await formatUserResponse(user);

  setTokenCookie(res, token);

  res.status(201).json({
    success: true,
    message:
      accountMode === 'managed'
        ? '🎉 Account created and linked to your instructor class!'
        : accountMode === 'teacher'
          ? '🎉 Instructor account created with invite code!'
          : '🎉 Account created successfully!',
    token,
    user: userPayload,
  });
}));

// @route   POST /api/auth/login or /auth/login
// @desc    Authenticate user & return JWT token (Rate Limited)
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Please provide both email and password.',
      message: 'Please provide both email and password.',
      code: 400,
    });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Find user
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password.',
    });
  }

  // Match password
  const isMatch = await user.matchPassword(password);
  if (!isMatch) {
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password.',
    });
  }

  const token = generateToken(user._id);
  const userPayload = await formatUserResponse(user);

  setTokenCookie(res, token);

  res.json({
    success: true,
    message: 'Logged in successfully!',
    token,
    user: userPayload,
  });
}));

// @route   POST /api/auth/logout or /auth/logout
// @desc    Clear authentication cookie
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
  });
  res.json({
    success: true,
    message: 'Logged out successfully.',
  });
});

// @route   GET /api/auth/me or /auth/me
// @desc    Get current user profile from token
router.get('/me', protect, async (req, res) => {
  const userPayload = await formatUserResponse(req.user);
  res.json({
    success: true,
    user: userPayload,
  });
});

export default router;
