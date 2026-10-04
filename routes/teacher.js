import express from 'express';
import User from '../models/User.js';
import Exam from '../models/Exam.js';
import StudyPlan from '../models/StudyPlan.js';
import DailyLog from '../models/DailyLog.js';
import Classroom from '../models/Classroom.js';
import { protect, authorizeRoles } from '../middleware/auth.js';
import { calculateTodayTarget, getTodayDateString } from '../utils/recalculate.js';
import { delCache } from '../utils/cache.js';

const router = express.Router();

// Strict RBAC: All teacher routes require authentication and teacher role
router.use(protect, authorizeRoles('teacher'));

// Helper: Generate unique 6-character uppercase alphanumeric code
function generateTeacherCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Middleware: Require teacher account mode
const requireTeacher = (req, res, next) => {
  if (req.user?.accountMode !== 'teacher') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Instructor permissions are required for this action.',
    });
  }
  next();
};

/**
 * 1. Generate Teacher Invite Code (Permanent once created)
 * POST /api/teacher/generate-code
 */
router.post('/generate-code', protect, requireTeacher, async (req, res) => {
  try {
    const teacher = await User.findById(req.user._id);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Instructor account not found.' });
    }

    // Class code / invite code is permanent once created and cannot be changed
    if (teacher.teacherCode) {
      return res.json({
        success: true,
        teacherCode: teacher.teacherCode,
        message: 'Your classroom code is permanent and already active.',
        isPermanent: true,
      });
    }

    let newCode = '';
    let isUnique = false;

    while (!isUnique) {
      newCode = generateTeacherCode();
      const existing = await User.findOne({ teacherCode: newCode });
      if (!existing || existing._id.toString() === req.user._id.toString()) {
        isUnique = true;
      }
    }

    teacher.teacherCode = newCode;
    await teacher.save();

    res.json({
      success: true,
      teacherCode: newCode,
      message: '🎉 Classroom code created successfully! This code is permanent.',
      isPermanent: true,
    });
  } catch (error) {
    console.error('Error generating teacher code:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to generate invite code', error: error.message });
  }
});

/**
 * 1b. Create New Classroom with Unique 6-character Alphanumeric Class Code
 * POST /api/teacher/create-class
 */
router.post('/create-class', protect, requireTeacher, async (req, res) => {
  try {
    const { name, examId, activeExamId, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Classroom name is required.' });
    }

    let classCode = '';
    let isUnique = false;
    while (!isUnique) {
      classCode = generateTeacherCode();
      const existing = await Classroom.findOne({ classCode });
      if (!existing) isUnique = true;
    }

    const classroom = await Classroom.create({
      name: name.trim(),
      teacherId: req.user._id,
      classCode,
      students: [],
      activeExamId: activeExamId || examId || null,
      description: (description || '').trim(),
    });

    const populated = await Classroom.findById(classroom._id)
      .populate('activeExamId', 'name code totalChapters')
      .lean();

    res.status(201).json({
      success: true,
      classroom: {
        ...populated,
        id: populated._id,
        studentsCount: 0,
        students: [],
      },
      classCode,
      message: `🎉 Classroom "${classroom.name}" created with code ${classCode}!`,
    });
  } catch (error) {
    console.error('Error creating classroom:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to create classroom', error: error.message });
  }
});

/**
 * 1c. Fetch Teacher's Classrooms with Detailed Student Rosters
 * GET /api/teacher/classrooms (and alias /classes)
 */
