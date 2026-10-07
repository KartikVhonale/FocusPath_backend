import mongoose from 'mongoose';

// Level 4 (Deepest): Subtopics with Spaced Repetition System (SRS) tracking
const subtopicNodeSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  nodeId: {
    type: String,
    trim: true,
  },
  isCompleted: {
    type: Boolean,
    default: false,
  },
  isPersonal: {
    type: Boolean,
    default: false,
  },
  reviewCount: {
    type: Number,
      min: 0,
      default: 0,
  },
  nextReviewDate: {
    type: Date,
    default: null,
  },
  lastReviewedAt: {
    type: Date,
    default: null,
  },
  timeSpentMinutes: {
    type: Number,
      min: 0,
      default: 0,
  },
});

// Level 3: Topics containing Subtopics
const topicNodeSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  timeSpentMinutes: {
    type: Number,
      min: 0,
      default: 0,
  },
  subtopics: [subtopicNodeSchema],
});

// Level 2: Chapters containing Topics
const chapterNodeSchema = new mongoose.Schema({
  chapterName: {
    type: String,
    required: true,
    trim: true,
  },
  title: {
    type: String,
    trim: true,
  },
  topics: [topicNodeSchema],
});

// Auto-sync chapterName and title
chapterNodeSchema.pre('validate', function () {
  if (this.chapterName && !this.title) {
    this.title = this.chapterName;
  } else if (this.title && !this.chapterName) {
    this.chapterName = this.title;
  }
});

// Level 1: Subjects containing Chapters
const subjectNodeSchema = new mongoose.Schema({
  subjectName: {
    type: String,
    required: true,
    trim: true,
  },
  name: {
    type: String,
    trim: true,
  },
  chapters: [chapterNodeSchema],
});

// Auto-sync subjectName and name
subjectNodeSchema.pre('validate', function () {
  if (this.subjectName && !this.name) {
    this.name = this.subjectName;
  } else if (this.name && !this.subjectName) {
    this.subjectName = this.name;
  }
});

const studyPlanSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
    },
    targetDate: {
      type: Date,
      required: true,
    },
    // 4-Level Deep Nested Hierarchy with Subtopic SRS tracking
    subjects: [subjectNodeSchema],
    totalTopics: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    totalLeafNodes: {
      type: Number,
      min: 0,
      default: 0,
    },
    vacationDates: {
      type: [Date],
      default: [],
    },
    completedTopics: {
      type: Number,
      min: 0,
      default: 0,
    },
    completedChapterIds: {
      type: [String],
      default: [],
    },
    // Fast O(1) indexed list of SRS node reviews
    nodeReviews: {
      type: [
        {
          nodeId: { type: String, required: true },
          title: { type: String },
          subjectName: { type: String },
          reviewCount: { type: Number, min: 0, default: 0 },
          nextReviewDate: { type: Date, default: null },
          lastReviewedAt: { type: Date, default: null },
          timeSpentMinutes: { type: Number, min: 0, default: 0 },
        },
      ],
      default: [],
    },
    selectedSubjects: {
      type: [String],
      default: [],
    },
    studyDays: {
      type: [String],
      default: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      validate: {
        validator: function (v) {
          return v && v.length > 0;
        },
        message: 'At least one study day must be selected.',
      },
    },
    dailyTargetHours: {
      type: Number,
      min: 0,
      default: 4,
    },
    // Autonomous Workload Goal Engine
    goalType: {
      type: String,
      enum: ['topics', 'mcqs', 'hours', 'custom'],
      default: 'topics',
    },
    customGoalTitle: {
      type: String,
      default: '',
    },
    targetQuantity: {
      type: Number,
      min: 0,
      default: 0,
    },
    completedQuantity: {
      type: Number,
      min: 0,
      default: 0,
    },
    goalUnit: {
      type: String,
      default: 'Topics',
    },
    estimatedHoursPerTopic: {
      type: Number,
      min: 0,
      default: 1,
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'completed'],
      default: 'active',
    },
    isLockedByTeacher: {
      type: Boolean,
      default: false,
      index: true,
    },
    instructorNotes: {
      type: String,
      default: '',
    },
    assignedTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Auto-Pilot Smart Schedule: Maps specific subtopics to calendar dates
    dailySchedule: {
      type: [
        {
          date: { type: String, required: true }, // 'YYYY-MM-DD'
          subtopicIds: { type: [String], default: [] },
          subtopics: [
            {
              id: String,
              title: String,
              topicTitle: String,
              chapterName: String,
              subjectName: String,
              estimatedHours: { type: Number, min: 0, default: 1 },
            },
          ],
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

// Database indexing for fast lookup by user and exam
studyPlanSchema.index({ userId: 1, examId: 1 });
studyPlanSchema.index({ userId: 1, status: 1 });
studyPlanSchema.index({ assignedTeacherId: 1, isLockedByTeacher: 1 });

studyPlanSchema.index({ userId: 1, targetDate: 1 });
export default mongoose.model('StudyPlan', studyPlanSchema);


