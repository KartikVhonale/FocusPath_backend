import mongoose from 'mongoose';

const classroomSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    classCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
      immutable: true, // Permanent once created: cannot be modified
    },
    students: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    activeExamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      default: null,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

// Enforce strict immutability: classCode cannot be changed once created
classroomSchema.pre('save', function (next) {
  if (!this.isNew && this.isModified('classCode')) {
    const err = new Error('Class code is permanent and cannot be changed once created.');
    err.status = 400;
    return next(err);
  }
  next();
});

classroomSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function (next) {
  const update = this.getUpdate();
  if (update) {
    if (update.classCode !== undefined || (update.$set && update.$set.classCode !== undefined)) {
      const err = new Error('Class code is permanent and cannot be changed once created.');
      err.status = 400;
      return next(err);
    }
  }
  next();
});

// Indexes for fast lookup
classroomSchema.index({ teacherId: 1, createdAt: -1 });

export default mongoose.model('Classroom', classroomSchema);
