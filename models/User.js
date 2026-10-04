import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      default: 'Aspirant',
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    avatar: {
      type: String,
      default: 'student',
    },
    accountMode: {
      type: String,
      enum: ['self_study', 'managed', 'teacher'],
      required: true,
      default: 'self_study',
    },
    role: {
      type: String,
      enum: ['student', 'teacher'],
      default: 'student',
    },
    teacherCode: {
      type: String,
      trim: true,
      uppercase: true,
      sparse: true,
    },
    assignedTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    cohortNotes: {
      type: String,
      default: '',
    },
    lastHeartbeatAt: {
      type: Date,
      default: null,
    },
    isCurrentlyStudying: {
      type: Boolean,
      default: false,
    },
    currentFocusTopic: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

// Indexes for fast cohort lookups, classmates radar, and teacherCode enrollment
userSchema.index({ assignedTeacherId: 1 });
userSchema.index({ teacherCode: 1 }, { sparse: true });
userSchema.index({ lastHeartbeatAt: -1, createdAt: -1 });

// Enforce permanent teacherCode once set
userSchema.pre('save', async function (next) {
  if (!this.isNew && this.isModified('teacherCode')) {
    const existing = await this.constructor.findById(this._id).select('teacherCode').lean();
    if (existing && existing.teacherCode && existing.teacherCode !== this.teacherCode) {
      const err = new Error(
        'Classroom invite code is permanent and cannot be changed once created.'
      );
      err.status = 400;
      return next(err);
    }
  }
  next();
});

// Pre-save hook to sync role and hash password
userSchema.pre('save', async function (next) {
  if (this.accountMode === 'teacher') {
    this.role = 'teacher';
  } else if (!this.role) {
    this.role = 'student';
  }

  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password || !enteredPassword) {
    return false;
  }
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);