const getClassroomsHandler = async (req, res) => {
  try {
    const classrooms = await Classroom.find({ teacherId: req.user._id })
      .populate('activeExamId', 'name code totalChapters')
      .populate('students', 'username email avatar createdAt accountMode')
      .sort({ createdAt: -1 })
      .lean();

    const todayStr = getTodayDateString();

    const enrichedClassrooms = await Promise.all(
      classrooms.map(async (c) => {
        const studentRoster = [];

        for (const s of c.students || []) {
          const plan = await StudyPlan.findOne({ userId: s._id, status: 'active' })
            .populate('examId', 'name code')
            .lean();

          let progressPercent = 0;
          let todayCompleted = 0;
          let todayTarget = 0;
          let streak = 0;
          let lastActiveDate = 'Not started';

          if (plan) {
            progressPercent =
              plan.totalTopics > 0
                ? Math.round(((plan.completedTopics || 0) / plan.totalTopics) * 100)
                : 0;

            const calc = await calculateTodayTarget(plan);
            todayTarget = calc.todayTarget;

            const todayLog = await DailyLog.findOne({
              userId: s._id,
              studyPlanId: plan._id,
              date: todayStr,
            }).lean();
            if (todayLog) {
              todayCompleted = todayLog.topicsCompleted || 0;
            }

            const latestLog = await DailyLog.findOne({
              userId: s._id,
              studyPlanId: plan._id,
              topicsCompleted: { $gt: 0 },
            })
              .sort({ date: -1 })
              .lean();
            if (latestLog) {
              lastActiveDate = latestLog.date;
            }

            // Streak calculation
            const recentLogs = await DailyLog.find({ userId: s._id, studyPlanId: plan._id })
              .sort({ date: -1 })
              .limit(14)
              .lean();

            const now = new Date();
            for (let i = 0; i < recentLogs.length; i++) {
              const checkDate = new Date(now);
              checkDate.setDate(now.getDate() - i);
              const dateString = getTodayDateString(checkDate);
              const log = recentLogs.find((l) => l.date === dateString);
              if (i === 0 && (!log || (log.topicsCompleted === 0 && log.timeStudiedMinutes === 0)))
                continue;
              if (log && (log.topicsCompleted > 0 || log.timeStudiedMinutes >= 15)) {
                streak++;
              } else {
                break;
              }
            }
          }

          studentRoster.push({
            id: s._id,
            _id: s._id,
            username: s.username,
            email: s.email,
            avatar: s.avatar,
            enrolledAt: s.createdAt,
            hasPlan: !!plan,
            plan: plan
              ? {
                  examName: plan.examId?.name || 'Custom Exam',
                  targetDate: plan.targetDate,
                  totalTopics: plan.totalTopics,
                  completedTopics: plan.completedTopics || 0,
                  progressPercent,
                  todayTarget,
                  todayCompleted,
                  streak,
                  lastActiveDate,
                  isLockedByTeacher: plan.isLockedByTeacher,
                }
              : null,
          });
        }

        return {
          id: c._id,
          _id: c._id,
          name: c.name,
          classCode: c.classCode,
          description: c.description || '',
          activeExam: c.activeExamId,
          activeExamId: c.activeExamId?._id || c.activeExamId,
          studentsCount: studentRoster.length,
          students: studentRoster,
          createdAt: c.createdAt,
        };
      })
    );

    res.json({
      success: true,
      classrooms: enrichedClassrooms,
      totalCount: enrichedClassrooms.length,
    });
  } catch (error) {
    console.error('Error fetching classrooms:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch classrooms', error: error.message });
  }
};

router.get('/classrooms', protect, requireTeacher, getClassroomsHandler);
router.get('/classes', protect, requireTeacher, getClassroomsHandler);

/**
 * 2. Push Master StudyPlan to Cohort (Batch Update)
 * POST /api/teacher/assign-plan
 * Pushes exam template, target date, study days, and syllabus tree to all linked students in one batch,
 * setting isLockedByTeacher: true on those plans.
 */
