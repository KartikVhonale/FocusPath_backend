import mongoose from 'mongoose';

const subtopicSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
});

const topicSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  subtopics: [subtopicSchema],
});

const chapterSchema = new mongoose.Schema({
  chapterName: {
    type: String,
    required: true,
    trim: true,
  },
  // Backward compatibility alias for title
  title: {
    type: String,
    trim: true,
  },
  estimatedHours: {
    type: Number,
    default: 2,
  },
  topics: [topicSchema],
});

// Auto-sync chapterName and title
chapterSchema.pre('validate', function () {
  if (this.chapterName && !this.title) {
    this.title = this.chapterName;
  } else if (this.title && !this.chapterName) {
    this.chapterName = this.title;
  }
});

const subjectSchema = new mongoose.Schema({
  subjectName: {
    type: String,
    required: true,
    trim: true,
  },
  // Backward compatibility alias for name
  name: {
    type: String,
    trim: true,
  },
  chapters: [chapterSchema],
  totalChapters: {
    type: Number,
    default: 0,
  },
});

// Auto-sync subjectName and name
subjectSchema.pre('validate', function () {
  if (this.subjectName && !this.name) {
    this.name = this.subjectName;
  } else if (this.name && !this.subjectName) {
    this.subjectName = this.name;
  }
});

const examSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
    },
    description: {
      type: String,
      default: '',
    },
    // Strictly follow 4-level deep structure:
    // subjects: [{ subjectName: String, chapters: [{ chapterName: String, topics: [{ title: String, subtopics: [{ title: String }] }] }] }]
    subjects: [subjectSchema],
    totalChapters: {
      type: Number,
      required: true,
      default: 0,
    },
    totalLeafNodes: {
      type: Number,
      default: 0,
    },
    tree: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },
  { timestamps: true }
);

export default mongoose.model('Exam', examSchema);
