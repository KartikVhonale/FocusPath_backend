import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    topicId: {
      type: String,
      required: true,
      trim: true,
    },
    topicTitle: {
      type: String,
      required: true,
      trim: true,
    },
    subjectName: {
      type: String,
      trim: true,
      default: 'General',
    },
    chapterName: {
      type: String,
      trim: true,
      default: '',
    },
    tag: {
      type: String,
      trim: true,
      default: '#Theory',
    },
    durationMinutes: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    plannedMinutes: {
      type: Number,
      min: 0,
      default: 0,
    },
    actualMinutes: {
      type: Number,
      min: 0,
      default: 0,
    },
    startTime: {
      type: Date,
      default: null,
    },
    endTime: {
      type: Date,
      default: null,
    },
    timeRange: {
      type: String,
      default: '',
    },
    loggedAt: {
      type: Date,
      default: Date.now,
    },
    mood: {
      type: String,
      enum: ['good', 'neutral', 'exhausted', ''],
      default: '',
    },
  },
  { _id: false }
);

const dailyLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    studyPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StudyPlan',
      required: true,
    },
    date: {
      type: String, // Normalized 'YYYY-MM-DD'
      required: true,
      index: true,
    },
    topicsCompleted: {
      type: Number,
      min: 0,
      default: 0,
    },
    completedTopicIds: {
      type: [String],
      default: [],
    },
    interruptions: {
      type: Number,
      min: 0,
      default: 0,
    },
    missedTopicIds: {
      type: [String],
      default: [],
    },
    // Granular Per-Subtopic Time Tracking Sessions
    sessions: {
      type: [sessionSchema],
      default: [],
    },
    totalTimeStudiedMinutes: {
      type: Number,
      min: 0,
      default: 0,
    },
    timeStudiedMinutes: {
      type: Number,
      min: 0,
      default: 0,
    },
    targetForDay: {
      type: Number,
      min: 0,
      default: 0,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

// Pre-save synchronization hook between totalTimeStudiedMinutes and timeStudiedMinutes
dailyLogSchema.pre('save', function (next) {
  if (
    this.totalTimeStudiedMinutes !== undefined &&
    this.totalTimeStudiedMinutes > 0 &&
    !this.timeStudiedMinutes
  ) {
    this.timeStudiedMinutes = this.totalTimeStudiedMinutes;
  } else if (
    this.timeStudiedMinutes !== undefined &&
    this.timeStudiedMinutes > 0 &&
    !this.totalTimeStudiedMinutes
  ) {
    this.totalTimeStudiedMinutes = this.timeStudiedMinutes;
  }
  next();
});

// Ensure one log per user per study plan per day
dailyLogSchema.index({ userId: 1, studyPlanId: 1, date: 1 }, { unique: true });

// Compound index for fast timeline queries sorted by date
dailyLogSchema.index({ userId: 1, date: -1 });

export default mongoose.model('DailyLog', dailyLogSchema);