router.post('/assign-plan', protect, requireTeacher, async (req, res) => {
  try {
    const { examId, targetDate, studyDays, selectedSubjects, instructorNotes } = req.body;

    if (!examId || !targetDate) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both target Exam and Target Date for the master plan.',
      });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Selected exam template not found' });
    }

    // Find all managed students linked to this teacher
    const students = await User.find({
      assignedTeacherId: req.user._id,
      accountMode: 'managed',
    }).select('_id username email');

    if (students.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          'No managed students currently enrolled in your cohort. Share your invite code with students first!',
      });
    }

    const days =
      studyDays && Array.isArray(studyDays) && studyDays.length > 0
        ? studyDays
        : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    // Calculate total topics based on selected subjects
    let totalTopics = exam.totalChapters || 0;
    if (selectedSubjects && Array.isArray(selectedSubjects) && selectedSubjects.length > 0) {
      const activeSubs = exam.subjects.filter((s) => selectedSubjects.includes(s.name));
      totalTopics = activeSubs.reduce((sum, s) => sum + (s.chapters?.length || 0), 0);
    }

    const todayStr = getTodayDateString();
    let updatedCount = 0;

    for (const student of students) {
      // Find or create active study plan
      let plan = await StudyPlan.findOne({ userId: student._id, status: 'active' });

      if (!plan) {
        plan = new StudyPlan({
          userId: student._id,
          examId: exam._id,
          targetDate,
          studyDays: days,
          selectedSubjects: selectedSubjects || [],
          totalTopics,
          completedTopics: 0,
          completedChapterIds: [],
          isLockedByTeacher: true,
          assignedTeacherId: req.user._id,
          instructorNotes: instructorNotes || req.user.cohortNotes || '',
          status: 'active',
        });
      } else {
        plan.examId = exam._id;
        plan.targetDate = targetDate;
        plan.studyDays = days;
        plan.selectedSubjects = selectedSubjects || [];
        plan.totalTopics = totalTopics;
        plan.isLockedByTeacher = true;
        plan.assignedTeacherId = req.user._id;
        if (instructorNotes) {
          plan.instructorNotes = instructorNotes.trim();
        }
      }

      await plan.save();

      // Invalidate target cache for the student
      delCache(`target:${student._id}:${todayStr}`);
      updatedCount++;
    }

    // Also update teacher's default cohort notes if provided
    if (instructorNotes) {
      await User.findByIdAndUpdate(req.user._id, { cohortNotes: instructorNotes.trim() });
    }

    res.json({
      success: true,
      message: `🎉 Successfully pushed master study plan to ${updatedCount} student${updatedCount === 1 ? '' : 's'}!`,
      count: updatedCount,
      examName: exam.name,
      totalTopics,
    });
  } catch (error) {
    console.error('Error assigning master plan:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign master study plan',
      error: error.message,
    });
  }
});

/**
 * 2b. Push Syllabus Update to specific classroom / classCode
 * POST /api/teacher/push-syllabus-update
 * Accepts: { classCode, examId }
 */
router.post('/push-syllabus-update', protect, requireTeacher, async (req, res) => {
  try {
    const { classCode, examId } = req.body;
    let query = { assignedTeacherId: req.user._id, accountMode: 'managed' };
    if (classCode) {
      query.teacherCode = classCode.toUpperCase();
    }

    const students = await User.find(query).select('_id username email');
    if (students.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: 'No students found enrolled in this classroom.' });
    }

    let exam = null;
    if (examId) {
      exam = await Exam.findById(examId);
    }
    if (!exam) {
      exam = await Exam.findOne().sort({ createdAt: -1 });
    }

    let syncedCount = 0;
    const todayStr = getTodayDateString();

    for (const student of students) {
      let plan = await StudyPlan.findOne({ userId: student._id, status: 'active' });
      if (plan) {
        if (exam) {
          plan.examId = exam._id;
          if (Array.isArray(exam.subjects) && exam.subjects.length > 0) {
            // Gather existing completed IDs and personal subtopics to avoid wiping out student progress
            const completedChapterIds = new Set((plan.completedChapterIds || []).map(String));
            const existingPersonalSubtopics = [];

            (plan.subjects || []).forEach((s) => {
              (s.chapters || []).forEach((c) => {
                (c.topics || []).forEach((t) => {
                  (t.subtopics || []).forEach((st) => {
                    const stObj = st.toObject ? st.toObject() : st;
                    if (stObj.isPersonal) {
                      existingPersonalSubtopics.push({
                        subjectName: s.name || s.subjectName,
                        chapterName: c.title || c.chapterName,
                        topicTitle: t.title,
                        subtopic: stObj,
                      });
                    }
                    if (stObj.isCompleted) {
                      const id = String(stObj.nodeId || stObj._id || stObj.id || '');
                      if (id) completedChapterIds.add(id);
                    }
                  });
                });
              });
            });

            // Map master exam subjects, preserving completed flags and personal subtopics
            const mergedSubjects = exam.subjects.map((subj) => {
              const subjObj = subj.toObject ? subj.toObject() : JSON.parse(JSON.stringify(subj));
              subjObj.chapters = (subjObj.chapters || []).map((ch) => {
                ch.topics = (ch.topics || []).map((top) => {
                  top.subtopics = (top.subtopics || []).map((st) => {
                    const stId = String(st.nodeId || st._id || st.id || '');
                    if (completedChapterIds.has(stId)) {
                      st.isCompleted = true;
                    }
                    return st;
                  });

                  // Re-attach student personal subtopics under matching topic
                  const matchingPersonal = existingPersonalSubtopics.filter(
                    (p) =>
                      p.subjectName === (subjObj.name || subjObj.subjectName) &&
                      p.chapterName === (ch.title || ch.chapterName) &&
                      p.topicTitle === top.title
                  );
                  matchingPersonal.forEach((p) => {
                    top.subtopics.push(p.subtopic);
                  });

                  return top;
                });
                return ch;
              });
              return subjObj;
            });

            plan.subjects = mergedSubjects;
            plan.completedChapterIds = Array.from(completedChapterIds);
            plan.completedTopics = plan.completedChapterIds.length;
            plan.totalTopics = exam.totalChapters || plan.totalTopics;
          }
        }
        plan.isLockedByTeacher = true;
        await plan.save();
        delCache(`target:${student._id}:${todayStr}`);
        syncedCount++;
      }
    }

    res.json({
      success: true,
      message: `⚡ Successfully pushed syllabus update to ${syncedCount} student${syncedCount === 1 ? '' : 's'} in class ${classCode || 'default'}!`,
      syncedCount,
    });
  } catch (error) {
    console.error('Error pushing syllabus update:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to push syllabus update', error: error.message });
  }
});

