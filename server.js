import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';
import teacherRoutes from './routes/teacher.js';
import Exam from './models/Exam.js';
import { seedDatabase } from './seed.js';
import './utils/cache.js'; // Initialize In-Memory Node-Cache (No Redis)

import errorHandler from './middleware/errorHandler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Configured URIs (Strictly MongoDB: 27017 primary)
const PRIMARY_MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/exam_tracker';
const FALLBACK_MONGODB_URI = 'mongodb://127.0.0.1:27010/exam_tracker';

// Process Crash Prevention & Unhandled Rejection Logging
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ [CRITICAL] Uncaught Exception thrown:', err);
});

// 1. Security Headers with Helmet
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false, // Allow local development assets
  })
);

// 2. Gzip Payload Compression
app.use(compression());

// 3. CORS with Credential Support
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  })
);

app.use(express.json({ limit: '10mb' }));

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Telemetry Error Logging Endpoint (Catches Frontend/Client errors)
app.post('/api/telemetry/log-error', (req, res) => {
  const { error, info, url, userAgent, timestamp } = req.body || {};
  console.error('📡 [CLIENT TELEMETRY ERROR LOG]', {
    error: error?.message || error || 'Unknown error',
    stack: error?.stack || null,
    componentStack: info?.componentStack || null,
    url: url || req.headers.referer,
    userAgent: userAgent || req.headers['user-agent'],
    timestamp: timestamp || new Date().toISOString(),
  });
  res.status(200).json({ success: true, logged: true });
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api', apiRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    dbState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date(),
  });
});

// Root check
app.get('/', (req, res) => {
  res.json({
    name: 'Adaptive Study Tracker API',
    status: 'running',
    auth: '/api/auth',
    docs: '/api/health',
  });
});

// 4. Centralized Error Handler Middleware (scrubs DB internals, standardizes output)
app.use(errorHandler);

// Resilient MongoDB Connection
async function connectToDatabase() {
  const tryConnect = async (uri, timeoutMs = 2500) => {
    return await mongoose.connect(uri, {
      serverSelectionTimeoutMS: timeoutMs,
    });
  };

  try {
    console.log(`🔄 Attempting MongoDB connection: ${PRIMARY_MONGODB_URI}`);
    await tryConnect(PRIMARY_MONGODB_URI, 2000);
    console.log(`✅ Connected to Primary MongoDB at: ${PRIMARY_MONGODB_URI}`);
  } catch (primaryErr) {
    console.warn(`⚠️ Primary MongoDB (${PRIMARY_MONGODB_URI}) failed: ${primaryErr.message}`);
    if (PRIMARY_MONGODB_URI !== FALLBACK_MONGODB_URI) {
      console.log(`🔄 Attempting Fallback MongoDB connection: ${FALLBACK_MONGODB_URI}`);
      try {
        await tryConnect(FALLBACK_MONGODB_URI, 5000);
        console.log(`✅ Connected to Fallback MongoDB at: ${FALLBACK_MONGODB_URI}`);
      } catch (fallbackErr) {
        throw new Error(
          `Both Primary (${PRIMARY_MONGODB_URI}) and Fallback (${FALLBACK_MONGODB_URI}) MongoDB connections failed.`
        );
      }
    } else {
      throw primaryErr;
    }
  }
}

// Launch Server
async function startServer() {
  try {
    await connectToDatabase();

    // Auto-seed if Exam count is zero
    const examCount = await Exam.countDocuments();
    if (examCount === 0) {
      console.log('🌱 No exams found in database. Auto-seeding exam templates...');
      await seedDatabase();
    } else {
      console.log(`📚 Database has ${examCount} exams loaded.`);
    }

    let server = null;
    function startListening() {
      server = app.listen(PORT, () => {
        console.log(`🚀 Backend Server running smoothly on http://localhost:${PORT}`);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`⚠️ Port ${PORT} temporarily busy, retrying in 1.5s...`);
          setTimeout(() => {
            try {
              server.close();
            } catch (e) {}
            startListening();
          }, 1500);
        } else {
          console.error('Server error:', err);
        }
      });
    }

    startListening();
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    app.listen(PORT, () => {
      console.log(`⚠️ Backend Server running with DB offline on http://localhost:${PORT}`);
    });
  }
}

startServer();
