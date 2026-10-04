import mongoose from 'mongoose';

const activeSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  username: {
    type: String,
    required: true,
  },
  avatar: {
    type: String,
  },
  status: {
    type: String,
    enum: ['focusing', 'offline'],
    default: 'offline',
  },
  topic: {
    type: String,
    default: '',
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  // Expire offline or stale records automatically after 2 hours
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 2 * 60 * 60 * 1000),
    index: { expires: '0s' },
  },
});

const ActiveSession = mongoose.model('ActiveSession', activeSessionSchema);
export default ActiveSession;