/**
 * 3. Update Cohort Instructor Notes & Guidance
 * POST /api/teacher/update-notes
 */
router.post('/update-notes', protect, requireTeacher, async (req, res) => {
  try {
    const { notes } = req.body;
    const cleanNotes = (notes || '').trim();

    await User.findByIdAndUpdate(req.user._id, { cohortNotes: cleanNotes });

    // Push updated notes to all active plans of linked students
    await StudyPlan.updateMany(
      { assignedTeacherId: req.user._id, status: 'active' },
      { instructorNotes: cleanNotes }
    );

    res.json({
      success: true,
      message: 'Cohort instructor notes updated successfully!',
      cohortNotes: cleanNotes,
    });
  } catch (error) {
    console.error('Error updating cohort notes:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to update cohort notes', error: error.message });
  }
});

/**
 * 4. Get Roster of Enrolled Students with Live Performance
 * GET /api/teacher/students
 */
router.get('/students', protect, requireTeacher, async (req, res) => {
  try {
    const students = await User.find({
      assignedTeacherId: req.user._id,
      accountMode: 'managed',
    })
      .select('username email createdAt updatedAt')
      .sort({ createdAt: -1 })
      .lean();

    const todayStr = getTodayDateString();
    const studentRoster = [];

    for (const s of students) {
      const plan = await StudyPlan.findOne({ userId: s._id, status: 'active' })
        .populate('examId', 'name code')
        .lean();

      let progressPercent = 0;
      let todayCompleted = 0;
      let todayTarget = 0;
      let streak = 0;
      let lastActiveDate = 'Not started';

      if (plan) {
        progressPercent =
          plan.totalTopics > 0
            ? Math.round(((plan.completedTopics || 0) / plan.totalTopics) * 100)
            : 0;

        const calc = await calculateTodayTarget(plan);
        todayTarget = calc.todayTarget;

        const todayLog = await DailyLog.findOne({
          userId: s._id,
          studyPlanId: plan._id,
          date: todayStr,
        }).lean();
        if (todayLog) {
          todayCompleted = todayLog.topicsCompleted || 0;
        }

        // Recent activity check
        const latestLog = await DailyLog.findOne({
          userId: s._id,
          studyPlanId: plan._id,
          topicsCompleted: { $gt: 0 },
        })
          .sort({ date: -1 })
          .lean();

        if (latestLog) {
          lastActiveDate = latestLog.date;
        }

        // Streak check
        const recentLogs = await DailyLog.find({ userId: s._id, studyPlanId: plan._id })
          .sort({ date: -1 })
          .limit(14)
          .lean();

        const now = new Date();
        for (let i = 0; i < recentLogs.length; i++) {
          const checkDate = new Date(now);
          checkDate.setDate(now.getDate() - i);
          const dateString = getTodayDateString(checkDate);
          const log = recentLogs.find((l) => l.date === dateString);
          if (i === 0 && (!log || (log.topicsCompleted === 0 && log.timeStudiedMinutes === 0)))
            continue;
          if (log && (log.topicsCompleted > 0 || log.timeStudiedMinutes >= 15)) {
            streak++;
          } else {
            break;
          }
        }
      }

      studentRoster.push({
        id: s._id,
        _id: s._id,
        username: s.username,
        email: s.email,
        enrolledAt: s.createdAt,
        hasPlan: !!plan,
        plan: plan
          ? {
              examName: plan.examId?.name || 'Custom Exam',
              targetDate: plan.targetDate,
              totalTopics: plan.totalTopics,
              completedTopics: plan.completedTopics || 0,
              progressPercent,
              todayTarget,
              todayCompleted,
              streak,
              lastActiveDate,
              isLockedByTeacher: plan.isLockedByTeacher,
            }
          : null,
      });
    }

    res.json({
      success: true,
      teacherCode: req.user.teacherCode || '',
      cohortNotes: req.user.cohortNotes || '',
      students: studentRoster,
      totalCount: studentRoster.length,
    });
  } catch (error) {
    console.error('Error fetching student roster:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch student roster', error: error.message });
  }
});

/**
 * 5. Teacher Overview Stats
 * GET /api/teacher/overview
 */
router.get('/overview', protect, requireTeacher, async (req, res) => {
  try {
    const studentsCount = await User.countDocuments({
      assignedTeacherId: req.user._id,
      accountMode: 'managed',
    });

    const activePlans = await StudyPlan.find({
      assignedTeacherId: req.user._id,
      status: 'active',
    }).lean();

    let totalCompleted = 0;
    let totalTopics = 0;

    for (const p of activePlans) {
      totalCompleted += p.completedTopics || 0;
      totalTopics += p.totalTopics || 0;
    }

    const cohortAveragePercent =
      totalTopics > 0 ? Math.round((totalCompleted / totalTopics) * 100) : 0;

    res.json({
      success: true,
      teacherCode: req.user.teacherCode || '',
      cohortNotes: req.user.cohortNotes || '',
      totalStudents: studentsCount,
      activePlansCount: activePlans.length,
      cohortAveragePercent,
    });
  } catch (error) {
    console.error('Error fetching teacher overview:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch overview', error: error.message });
  }
});

/**
 * 6. Override Student Daily Target & Directives (Slide-Over Drawer Action)
 * PUT /api/teacher/student/:studentId/override-target
 */
router.put('/student/:studentId/override-target', protect, requireTeacher, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { target, notes } = req.body;

    const student = await User.findOne({
      _id: studentId,
      assignedTeacherId: req.user._id,
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found in your cohort' });
    }

    const plan = await StudyPlan.findOne({ userId: studentId, status: 'active' });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'No active study plan for student' });
    }

    if (notes !== undefined) {
      plan.instructorNotes = String(notes || '').trim();
    }

    const todayStr = getTodayDateString();
    let todayLog = await DailyLog.findOne({
      userId: studentId,
      studyPlanId: plan._id,
      date: todayStr,
    });

    if (!todayLog) {
      todayLog = new DailyLog({
        userId: studentId,
        studyPlanId: plan._id,
        date: todayStr,
        topicsCompleted: 0,
        timeStudiedMinutes: 0,
        targetForDay: Number(target) || 0,
      });
    } else if (target !== undefined) {
      todayLog.targetForDay = Number(target);
    }

    if (notes !== undefined) {
      todayLog.notes = String(notes || '').trim();
    }

    await Promise.all([plan.save(), todayLog.save()]);

    // Invalidate cached target for student
    delCache(`target:${studentId}:${todayStr}`);

    res.json({
      success: true,
      message: 'Student target & directive updated successfully',
      target: todayLog.targetForDay,
      notes: plan.instructorNotes,
    });
  } catch (error) {
    console.error('Error overriding student target:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to update student target', error: error.message });
  }
});

/**
 * 7. Student Profile Deep Analytics
 * GET /api/teacher/student-profile/:studentId
 */
router.get('/student-profile/:studentId', protect, requireTeacher, async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await User.findOne({
      _id: studentId,
      assignedTeacherId: req.user._id,
    })
      .select('_id username email accountMode createdAt')
      .lean();

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found in your cohort' });
    }

    const plan = await StudyPlan.findOne({ userId: studentId, status: 'active' })
      .populate('examId')
      .lean();

    const logs = await DailyLog.find({ userId: studentId }).sort({ date: -1 }).limit(30).lean();

    const totalTopicsIn30Days = logs.reduce((sum, l) => sum + (l.topicsCompleted || 0), 0);
    const totalMinutesIn30Days = logs.reduce((sum, l) => sum + (l.timeStudiedMinutes || 0), 0);
    const activeDays = logs.filter(
      (l) => (l.topicsCompleted || 0) > 0 || (l.timeStudiedMinutes || 0) > 0
    ).length;

    const averageVelocity = activeDays > 0 ? +(totalTopicsIn30Days / activeDays).toFixed(1) : 0;
    const averageFocusTime = activeDays > 0 ? Math.round(totalMinutesIn30Days / activeDays) : 0;

    // Current Streak calculation
    let currentStreak = 0;
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      const checkDate = new Date(now);
      checkDate.setDate(now.getDate() - i);
      const dateString = getTodayDateString(checkDate);
      const log = logs.find((l) => l.date === dateString);
      if (i === 0 && (!log || (log.topicsCompleted === 0 && log.timeStudiedMinutes === 0)))
        continue;
      if (log && (log.topicsCompleted > 0 || log.timeStudiedMinutes >= 15)) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Last 7 days activity for dual-axis Line/Bar chart
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dateStr = getTodayDateString(d);
      const monthNames = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      const p = dateStr.split('-');
      const label = `${monthNames[parseInt(p[1], 10) - 1]} ${parseInt(p[2], 10)}`;
      const log = logs.find((l) => l.date === dateStr);
      last7Days.push({
        date: label,
        rawDate: dateStr,
        topicsCompleted: log?.topicsCompleted || 0,
        timeStudiedMinutes: log?.timeStudiedMinutes || 0,
        targetForDay: log?.targetForDay || plan?.todayTarget || 4,
      });
    }

    // Subject distribution for RadarChart
    const distribution = [];
    if (plan && plan.examId && plan.examId.subjects) {
      const completedSet = new Set((plan.completedChapterIds || []).map(String));
      plan.examId.subjects.forEach((subj) => {
        const chapters = subj.chapters || [];
        const completedInSubj = chapters.filter((c) => completedSet.has(String(c.id))).length;
        distribution.push({
          subject: subj.name,
          completed: completedInSubj,
          total: chapters.length || 1,
          minutes: Math.round(completedInSubj * 40 + 15),
        });
      });
    }

    res.json({
      success: true,
      student,
      plan,
      logs: logs.reverse(),
      last7Days,
      averageVelocity,
      averageFocusTime,
      currentStreak,
      distribution,
    });
  } catch (error) {
    console.error('Error fetching student profile:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch student profile', error: error.message });
  }
});

/**
 * 8. Real-Time Cohort Activity Feed
 * GET /api/teacher/activity-feed
 */
router.get('/activity-feed', protect, requireTeacher, async (req, res) => {
  try {
    const students = await User.find({
      assignedTeacherId: req.user._id,
      accountMode: 'managed',
    })
      .select('_id username email')
      .lean();

    if (students.length === 0) {
      return res.json({ success: true, activities: [] });
    }

    const studentMap = new Map(
      students.map((s) => [s._id.toString(), s.username || s.email.split('@')[0]])
    );
    const studentIds = students.map((s) => s._id);

    const recentLogs = await DailyLog.find({
      userId: { $in: studentIds },
      $or: [{ topicsCompleted: { $gt: 0 } }, { timeStudiedMinutes: { $gt: 0 } }],
    })
      .sort({ updatedAt: -1 })
      .limit(15)
      .lean();

    const activities = recentLogs.map((log) => {
      const studentName = studentMap.get(log.userId.toString()) || 'Student';
      let title = '';
      let type = 'completion';

      if (log.topicsCompleted > 0 && log.timeStudiedMinutes > 0) {
        title = `${studentName} completed ${log.topicsCompleted} topic${log.topicsCompleted === 1 ? '' : 's'} (${log.timeStudiedMinutes} mins)`;
      } else if (log.topicsCompleted > 0) {
        title = `${studentName} completed ${log.topicsCompleted} topic${log.topicsCompleted === 1 ? '' : 's'}`;
      } else {
        title = `${studentName} finished a ${log.timeStudiedMinutes}-minute focus session`;
        type = 'timer';
      }

      return {
        id: log._id,
        studentName,
        title,
        type,
        topicsCompleted: log.topicsCompleted,
        timeStudiedMinutes: log.timeStudiedMinutes,
        date: log.date,
        updatedAt: log.updatedAt || log.createdAt,
      };
    });

    res.json({
      success: true,
      activities,
    });
  } catch (error) {
    console.error('Error fetching activity feed:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch activity feed', error: error.message });
  }
});

/**
 * 9. Cohort Telemetry: Bottleneck Topics
 * GET /api/teacher/cohort-telemetry
 */
router.get('/cohort-telemetry', protect, requireTeacher, async (req, res) => {
  try {
    const students = await User.find({
      assignedTeacherId: req.user._id,
      accountMode: 'managed',
    })
      .select('_id username email')
      .lean();

    const totalEnrolled = students.length;
    if (totalEnrolled === 0) {
      return res.json({
        success: true,
        bottlenecks: [],
        cohortHealthScore: 100,
        totalEnrolled: 0,
      });
    }

    const studentIds = students.map((s) => s._id);
    const plans = await StudyPlan.find({
      userId: { $in: studentIds },
      status: 'active',
    })
      .populate('examId')
      .lean();

    const topicStats = new Map();

    plans.forEach((plan) => {
      if (!plan.examId || !plan.examId.subjects) return;
      const completedSet = new Set((plan.completedChapterIds || []).map(String));

      plan.examId.subjects.forEach((subj) => {
        (subj.chapters || []).forEach((ch) => {
          const id = String(ch.id || ch.title);
          if (!topicStats.has(id)) {
            topicStats.set(id, {
              topicId: id,
              title: ch.title,
              subjectName: subj.name,
              completedCount: 0,
              totalCohort: 0,
              estimatedHours: ch.estimatedHours || 2,
            });
          }
          const item = topicStats.get(id);
          item.totalCohort += 1;
          if (completedSet.has(id)) {
            item.completedCount += 1;
          }
        });
      });
    });

    const bottlenecks = [];
    topicStats.forEach((stat) => {
      const incompleteCount = stat.totalCohort - stat.completedCount;
      const stuckPercentage = Math.round((incompleteCount / Math.max(1, stat.totalCohort)) * 100);

      if (stuckPercentage >= 40) {
        bottlenecks.push({
          topicId: stat.topicId,
          title: stat.title,
          subjectName: stat.subjectName,
          stuckPercentage,
          completedCount: stat.completedCount,
          totalCohort: stat.totalCohort,
          avgMinutes: Math.round(stat.estimatedHours * 60 + 25),
        });
      }
    });

    bottlenecks.sort((a, b) => b.stuckPercentage - a.stuckPercentage);

    const highestStuck = bottlenecks[0]?.stuckPercentage || 15;
    const cohortHealthScore = Math.max(40, Math.min(100, Math.round(100 - highestStuck * 0.45)));

    res.json({
      success: true,
      bottlenecks: bottlenecks.slice(0, 5),
      cohortHealthScore,
      totalEnrolled,
    });
  } catch (error) {
    console.error('Error fetching cohort telemetry:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to analyze cohort telemetry',
      error: error.message,
    });
  }
});

export default router;
