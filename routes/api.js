import express from 'express';
import NodeCache from 'node-cache';
import Exam from '../models/Exam.js';
import User from '../models/User.js';
import StudyPlan from '../models/StudyPlan.js';
import DailyLog from '../models/DailyLog.js';
import Classroom from '../models/Classroom.js';
import {
  calculateTodayTarget,
  getTodayDateString,
  countCompletedLeafNodes,
  countLeafNodes,
} from '../utils/recalculate.js';
import { optionalAuth, protect } from '../middleware/auth.js';
import { getCache, setCache, delCache } from '../utils/cache.js';
import { scrapeExamSyllabus } from '../services/syllabusScraper.js';
import {
  scrapeUrlToTree,
  parseRawTextToTree,
  countLeafNodes as countScrapedLeafNodes,
  flattenTreeToSubjects,
} from '../services/urlScraper.js';
import { randomUUID } from 'crypto';

// Deep copy Exam subjects down to all 4 levels (Subject -> Chapter -> Topic -> Subtopic)
// Disconnects mutable student study plans from read-only master templates
export function deepCloneExamTree(examSubjects) {
  if (!Array.isArray(examSubjects)) return [];
  return examSubjects.map((subj, sIdx) => {
    const subjName = subj.subjectName || subj.name || `Subject ${sIdx + 1}`;
    return {
      subjectName: subjName,
      name: subjName,
      chapters: (subj.chapters || []).map((chap, cIdx) => {
        const chapName = chap.chapterName || chap.title || `Chapter ${cIdx + 1}`;
        return {
          chapterName: chapName,
          title: chapName,
          topics: (chap.topics || []).map((top, tIdx) => {
            const topTitle = top.title || `Topic ${tIdx + 1}`;
            return {
              title: topTitle,
              subtopics: (top.subtopics || []).map((sub, stIdx) => {
                const subTitle =
                  typeof sub === 'string' ? sub : sub.title || `Subtopic ${stIdx + 1}`;
                const subNodeId =
                  typeof sub === 'object' && sub.nodeId
                    ? sub.nodeId
                    : `${subjName}-${chapName}-${topTitle}-${subTitle}`;
                return {
                  title: subTitle,
                  nodeId: subNodeId,
                  isCompleted: (typeof sub === 'object' && sub.isCompleted) || false,
                  reviewCount: (typeof sub === 'object' && sub.reviewCount) || 0,
                  nextReviewDate: (typeof sub === 'object' && sub.nextReviewDate) || null,
                  lastReviewedAt: (typeof sub === 'object' && sub.lastReviewedAt) || null,
                };
              }),
            };
          }),
        };
      }),
    };
  });
}

const router = express.Router();

// 24-hour In-Memory Cache for Syllabus & Exams via node-cache
const examCache = new NodeCache({ stdTTL: 86400, checkperiod: 600, useClones: false });

// Helper to ensure a default user exists and return it
async function getOrCreateDefaultUser() {
  let user = await User.findOne();
  if (!user) {
    user = await User.create({
      username: 'Aspirant',
      email: 'aspirant@studytracker.app',
      password: 'password123',
    });
  }
  return user;
}

// Helper to resolve user from req (auth token) or fallback to default
async function resolveUser(req) {
  if (req.user) {
    return req.user;
  }
  return await getOrCreateDefaultUser();
}

/**
 * 1. Fetch all available exams
 * In-Memory Caching (node-cache): Caches syllabus list in Node.js memory for 24 hours.
 * Uses .lean() for fast plain JS object retrieval.
 */
router.get('/exams', async (req, res, next) => {
  try {
    const cacheKey = 'exams:all';
    const cachedExams = examCache.get(cacheKey);

    if (cachedExams) {
      return res.json({ success: true, exams: cachedExams, cached: true });
    }

    const exams = await Exam.find().sort({ name: 1 }).lean();
    examCache.set(cacheKey, exams, 86400);

    res.json({ success: true, exams, cached: false });
  } catch (error) {
    next(error);
  }
});

/**
 * 2. Fetch specific exam details
 * In-Memory Caching (node-cache) for 24 hours with .lean()
 */
router.get('/exams/:id', async (req, res, next) => {
  try {
    const cacheKey = `exam:${req.params.id}`;
    const cached = examCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, exam: cached, cached: true });
    }

    const exam = await Exam.findById(req.params.id).lean();
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }

    examCache.set(cacheKey, exam, 86400);
    res.json({ success: true, exam, cached: false });
  } catch (error) {
    next(error);
  }
});

/**
 * 3. Create or Update StudyPlan (Invalidates target cache)
 */
router.post('/study-plan', optionalAuth, async (req, res, next) => {
  try {
    const { examId, targetDate, studyDays, selectedSubjects } = req.body;
    const user = await resolveUser(req);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const exam = await Exam.findById(examId).lean();
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Selected exam not found' });
    }

    if (!targetDate) {
      return res.status(400).json({ success: false, message: 'Target date is required' });
    }

    // Senior Architect Feature: Calculate total topics based on user's selected subjects
    const subjectsList =
      Array.isArray(selectedSubjects) && selectedSubjects.length > 0 ? selectedSubjects : [];
    let totalTopics = exam.totalChapters || 0;

    if (subjectsList.length > 0) {
      const activeSubjects = (exam.subjects || []).filter(
        (s) => subjectsList.includes(s.name) || subjectsList.includes(s._id?.toString())
      );
      const activeCount = activeSubjects.reduce(
        (sum, s) => sum + (s.chapters?.length || s.totalChapters || 0),
        0
      );
      if (activeCount > 0) totalTopics = activeCount;
    }

    // Perform deep copy of Exam tree into user's StudyPlan document (disconnecting from read-only master template)
    const clonedSubjects = deepCloneExamTree(exam.subjects || []);
    const leafNodesCount = countLeafNodes(clonedSubjects);
    if (leafNodesCount > 0) {
      totalTopics = leafNodesCount;
    }

    let plan = await StudyPlan.findOne({ userId: user._id, status: 'active' });

    if (plan) {
      if (plan.isLockedByTeacher && user.accountMode !== 'teacher') {
        return res.status(403).json({
          success: false,
          message: '🔒 This study plan is managed and locked by your instructor.',
        });
      }
      plan.examId = exam._id;
      plan.targetDate = new Date(targetDate);
      plan.totalTopics = totalTopics;
      plan.selectedSubjects = subjectsList;
      if (
        !Array.isArray(plan.subjects) ||
        plan.subjects.length === 0 ||
        plan.examId.toString() !== examId.toString()
      ) {
        plan.subjects = clonedSubjects;
        plan.completedTopics = 0;
        plan.completedChapterIds = [];
      }
      if (studyDays && Array.isArray(studyDays)) {
        plan.studyDays = studyDays;
      }
      await plan.save();
    } else {
      plan = await StudyPlan.create({
        userId: user._id,
        examId: exam._id,
        targetDate: new Date(targetDate),
        subjects: clonedSubjects,
        totalTopics,
        completedTopics: 0,
        completedChapterIds: [],
        selectedSubjects: subjectsList,
        studyDays:
          studyDays && studyDays.length > 0
            ? studyDays
            : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      });
    }

    await plan.populate('examId');

    // Invalidate cached target for this user
    const todayStr = getTodayDateString();
    delCache(`target:${user._id}:${todayStr}`);

    res.status(201).json({
      success: true,
      message: 'Study plan configured successfully',
      plan,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 3. AUTO-PILOT SCHEDULER (Zero Friction Onboarding)
 * POST /api/study-plan/auto-schedule
 * Takes target exam date, selected "Days Off" (e.g., Sundays), and 4-level deep totalLeafNodes.
 * Automatically maps a specific array of topicIds to every single date on the calendar.
 */
router.post('/study-plan/auto-schedule', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { examId, targetDate: inputTargetDate, daysOff = ['Sun'], vacationDates = [] } = req.body;

    // 1. Resolve Exam
    let exam = null;
    if (examId) {
      exam = await Exam.findById(examId);
    }
    if (!exam) {
      const existingPlan = await StudyPlan.findOne({ userId: user._id });
      if (existingPlan?.examId) {
        exam = await Exam.findById(existingPlan.examId);
      }
    }
    if (!exam) {
      exam =
        (await Exam.findOne({ code: 'gate-cs' })) ||
        (await Exam.findOne({ totalLeafNodes: { $gt: 0 } })) ||
        (await Exam.findOne());
    }
    if (!exam) {
      return res.status(404).json({ success: false, message: 'No exam found to schedule.' });
    }

    // 2. Resolve Target Date (Default 180 days from now if not provided)
    const targetDateObj = inputTargetDate
      ? new Date(inputTargetDate)
      : new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);

    // 3. Clone 4-Level Syllabus Tree
    const clonedSubjects = deepCloneExamTree(exam.subjects || []);

    // 4. Extract Linear Sequence of Atomic Leaf Nodes (Subtopics)
    const leafNodes = [];
    clonedSubjects.forEach((subject, sIdx) => {
      const subjName = subject.subjectName || subject.name || `Subject ${sIdx + 1}`;
      (subject.chapters || []).forEach((chapter, cIdx) => {
        const chapName = chapter.chapterName || chapter.title || `Chapter ${cIdx + 1}`;
        if (Array.isArray(chapter.topics) && chapter.topics.length > 0) {
          chapter.topics.forEach((topic, tIdx) => {
            const topTitle = topic.title || `Topic ${tIdx + 1}`;
            if (Array.isArray(topic.subtopics) && topic.subtopics.length > 0) {
              topic.subtopics.forEach((subtopic, stIdx) => {
                const subTitle =
                  typeof subtopic === 'string'
                    ? subtopic
                    : subtopic.title || `Subtopic ${stIdx + 1}`;
                const subId = `${subjName}-${chapName}-${topTitle}-${subTitle}`;
                if (typeof subtopic === 'object') subtopic.nodeId = subId;
                leafNodes.push({
                  id: subId,
                  nodeId: subId,
                  title: subTitle,
                  topicTitle: topTitle,
                  chapterName: chapName,
                  subjectName: subjName,
                  estimatedHours: 1,
                });
              });
            } else {
              const fallbackId = `${subjName}-${chapName}-${topTitle}`;
              leafNodes.push({
                id: fallbackId,
                nodeId: fallbackId,
                title: topTitle,
                topicTitle: topTitle,
                chapterName: chapName,
                subjectName: subjName,
                estimatedHours: 1,
              });
            }
          });
        } else {
          const chapId = `${subjName}-${chapName}`;
          leafNodes.push({
            id: chapId,
            nodeId: chapId,
            title: chapName,
            chapterName: chapName,
            subjectName: subjName,
            estimatedHours: 2,
          });
        }
      });
    });

    const totalLeafNodes = leafNodes.length;

    // 5. Compute Valid Calendar Study Days from today until targetDateObj
    const allDaysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const activeStudyDays = allDaysOfWeek.filter((d) => !daysOff.includes(d));
    const vacationSet = new Set(
      (vacationDates || []).map((v) => new Date(v).toISOString().slice(0, 10))
    );

    const validCalendarDays = [];
    const iter = new Date();
    iter.setHours(0, 0, 0, 0);

    const endLimit = new Date(targetDateObj);
    endLimit.setHours(23, 59, 59, 999);

    while (iter <= endLimit) {
      const dateStr = iter.toISOString().slice(0, 10);
      const dayName = allDaysOfWeek[iter.getDay()];

      // If not a day off and not in vacation
      if (activeStudyDays.includes(dayName) && !vacationSet.has(dateStr)) {
        validCalendarDays.push(dateStr);
      }
      iter.setDate(iter.getDate() + 1);
    }

    if (validCalendarDays.length === 0) {
      // Fallback: at least include today
      validCalendarDays.push(new Date().toISOString().slice(0, 10));
    }

    // 6. Map Specific Subtopics to Every Single Date on the Calendar
    const totalDays = validCalendarDays.length;
    const dailySchedule = [];

    for (let i = 0; i < totalDays; i++) {
      const startIdx = Math.floor((i * totalLeafNodes) / totalDays);
      const endIdx = Math.floor(((i + 1) * totalLeafNodes) / totalDays);
      const dayLeaves = leafNodes.slice(startIdx, endIdx);

      dailySchedule.push({
        date: validCalendarDays[i],
        subtopicIds: dayLeaves.map((l) => l.id),
        subtopics: dayLeaves,
      });
    }

    // 7. Persist or Upsert Study Plan
    let plan = await StudyPlan.findOne({ userId: user._id, status: 'active' });
    if (!plan) {
      plan = await StudyPlan.findOne({ userId: user._id });
    }

    const allSubjectNames = clonedSubjects.map((s) => s.subjectName || s.name);

    if (plan) {
      plan.examId = exam._id;
      plan.targetDate = targetDateObj;
      plan.subjects = clonedSubjects;
      plan.totalTopics = totalLeafNodes;
      plan.totalLeafNodes = totalLeafNodes;
      plan.completedTopics = 0;
      plan.completedChapterIds = [];
      plan.studyDays =
        activeStudyDays.length > 0 ? activeStudyDays : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      plan.selectedSubjects = allSubjectNames;
      plan.vacationDates = (vacationDates || []).map((d) => new Date(d));
      plan.dailySchedule = dailySchedule;
      plan.status = 'active';
      await plan.save();
    } else {
      plan = await StudyPlan.create({
        userId: user._id,
        examId: exam._id,
        targetDate: targetDateObj,
        subjects: clonedSubjects,
        totalTopics: totalLeafNodes,
        totalLeafNodes: totalLeafNodes,
        completedTopics: 0,
        completedChapterIds: [],
        studyDays:
          activeStudyDays.length > 0 ? activeStudyDays : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        selectedSubjects: allSubjectNames,
        vacationDates: (vacationDates || []).map((d) => new Date(d)),
        dailySchedule,
        status: 'active',
      });
    }

    await plan.populate('examId');

    // Invalidate cached calculations
    const todayStr = getTodayDateString();
    delCache(`target:${user._id}:${todayStr}`);

    res.status(200).json({
      success: true,
      message: '🚀 Auto-Pilot Smart Schedule generated successfully!',
      plan,
      summary: {
        examName: exam.name,
        targetDate: targetDateObj.toISOString().slice(0, 10),
        totalStudyDays: validCalendarDays.length,
        totalSubtopics: totalLeafNodes,
        avgTopicsPerDay: Math.ceil(totalLeafNodes / (validCalendarDays.length || 1)),
        todayScheduledCount: dailySchedule[0]?.subtopics?.length || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 3a-1. Toggle Study Plan Pause / Active Status
 * POST /api/study-plan/toggle-pause
 */
router.post('/study-plan/toggle-pause', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({
      userId: user._id,
      status: { $in: ['active', 'paused'] },
    });
    if (!plan) {
      return res
        .status(404)
        .json({ success: false, message: 'No active or paused study plan found' });
    }

    plan.status = plan.status === 'paused' ? 'active' : 'paused';
    await plan.save();

    const todayStr = getTodayDateString();
    delCache(`target:${user._id}:${todayStr}`);

    res.json({
      success: true,
      status: plan.status,
      message:
        plan.status === 'paused' ? 'Study plan has been paused' : 'Study plan has been resumed',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 3a-2. Recalculate Daily Schedule and Target Pace
 * POST /api/study-plan/recalculate
 */
router.post('/study-plan/recalculate', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({
      userId: user._id,
      status: { $in: ['active', 'paused'] },
    });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'No active study plan found' });
    }

    const todayStr = getTodayDateString();
    delCache(`target:${user._id}:${todayStr}`);

    const calculation = await calculateTodayTarget(plan);
    setCache(`target:${user._id}:${todayStr}`, calculation, 3600);

    res.json({
      success: true,
      message: 'Adaptive schedule and targets recalculated successfully',
      calculation,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 3b. Update Subject Setup per User (Senior Architect Feature)
 * Allows customizing which specific exam subjects are included in daily goals
 */
router.put('/study-plan/subjects', optionalAuth, async (req, res, next) => {
  try {
    const { studyPlanId, selectedSubjects } = req.body;
    const user = await resolveUser(req);

    let plan = studyPlanId
      ? await StudyPlan.findById(studyPlanId).populate('examId')
      : await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Active study plan not found' });
    }

    if (plan.isLockedByTeacher && user.accountMode !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: '🔒 Curriculum subjects are managed and locked by your instructor.',
      });
    }

    const exam = plan.examId;
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam attached to plan not found' });
    }

    const subs = Array.isArray(selectedSubjects) ? selectedSubjects : [];
    plan.selectedSubjects = subs;

    if (subs.length > 0) {
      const activeSubjects = (exam.subjects || []).filter(
        (s) => subs.includes(s.name) || subs.includes(s._id?.toString())
      );
      const activeTotal = activeSubjects.reduce(
        (sum, s) => sum + (s.chapters?.length || s.totalChapters || 0),
        0
      );
      plan.totalTopics = activeTotal > 0 ? activeTotal : exam.totalChapters;

      // Filter completed chapter count to only active subjects
      const activeChapterIds = new Set();
      activeSubjects.forEach((s) => (s.chapters || []).forEach((c) => activeChapterIds.add(c.id)));
      plan.completedTopics = (plan.completedChapterIds || []).filter((id) =>
        activeChapterIds.has(id)
      ).length;
    } else {
      plan.totalTopics = exam.totalChapters;
      plan.completedTopics = (plan.completedChapterIds || []).length;
    }

    await plan.save();

    const todayStr = getTodayDateString();
    delCache(`target:${user._id}:${todayStr}`);

    const calculation = await calculateTodayTarget(plan);
    setCache(`target:${user._id}:${todayStr}`, calculation, 3600);

    res.json({
      success: true,
      message: 'Subject setup updated successfully',
      plan,
      calculation,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 4. Get active study plan (Read-Only query with .lean())
 */
router.get('/study-plan/current', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' })
      .populate('examId')
      .populate('userId', 'username email')
      .lean();

    if (!plan) {
      return res.json({ success: true, plan: null });
    }

    const calculation = await calculateTodayTarget(plan);

    res.json({
      success: true,
      plan,
      calculation,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Utility: Find the first N atomic leaf nodes where isCompleted === false chronologically
 */
function getUpNextQueue(plan, exam, limit = 3) {
  if (!plan || !exam) return [];
  const completedSet = new Set((plan.completedChapterIds || []).map(String));
  const activeSubjectNames =
    plan.selectedSubjects && plan.selectedSubjects.length > 0
      ? plan.selectedSubjects
      : (exam.subjects || []).map((s) => s.subjectName || s.name);

  const queue = [];

  // Check 4-Level Deep Nested Hierarchy (Subject -> Chapter -> Topic -> Subtopic)
  const subjectsSource =
    Array.isArray(plan.subjects) && plan.subjects.length > 0
      ? plan.subjects
      : Array.isArray(exam.subjects) && exam.subjects.length > 0
        ? exam.subjects
        : [];

  for (const subject of subjectsSource) {
    if (queue.length >= limit) break;
    const subjName = subject.subjectName || subject.name || 'Subject';
    if (
      activeSubjectNames.length > 0 &&
      !activeSubjectNames.includes(subjName) &&
      !activeSubjectNames.includes(subject.name)
    )
      continue;

    for (const chapter of subject.chapters || []) {
      if (queue.length >= limit) break;
      const chName = chapter.chapterName || chapter.title || 'Chapter';

      if (Array.isArray(chapter.topics) && chapter.topics.length > 0) {
        for (const topic of chapter.topics) {
          if (queue.length >= limit) break;
          const topTitle = topic.title || 'Topic';

          if (Array.isArray(topic.subtopics) && topic.subtopics.length > 0) {
            for (const subtopic of topic.subtopics) {
              if (queue.length >= limit) break;
              const subId = String(
                subtopic.nodeId ||
                  subtopic._id ||
                  subtopic.id ||
                  `${subjName}-${chName}-${topTitle}-${subtopic.title}`
              );
              if (!completedSet.has(subId) && !subtopic.isCompleted) {
                if (!queue.some((item) => item.id === subId)) {
                  queue.push({
                    id: subId,
                    nodeId: subId,
                    title: subtopic.title,
                    topicTitle: topTitle,
                    chapterName: chName,
                    subjectName: subjName,
                    estimatedHours: 1,
                  });
                }
              }
            }
          } else {
            const topId = String(topic.id || topic._id || `${subjName}-${chName}-${topTitle}`);
            if (!completedSet.has(topId) && !topic.isCompleted) {
              if (!queue.some((item) => item.id === topId)) {
                queue.push({
                  id: topId,
                  nodeId: topId,
                  title: topTitle,
                  chapterName: chName,
                  subjectName: subjName,
                  estimatedHours: 1,
                });
              }
            }
          }
        }
      } else {
        const chapterId = String(chapter.id || chapter._id || `${subjName}-ch-${chName}`);
        if (!completedSet.has(chapterId)) {
          if (!queue.some((item) => item.id === chapterId)) {
            queue.push({
              id: chapterId,
              nodeId: chapterId,
              title: chapter.title || chName,
              subjectName: subjName,
              estimatedHours: chapter.estimatedHours || 2,
            });
          }
        }
      }
    }
  }

  return queue.slice(0, limit);
}

/**
 * Spaced Repetition System (SRS) Utility:
 * Find nodes due for review (where nextReviewDate <= endOfToday)
 */
function getReviewQueue(plan, exam, limit = 5) {
  if (!plan || !exam) return [];
  const completedSet = new Set((plan.completedChapterIds || []).map(String));
  if (completedSet.size === 0) return [];

  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const chapterMap = new Map();
  const subjectsSource =
    Array.isArray(plan.subjects) && plan.subjects.length > 0
      ? plan.subjects
      : Array.isArray(exam.subjects) && exam.subjects.length > 0
        ? exam.subjects
        : [];

  subjectsSource.forEach((subj) => {
    const subjName = subj.subjectName || subj.name || 'Subject';
    (subj.chapters || []).forEach((ch) => {
      const chName = ch.chapterName || ch.title || 'Chapter';
      if (Array.isArray(ch.topics) && ch.topics.length > 0) {
        ch.topics.forEach((top) => {
          if (Array.isArray(top.subtopics) && top.subtopics.length > 0) {
            top.subtopics.forEach((st) => {
              const subId = String(
                st.nodeId || st._id || st.id || `${subjName}-${chName}-${top.title}-${st.title}`
              );
              chapterMap.set(subId, {
                title: st.title,
                topicTitle: top.title,
                chapterName: chName,
                subjectName: subjName,
                estimatedHours: 1,
              });
            });
          } else {
            const topId = String(top.id || top._id || `${subjName}-${chName}-${top.title}`);
            chapterMap.set(topId, {
              title: top.title,
              chapterName: chName,
              subjectName: subjName,
              estimatedHours: 1,
            });
          }
        });
      } else {
        chapterMap.set(String(ch.id || `${subjName}-ch-${chName}`), {
          title: ch.title || chName,
          subjectName: subjName,
          estimatedHours: ch.estimatedHours || 1,
        });
      }
    });
  });

  const reviews = Array.isArray(plan.nodeReviews) ? plan.nodeReviews : [];
  const reviewMap = new Map(reviews.map((r) => [String(r.nodeId), r]));
  const dueQueue = [];

  // 1. Check existing nodeReviews due on or before today
  for (const review of reviews) {
    if (dueQueue.length >= limit) break;
    const reviewDate = review.nextReviewDate ? new Date(review.nextReviewDate) : null;
    if (reviewDate && reviewDate <= endOfToday && completedSet.has(String(review.nodeId))) {
      const meta = chapterMap.get(String(review.nodeId));
      dueQueue.push({
        id: String(review.nodeId),
        nodeId: String(review.nodeId),
        title: review.title || meta?.title || 'Review Topic',
        topicTitle: meta?.topicTitle,
        chapterName: meta?.chapterName,
        subjectName: review.subjectName || meta?.subjectName || 'General',
        reviewCount: review.reviewCount || 1,
        nextReviewDate: review.nextReviewDate,
        estimatedHours: meta?.estimatedHours || 1,
        isReview: true,
      });
    }
  }

  // 2. If fewer than 2 due reviews, also pull in earlier completed chapters for SRS refresh
  if (dueQueue.length < 2) {
    for (const completedId of completedSet) {
      if (dueQueue.length >= limit) break;
      if (!reviewMap.has(String(completedId))) {
        const meta = chapterMap.get(String(completedId));
        if (meta && !dueQueue.some((item) => item.id === String(completedId))) {
          dueQueue.push({
            id: String(completedId),
            nodeId: String(completedId),
            title: meta.title,
            topicTitle: meta.topicTitle,
            chapterName: meta.chapterName,
            subjectName: meta.subjectName,
            reviewCount: 0,
            nextReviewDate: new Date(),
            estimatedHours: meta.estimatedHours || 1,
            isReview: true,
          });
        }
      }
    }
  }

  return dueQueue.slice(0, limit);
}

/**
 * Utility: Extract metadata for topics completed today
 */
function getTodayCompletedTopics(plan, exam, todayLog) {
  if (
    !todayLog ||
    !Array.isArray(todayLog.completedTopicIds) ||
    todayLog.completedTopicIds.length === 0
  ) {
    return [];
  }
  const idSet = new Set(todayLog.completedTopicIds.map(String));
  const result = [];
  const foundIds = new Set();

  const subjectsSource =
    Array.isArray(plan?.subjects) && plan.subjects.length > 0
      ? plan.subjects
      : Array.isArray(exam?.subjects) && exam.subjects.length > 0
        ? exam.subjects
        : [];

  for (const subject of subjectsSource) {
    const subjName = subject.subjectName || subject.name || 'Subject';
    for (const chapter of subject.chapters || []) {
      const chName = chapter.chapterName || chapter.title || 'Chapter';
      for (const topic of chapter.topics || []) {
        const topTitle = topic.title || 'Topic';
        for (const subtopic of topic.subtopics || []) {
          const subId = String(
            subtopic.nodeId ||
              subtopic._id ||
              subtopic.id ||
              `${subjName}-${chName}-${topTitle}-${subtopic.title}`
          );
          if (idSet.has(subId) && !foundIds.has(subId)) {
            foundIds.add(subId);
            result.push({
              id: subId,
              nodeId: subId,
              title: subtopic.title,
              topicTitle: topTitle,
              chapterName: chName,
              subjectName: subjName,
            });
          }
        }
        const topId = String(topic.id || topic._id || `${subjName}-${chName}-${topTitle}`);
        if (idSet.has(topId) && !foundIds.has(topId)) {
          foundIds.add(topId);
          result.push({
            id: topId,
            nodeId: topId,
            title: topTitle,
            chapterName: chName,
            subjectName: subjName,
          });
        }
      }
      const chId = String(chapter.id || chapter._id || `${subjName}-ch-${chName}`);
      if (idSet.has(chId) && !foundIds.has(chId)) {
        foundIds.add(chId);
        result.push({
          id: chId,
          nodeId: chId,
          title: chapter.title || chName,
          chapterName: chName,
          subjectName: subjName,
        });
      }
    }
  }

  // Any remaining IDs in today's log that weren't resolved by hierarchy
  for (const id of todayLog.completedTopicIds) {
    const idStr = String(id);
    if (!foundIds.has(idStr)) {
      result.push({
        id: idStr,
        nodeId: idStr,
        title: idStr.split('-').pop() || idStr,
        chapterName: 'General',
        subjectName: 'General',
      });
    }
  }

  return result;
}

/**
 * 5. Dashboard Data:
 * - Lean queries (.lean()) for instant Mongoose read speeds
 * - In-Memory Target Caching
 * - Query Pagination: Limits DailyLog history query to last 7 days (.limit(7))
 * - Up Next Queue: Chronological atomic leaf nodes to be studied
 */
router.get('/dashboard', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    // Lean query for read-only active study plan
    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' })
      .populate('examId')
      .lean();

    if (!plan) {
      return res.json({
        success: true,
        hasPlan: false,
        message: 'No active study plan. Please setup a plan first.',
      });
    }

    const todayStr = getTodayDateString();

    // Check today's log (or initialize if new day)
    let todayLog = await DailyLog.findOne({
      userId: user._id,
      studyPlanId: plan._id,
      date: todayStr,
    });

    if (!todayLog) {
      todayLog = await DailyLog.create({
        userId: user._id,
        studyPlanId: plan._id,
        date: todayStr,
        topicsCompleted: 0,
        timeStudiedMinutes: 0,
        targetForDay: 0,
      });
    }

    // Check In-Memory Cache for target calculation
    const cacheKey = `target:${user._id}:${todayStr}`;
    let calculation = getCache(cacheKey);

    if (!calculation) {
      calculation = await calculateTodayTarget(plan);
      // Cache calculation in memory for 1 hour (3600s)
      setCache(cacheKey, calculation, 3600);
    }

    // Save target for today in the log for historical tracking if changed
    if (todayLog.targetForDay !== calculation.todayTarget) {
      todayLog.targetForDay = calculation.todayTarget;
      await todayLog.save();
    }

    // Query Optimization: Limit to last 7 days of logs + .lean() to prevent massive database reads
    const recentLogs = await DailyLog.find({
      userId: user._id,
      studyPlanId: plan._id,
    })
      .sort({ date: -1 })
      .limit(7)
      .lean();

    // Calculate streak from recent logs
    let streak = 0;
    const now = new Date();
    for (let i = 0; i < recentLogs.length; i++) {
      const checkDate = new Date(now);
      checkDate.setDate(now.getDate() - i);
      const dateString = getTodayDateString(checkDate);
      const log = recentLogs.find((l) => l.date === dateString);

      if (i === 0 && (!log || (log.topicsCompleted === 0 && log.timeStudiedMinutes === 0))) {
        continue;
      }

      if (log && (log.topicsCompleted > 0 || log.timeStudiedMinutes >= 15)) {
        streak++;
      } else {
        break;
      }
    }

    // Fetch Yesterday's log for missed tasks and reflection
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(now.getDate() - 1);
    const yesterdayStr = getTodayDateString(yesterdayDate);

    const yesterdayLog = await DailyLog.findOne({
      userId: user._id,
      studyPlanId: plan._id,
      date: yesterdayStr,
    }).lean();

    const yesterdayTarget = yesterdayLog?.targetForDay || 0;
    const yesterdayCompleted = yesterdayLog?.topicsCompleted || 0;
    const yesterdayMissedCount = Math.max(0, yesterdayTarget - yesterdayCompleted);

    const yesterdayReview = {
      date: yesterdayStr,
      targetForDay: yesterdayTarget,
      topicsCompleted: yesterdayCompleted,
      timeStudiedMinutes: yesterdayLog?.timeStudiedMinutes || 0,
      missedCount: yesterdayMissedCount,
      isFullyCompleted: yesterdayLog ? yesterdayCompleted >= (yesterdayTarget || 1) : false,
      completedTopicIds: yesterdayLog?.completedTopicIds || [],
      missedTopicIds: yesterdayLog?.missedTopicIds || [],
    };

    // 6-Month Study Streak Heatmap Activity Data (180 days)
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setDate(now.getDate() - 180);
    const sixMonthsDateStr = getTodayDateString(sixMonthsAgo);

    const heatmapLogs = await DailyLog.find({
      userId: user._id,
      studyPlanId: plan._id,
      date: { $gte: sixMonthsDateStr },
    })
      .select('date topicsCompleted timeStudiedMinutes')
      .lean();

    const heatmapData = heatmapLogs.map((l) => ({
      date: l.date,
      count: l.topicsCompleted || 0,
      minutes: l.timeStudiedMinutes || 0,
    }));

    // Calculate next atomic topics to study chronologically
    const upNextQueue = getUpNextQueue(plan, plan.examId, 3);
    const reviewQueue = getReviewQueue(plan, plan.examId, 5);
    const todayCompletedTopics = getTodayCompletedTopics(plan, plan.examId, todayLog);

    res.json({
      success: true,
      hasPlan: true,
      data: {
        studyPlanId: plan._id,
        examName: plan.examId?.name || 'Exam',
        examCode: plan.examId?.code || '',
        targetDate: plan.targetDate,
        studyDays: plan.studyDays,
        todayTarget: calculation.todayTarget,
        activeStudyDayPace: calculation.activeStudyDayPace,
        todayCompleted: todayLog.topicsCompleted,
        timeStudiedMinutes: todayLog.timeStudiedMinutes,
        totalCompleted: plan.completedTopics || 0,
        totalTopics: plan.totalTopics,
        remainingTopics: calculation.remainingTopics,
        remainingValidDays: calculation.remainingValidDays,
        isStudyDay: calculation.isStudyDay,
        daysUntilExam: calculation.daysUntilExam,
        streak,
        completedChapterIds: plan.completedChapterIds || [],
        selectedSubjects: plan.selectedSubjects || [],
        recentLogs: recentLogs || [],
        isLockedByTeacher: Boolean(plan.isLockedByTeacher || user.accountMode === 'managed'),
        instructorNotes: plan.instructorNotes || user.cohortNotes || '',
        accountMode: user.accountMode || 'self_study',
        teacherCode: user.teacherCode || '',
        assignedTeacherId: user.assignedTeacherId || null,
        upNextQueue,
        upNext: upNextQueue[0] || null,
        reviewQueue,
        todayCompletedTopics,
        todayCompletedTopicIds: todayLog.completedTopicIds || [],
        todaySessions: todayLog.sessions || [],
        yesterdayReview,
        yesterdayMissedCount,
        heatmapData,
        // Hybrid Planner & Tracker DNA
        dailyTargetHours: Number(plan.dailyTargetHours) || 4,
        goalType: calculation.goalType || 'topics',
        customGoalTitle: calculation.customGoalTitle || '',
        goalUnit: calculation.goalUnit || 'Topics',
        targetQuantity: calculation.targetQuantity || plan.totalTopics,
        completedQuantity: calculation.completedQuantity || plan.completedTopics || 0,
        remainingQuantity: calculation.remainingQuantity || calculation.remainingTopics,
        dailyTargetQuantity: calculation.dailyTargetQuantity || calculation.todayTarget,
        isSafeModeExceeded: Boolean(calculation.isSafeModeExceeded),
        safeModeWarning: calculation.safeModeWarning || null,
        safeModeSuggestions: calculation.safeModeSuggestions || [],
        subjectWorkloads: calculation.subjectWorkloads || [],
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 5b. Spaced Repetition (SRS) Node Toggle & Review Endpoint
 * Implements SRS Multiplier: 1st review in 3 days, 2nd in 7 days, 3rd+ in 21 days
 * Supports 'complete', 'review', and 'snooze' (iOS swipe actions)
 * POST /api/study-plan/toggle-node
 */
router.post('/study-plan/toggle-node', optionalAuth, async (req, res, next) => {
  try {
    const { studyPlanId, nodeId, isCompleted, action } = req.body;
    const user = await resolveUser(req);

    let plan = studyPlanId
      ? await StudyPlan.findById(studyPlanId).populate('examId')
      : await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Study plan not found' });
    }

    const todayStr = getTodayDateString();
    let todayLog = await DailyLog.findOne({
      userId: user._id,
      studyPlanId: plan._id,
      date: todayStr,
    });

    if (!todayLog) {
      todayLog = await DailyLog.create({
        userId: user._id,
        studyPlanId: plan._id,
        date: todayStr,
        topicsCompleted: 0,
        timeStudiedMinutes: 0,
      });
    }

    if (!Array.isArray(plan.nodeReviews)) {
      plan.nodeReviews = [];
    }

    let existingReview = plan.nodeReviews.find((r) => String(r.nodeId) === String(nodeId));

    // Handle Snooze Action (iOS Swipe Left: reveals amber clock, snooze to tomorrow)
    if (action === 'snooze') {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      if (existingReview) {
        existingReview.nextReviewDate = tomorrow;
      } else {
        plan.nodeReviews.push({
          nodeId: String(nodeId),
          reviewCount: 1,
          nextReviewDate: tomorrow,
          lastReviewedAt: new Date(),
        });
      }

      // Also update matching subtopic node in subjects tree if present
      if (Array.isArray(plan.subjects)) {
        for (const subj of plan.subjects) {
          for (const ch of subj.chapters || []) {
            for (const top of ch.topics || []) {
              for (const st of top.subtopics || []) {
                const subId = String(
                  st.nodeId ||
                    st._id ||
                    st.id ||
                    `${subj.subjectName || subj.name}-${ch.chapterName || ch.title}-${top.title}-${st.title}`
                );
                if (subId === String(nodeId)) {
                  st.nextReviewDate = tomorrow;
                }
              }
            }
          }
        }
      }

      await plan.save();
      delCache(`target:${user._id}:${todayStr}`);

      return res.json({
        success: true,
        message: 'Topic snoozed to tomorrow',
        snoozed: true,
        nextReviewDate: tomorrow,
      });
    }

    // SRS Multiplier Algorithm (iOS Swipe Right: marks complete / review)
    // 1st time: 3 days. 2nd time: 7 days. 3rd+ time: 21 days.
    const isFirstTime = !existingReview || existingReview.reviewCount === 0;
    let nextReviewDays = 3;

    if (!isFirstTime) {
      if (existingReview.reviewCount === 1) {
        nextReviewDays = 7;
      } else {
        nextReviewDays = 21;
      }
    }

    const nextDate = new Date(Date.now() + nextReviewDays * 24 * 60 * 60 * 1000);
    const newCount = isFirstTime ? 1 : existingReview.reviewCount + 1;

    if (existingReview) {
      existingReview.reviewCount = newCount;
      existingReview.nextReviewDate = nextDate;
      existingReview.lastReviewedAt = new Date();
    } else {
      plan.nodeReviews.push({
        nodeId: String(nodeId),
        reviewCount: newCount,
        nextReviewDate: nextDate,
        lastReviewedAt: new Date(),
      });
    }

    // Also update matching subtopic node in 4-level deep subjects array if present
    if (Array.isArray(plan.subjects)) {
      for (const subj of plan.subjects) {
        for (const ch of subj.chapters || []) {
          for (const top of ch.topics || []) {
            for (const st of top.subtopics || []) {
              const subId = String(
                st.nodeId ||
                  st._id ||
                  st.id ||
                  `${subj.subjectName || subj.name}-${ch.chapterName || ch.title}-${top.title}-${st.title}`
              );
              if (subId === String(nodeId)) {
                if (isCompleted === false) {
                  st.isCompleted = false;
                } else {
                  st.isCompleted = true;
                  st.reviewCount = newCount;
                  st.nextReviewDate = nextDate;
                  st.lastReviewedAt = new Date();
                }
              }
            }
          }
        }
      }
    }

    if (isCompleted === false && action !== 'snooze') {
      plan.completedChapterIds = plan.completedChapterIds.filter((id) => id !== String(nodeId));
      plan.completedTopics = Math.max(0, (plan.completedTopics || 0) - 1);
      todayLog.topicsCompleted = Math.max(0, (todayLog.topicsCompleted || 0) - 1);
      todayLog.completedTopicIds = (todayLog.completedTopicIds || []).filter(
        (id) => id !== String(nodeId)
      );
      await todayLog.save();
    } else if (!plan.completedChapterIds.includes(String(nodeId)) && action !== 'snooze') {
      plan.completedChapterIds.push(String(nodeId));
      plan.completedTopics = Math.min(plan.totalTopics, (plan.completedTopics || 0) + 1);
      todayLog.topicsCompleted = (todayLog.topicsCompleted || 0) + 1;
      if (!Array.isArray(todayLog.completedTopicIds)) todayLog.completedTopicIds = [];
      if (!todayLog.completedTopicIds.includes(String(nodeId))) {
        todayLog.completedTopicIds.push(String(nodeId));
      }
      await todayLog.save();
    }

    await plan.save();

    // Invalidate target cache and recalculate
    delCache(`target:${user._id}:${todayStr}`);

    const reviewQueue = getReviewQueue(plan, plan.examId, 5);
    const upNextQueue = getUpNextQueue(plan, plan.examId, 3);

    res.json({
      success: true,
      message: isFirstTime
        ? `🎉 Topic completed! Scheduled for SRS review in 3 days.`
        : `🧠 Topic reviewed! SRS interval advanced to ${nextReviewDays} days.`,
      reviewCount: newCount,
      nextReviewDate: nextDate,
      reviewQueue,
      upNextQueue,
      todayCompleted: todayLog.topicsCompleted,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Bulk Chapter Completion API: Recursively complete all nested leaf nodes under a chapter
 * POST /api/study-plan/complete-chapter (and alias /api/complete-chapter)
 * Accepts: { chapterId }
 */
const completeChapterHandler = async (req, res, next) => {
  try {
    const { chapterId } = req.body;
    if (!chapterId) {
      return res.status(400).json({ success: false, message: 'chapterId is required' });
    }

    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({
      userId: user._id,
      status: { $in: ['active', 'paused'] },
    });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Active study plan not found' });
    }

    const todayStr = getTodayDateString();
    const todayDate = new Date();
    const srsNextReview = new Date(todayDate.getTime() + 3 * 24 * 60 * 60 * 1000);

    const completedLeafIds = [];
    let chapterFound = false;

    // Traverse plan.subjects to locate chapter or subject and gather nested leaf nodes
    for (const subj of plan.subjects || []) {
      const currentSubjId = String(subj.id || subj._id || subj.subjectName || subj.name || '');
      const currentSubjName = String(subj.subjectName || subj.name || '');
      const isSubjMatch =
        currentSubjId === String(chapterId) || currentSubjName === String(chapterId);

      if (isSubjMatch) {
        chapterFound = true;
        for (const ch of subj.chapters || []) {
          const currentChId = String(
            ch.id || ch._id || ch.chapterId || ch.title || ch.chapterName || ''
          );
          if (Array.isArray(ch.topics) && ch.topics.length > 0) {
            for (const top of ch.topics) {
              if (Array.isArray(top.subtopics) && top.subtopics.length > 0) {
                for (const st of top.subtopics) {
                  const stId = String(st.nodeId || st._id || st.id);
                  st.isCompleted = true;
                  st.reviewCount = (st.reviewCount || 0) + 1;
                  st.lastReviewedAt = todayDate;
                  st.nextReviewDate = srsNextReview;
                  completedLeafIds.push(stId);
                }
              } else {
                const topId = String(top._id || top.id || top.nodeId);
                top.isCompleted = true;
                completedLeafIds.push(topId);
              }
            }
          }
          if (currentChId) completedLeafIds.push(currentChId);
        }
        break;
      }

      for (const ch of subj.chapters || []) {
        const currentChId = String(ch.id || ch._id || ch.chapterId || '');
        const currentChName = String(ch.chapterName || ch.title || '');
        if (currentChId === String(chapterId) || currentChName === String(chapterId)) {
          chapterFound = true;
          if (Array.isArray(ch.topics) && ch.topics.length > 0) {
            for (const top of ch.topics) {
              if (Array.isArray(top.subtopics) && top.subtopics.length > 0) {
                for (const st of top.subtopics) {
                  const stId = String(st.nodeId || st._id || st.id);
                  st.isCompleted = true;
                  st.reviewCount = (st.reviewCount || 0) + 1;
                  st.lastReviewedAt = todayDate;
                  st.nextReviewDate = srsNextReview;
                  completedLeafIds.push(stId);
                }
              } else {
                const topId = String(top._id || top.id || top.nodeId);
                top.isCompleted = true;
                completedLeafIds.push(topId);
              }
            }
          }
          if (currentChId) completedLeafIds.push(currentChId);
          break;
        }
      }
      if (chapterFound) break;
    }

    if (!chapterFound) {
      // Fallback for subject level or non-nested chapter
      completedLeafIds.push(String(chapterId));
    }

    // Sync plan.completedChapterIds
    const completedSet = new Set((plan.completedChapterIds || []).map(String));
    completedLeafIds.forEach((id) => completedSet.add(id));
    plan.completedChapterIds = Array.from(completedSet);
    plan.completedTopics = plan.completedChapterIds.length;

    // Sync nodeReviews
    completedLeafIds.forEach((nodeId) => {
      const existing = (plan.nodeReviews || []).find((r) => String(r.nodeId) === nodeId);
      if (existing) {
        existing.reviewCount = (existing.reviewCount || 0) + 1;
        existing.lastReviewedAt = todayDate;
        existing.nextReviewDate = srsNextReview;
      } else {
        plan.nodeReviews.push({
          nodeId,
          reviewCount: 1,
          nextReviewDate: srsNextReview,
          lastReviewedAt: todayDate,
        });
      }
    });

    // Sync today's DailyLog
    let todayLog = await DailyLog.findOne({
      userId: user._id,
      studyPlanId: plan._id,
      date: todayStr,
    });
    if (!todayLog) {
      todayLog = new DailyLog({
        userId: user._id,
        studyPlanId: plan._id,
        date: todayStr,
        topicsCompleted: 0,
        completedTopicIds: [],
        timeStudiedMinutes: 0,
        totalTimeStudiedMinutes: 0,
      });
    }

    const todayCompletedSet = new Set((todayLog.completedTopicIds || []).map(String));
    completedLeafIds.forEach((id) => todayCompletedSet.add(id));
    todayLog.completedTopicIds = Array.from(todayCompletedSet);
    todayLog.topicsCompleted = todayLog.completedTopicIds.length;

    await plan.save();
    await todayLog.save();

    delCache(`target:${user._id}:${todayStr}`);

    res.json({
      success: true,
      message: `🎉 Successfully completed entire section (${completedLeafIds.length} subtopics)!`,
      completedCount: completedLeafIds.length,
      completedLeafIds,
      totalCompleted: plan.completedTopics,
    });
  } catch (error) {
    next(error);
  }
};

router.post('/study-plan/complete-chapter', optionalAuth, completeChapterHandler);
router.post('/complete-chapter', optionalAuth, completeChapterHandler);

/**
 * 5c. Granular Per-Subtopic Time Logging API
 * POST /api/study-plan/log-time (and alias /api/log-time)
 * Accepts: { studyPlanId, topicId, durationMinutes, topicTitle }
 * - Recursively traverses StudyPlan tree and increments topic's timeSpentMinutes
 * - Appends session data into today's DailyLog.sessions array and increments totalTimeStudiedMinutes
 */
const logTimeHandler = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const {
      studyPlanId,
      topicId,
      durationMinutes,
      topicTitle,
      subjectName,
      chapterName,
      tag,
      plannedMinutes,
      actualMinutes,
      startTime,
      endTime,
      timeRange,
    } = req.body;
    
    if (!topicId || !durationMinutes) {
      throw new Error('topicId and durationMinutes are required and must be valid.');
    }
    const duration = Math.max(1, Math.round(Number(durationMinutes) || 0));
    const user = await resolveUser(req);

    // 1. Fetch Plan to verify existence and get _id
    let plan = studyPlanId
      ? await StudyPlan.findById(studyPlanId).session(session)
      : await StudyPlan.findOne({ userId: user._id, status: 'active' }).session(session);

    if (!plan) {
      throw new Error('Active study plan not found');
    }

    // 2. Prepare Session Data
    const now = new Date();
    const sessionEnd = endTime ? new Date(endTime) : now;
    const sessionStart = startTime
      ? new Date(startTime)
      : new Date(sessionEnd.getTime() - duration * 60 * 1000);
    const formatOpts = { hour: 'numeric', minute: '2-digit', hour12: true };
    const computedTimeRange =
      timeRange ||
      `${sessionStart.toLocaleTimeString('en-US', formatOpts)} - ${sessionEnd.toLocaleTimeString('en-US', formatOpts)}`;

    const newSession = {
      topicId: String(topicId),
      topicTitle: topicTitle || String(topicId),
      subjectName: subjectName || 'General',
      chapterName: chapterName || '',
      tag: tag || '#Theory',
      durationMinutes: duration,
      plannedMinutes: Number(plannedMinutes) || duration,
      actualMinutes: Number(actualMinutes) || duration,
      startTime: sessionStart,
      endTime: sessionEnd,
      timeRange: computedTimeRange,
      loggedAt: new Date(),
    };

    // 3. Atomic Update of DailyLog (Zero Data Loss)
    const todayStr = getTodayDateString();
    const updatedDailyLog = await DailyLog.findOneAndUpdate(
      { userId: user._id, studyPlanId: plan._id, date: todayStr },
      {
        $inc: { totalTimeStudiedMinutes: duration, timeStudiedMinutes: duration },
        $push: { sessions: newSession }
      },
      { new: true, upsert: true, session }
    );

    // 4. Atomic Update of StudyPlan (nodeReviews timeSpentMinutes)
    // To avoid complex 4-level deep arrayFilters, we update the flat nodeReviews array atomically.
    // If it doesn't exist in nodeReviews, we can push it, or inc it if it does.
    const planUpdateOp = await StudyPlan.findOneAndUpdate(
      { _id: plan._id, "nodeReviews.nodeId": String(topicId) },
      { $inc: { "nodeReviews.$.timeSpentMinutes": duration } },
      { new: true, session }
    );

    if (!planUpdateOp) {
      // It wasn't in nodeReviews yet, so we push it
      await StudyPlan.findOneAndUpdate(
        { _id: plan._id },
        { 
          $push: { 
            nodeReviews: {
              nodeId: String(topicId),
              title: topicTitle || String(topicId),
              subjectName: subjectName || 'General',
              timeSpentMinutes: duration,
            }
          }
        },
        { new: true, session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    delCache(`target:${user._id}:${todayStr}`);

    res.json({
      success: true,
      message: `Recorded ${duration} minutes on "${topicTitle || topicId}"!`,
      session: newSession,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    // Pass to global error handler
    error.status = error.message.includes('required') || error.message.includes('found') ? 400 : 500;
    next(error);
  }
};

  router.post('/study-plan/log-time', optionalAuth, logTimeHandler);
router.post('/log-time', optionalAuth, logTimeHandler);

/**
 * 5b. Student Join Classroom via 6-Character Class Code
 * POST /api/join-class (and alias /api/class/join)
 */
const joinClassHandler = async (req, res, next) => {
  try {
    const { classCode } = req.body;
    const user = await resolveUser(req);

    if (!classCode || !classCode.trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'Classroom invite code is required.' });
    }

    const cleanCode = classCode.trim().toUpperCase();
    const classroom = await Classroom.findOne({ classCode: cleanCode })
      .populate('activeExamId')
      .populate('teacherId', 'username email');

    if (!classroom) {
      return res
        .status(404)
        .json({ success: false, message: 'Invalid class code. Classroom not found.' });
    }

    // Add student to classroom students array if not already present
    const studentIdStr = user._id.toString();
    const alreadyEnrolled = (classroom.students || []).some((s) => s.toString() === studentIdStr);
    if (!alreadyEnrolled) {
      classroom.students.push(user._id);
      await classroom.save();
    }

    // Update student's user account mode to managed and link assignedTeacherId
    await User.findByIdAndUpdate(user._id, {
      accountMode: 'managed',
      assignedTeacherId: classroom.teacherId._id || classroom.teacherId,
    });

    // If classroom has an active exam, synchronize student's active plan
    let activePlan = await StudyPlan.findOne({ userId: user._id, status: 'active' });
    if (classroom.activeExamId) {
      const exam = classroom.activeExamId;
      const targetDate = new Date();
      targetDate.setMonth(targetDate.getMonth() + 4);

      if (!activePlan) {
        const cloned = deepCloneExamTree(exam.subjects || []);
        const total = countLeafNodes(cloned) || exam.totalChapters || 0;
        activePlan = await StudyPlan.create({
          userId: user._id,
          examId: exam._id,
          targetDate,
          subjects: cloned,
          totalTopics: total,
          completedTopics: 0,
          completedChapterIds: [],
          isLockedByTeacher: true,
          assignedTeacherId: classroom.teacherId._id || classroom.teacherId,
          status: 'active',
        });
      } else {
        activePlan.isLockedByTeacher = true;
        activePlan.assignedTeacherId = classroom.teacherId._id || classroom.teacherId;
        await activePlan.save();
      }
    } else if (activePlan) {
      activePlan.isLockedByTeacher = true;
      activePlan.assignedTeacherId = classroom.teacherId._id || classroom.teacherId;
      await activePlan.save();
    }

    res.json({
      success: true,
      message: `🎉 Successfully enrolled in "${classroom.name}"!`,
      classroom: {
        id: classroom._id,
        name: classroom.name,
        classCode: classroom.classCode,
        teacherName: classroom.teacherId?.username || 'Instructor',
      },
      accountMode: 'managed',
    });
  } catch (error) {
    next(error);
  }
};

router.post('/join-class', optionalAuth, joinClassHandler);
router.post('/class/join', optionalAuth, joinClassHandler);

/**
 * 5c. Add Custom Topic / Subtopic to Student's Mutable StudyPlan
 * POST /api/study-plan/add-custom-topic (and alias /api/add-custom-topic)
 */
const addCustomTopicHandler = async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { parentId, level = 'subtopic', title, subjectName, chapterName, topicTitle } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Topic title is required.' });
    }

    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Active study plan not found.' });
    }

    const isPersonalSubtopic = Boolean(req.body.isPersonal);

    if (plan.isLockedByTeacher && user.accountMode !== 'teacher' && !isPersonalSubtopic) {
      return res.status(403).json({
        success: false,
        message:
          '🔒 Your syllabus is managed and locked by your instructor. Use "Add Personal Subtopic" to track extra reading.',
      });
    }

    // Ensure plan has deep copied subjects
    if (!Array.isArray(plan.subjects) || plan.subjects.length === 0) {
      plan.subjects = deepCloneExamTree(plan.examId?.subjects || []);
    }

    const cleanTitle = title.trim();
    let nodeAdded = false;

    // Search by parentId if provided
    if (parentId) {
      for (const subj of plan.subjects) {
        if (subj._id && subj._id.toString() === parentId.toString()) {
          subj.chapters.push({
            chapterName: cleanTitle,
            title: cleanTitle,
            topics: [
              {
                title: `${cleanTitle} Overview`,
                subtopics: [
                  {
                    title: 'Key Concepts',
                    nodeId: `${subj.subjectName}-${cleanTitle}-Overview-KeyConcepts`,
                  },
                ],
              },
            ],
          });
          nodeAdded = true;
          break;
        }
        for (const chap of subj.chapters || []) {
          if (chap._id && chap._id.toString() === parentId.toString()) {
            chap.topics.push({
              title: cleanTitle,
              subtopics: [
                {
                  title: `${cleanTitle} Core`,
                  nodeId: `${subj.subjectName}-${chap.chapterName}-${cleanTitle}-Core`,
                },
              ],
            });
            nodeAdded = true;
            break;
          }
          for (const top of chap.topics || []) {
            if (top._id && top._id.toString() === parentId.toString()) {
              const newNodeId = `${subj.subjectName}-${chap.chapterName}-${top.title}-${cleanTitle}-${Date.now().toString(36)}`;
              top.subtopics.push({
                title: cleanTitle,
                nodeId: newNodeId,
                isCompleted: false,
                isPersonal: isPersonalSubtopic,
                reviewCount: 0,
              });
              nodeAdded = true;
              break;
            }
          }
          if (nodeAdded) break;
        }
        if (nodeAdded) break;
      }
    }

    // Fallback: match by names or create path
    if (!nodeAdded) {
      const targetSubjName = subjectName || plan.subjects[0]?.subjectName || 'General';
      let subj = plan.subjects.find((s) => (s.subjectName || s.name) === targetSubjName);
      if (!subj) {
        subj = { subjectName: targetSubjName, name: targetSubjName, chapters: [] };
        plan.subjects.push(subj);
      }

      const targetChapName = chapterName || subj.chapters[0]?.chapterName || 'General Chapter';
      let chap = (subj.chapters || []).find((c) => (c.chapterName || c.title) === targetChapName);
      if (!chap) {
        chap = { chapterName: targetChapName, title: targetChapName, topics: [] };
        subj.chapters.push(chap);
      }

      if (level === 'topic') {
        chap.topics.push({
          title: cleanTitle,
          subtopics: [
            {
              title: `${cleanTitle} Basics`,
              nodeId: `${targetSubjName}-${targetChapName}-${cleanTitle}-Basics`,
            },
          ],
        });
      } else {
        const targetTopTitle = topicTitle || chap.topics[0]?.title || 'Core Topics';
        let top = (chap.topics || []).find((t) => t.title === targetTopTitle);
        if (!top) {
          top = { title: targetTopTitle, subtopics: [] };
          chap.topics.push(top);
        }
        const newNodeId = `${targetSubjName}-${targetChapName}-${targetTopTitle}-${cleanTitle}-${Date.now().toString(36)}`;
        top.subtopics.push({
          title: cleanTitle,
          nodeId: newNodeId,
          isCompleted: false,
          isPersonal: isPersonalSubtopic,
          reviewCount: 0,
        });
      }
    }

    plan.totalTopics = countLeafNodes(plan.subjects, plan.isLockedByTeacher);
    delCache(`target:${user._id}:${getTodayDateString()}`);
    await plan.save();

    res.status(201).json({
      success: true,
      message: `🎉 "${cleanTitle}" added to your custom syllabus!`,
      totalTopics: plan.totalTopics,
      subjects: plan.subjects,
    });
  } catch (error) {
    next(error);
  }
};

router.post('/study-plan/add-custom-topic', optionalAuth, addCustomTopicHandler);
router.post('/add-custom-topic', optionalAuth, addCustomTopicHandler);
router.post('/study-plan/add-personal-subtopic', optionalAuth, (req, res, next) => {
  req.body.isPersonal = true;
  return addCustomTopicHandler(req, res, next);
});
router.post('/add-personal-subtopic', optionalAuth, (req, res, next) => {
  req.body.isPersonal = true;
  return addCustomTopicHandler(req, res, next);
});

/**
 * 5d. Remove Topic / Subtopic from Student's Mutable StudyPlan
 * DELETE /api/study-plan/remove-topic (and alias /api/remove-topic)
 */
const removeTopicHandler = async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const nodeId = req.body?.nodeId || req.body?.id || req.query?.nodeId;

    if (!nodeId) {
      return res
        .status(400)
        .json({ success: false, message: 'Node ID or Title is required to delete.' });
    }

    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Active study plan not found.' });
    }

    if (plan.isLockedByTeacher && user.accountMode !== 'teacher') {
      // Allow deletion if target is a personal subtopic
      let isPersonalNode = false;
      const targetIdStr = String(nodeId);
      for (const subj of plan.subjects || []) {
        for (const chap of subj.chapters || []) {
          for (const top of chap.topics || []) {
            for (const st of top.subtopics || []) {
              const subId = String(st.nodeId || st._id || st.id);
              if ((subId === targetIdStr || st.title === targetIdStr) && st.isPersonal) {
                isPersonalNode = true;
                break;
              }
            }
            if (isPersonalNode) break;
          }
          if (isPersonalNode) break;
        }
        if (isPersonalNode) break;
      }

      if (!isPersonalNode) {
        return res.status(403).json({
          success: false,
          message: '🔒 Your syllabus is managed and locked by your instructor.',
        });
      }
    }

    if (!Array.isArray(plan.subjects) || plan.subjects.length === 0) {
      plan.subjects = deepCloneExamTree(plan.examId?.subjects || []);
    }

    const targetIdStr = String(nodeId);

    // Traverse and filter out matching node
    for (const subj of plan.subjects) {
      for (const chap of subj.chapters || []) {
        for (const top of chap.topics || []) {
          top.subtopics = (top.subtopics || []).filter((st) => {
            const subId = String(
              st.nodeId ||
                st._id ||
                st.id ||
                `${subj.subjectName || subj.name}-${chap.chapterName || chap.title}-${top.title}-${st.title}`
            );
            return subId !== targetIdStr && st.title !== targetIdStr;
          });
        }
        chap.topics = (chap.topics || []).filter(
          (t) => String(t._id || t.id || t.title) !== targetIdStr && t.title !== targetIdStr
        );
      }
    }

    // Clean up from completedChapterIds and nodeReviews
    plan.completedChapterIds = (plan.completedChapterIds || []).filter((id) => id !== targetIdStr);
    plan.nodeReviews = (plan.nodeReviews || []).filter((r) => String(r.nodeId) !== targetIdStr);

    plan.totalTopics = countLeafNodes(plan.subjects);
    plan.completedTopics = countCompletedLeafNodes(plan);
    delCache(`target:${user._id}:${getTodayDateString()}`);
    await plan.save();

    res.json({
      success: true,
      message: 'Node successfully deleted from your syllabus.',
      totalTopics: plan.totalTopics,
      completedTopics: plan.completedTopics,
      subjects: plan.subjects,
    });
  } catch (error) {
    next(error);
  }
};

router.delete('/study-plan/remove-topic', optionalAuth, removeTopicHandler);
router.delete('/remove-topic', optionalAuth, removeTopicHandler);

/**
 * 5e. Rename Topic / Subtopic in Student's Mutable StudyPlan
 * PATCH /api/study-plan/rename-topic (and alias /api/rename-topic)
 */
const renameTopicHandler = async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { nodeId, id, newTitle, title } = req.body;
    const cleanTitle = (newTitle || title || '').trim();

    if (!cleanTitle) {
      return res.status(400).json({ success: false, message: 'New title cannot be empty.' });
    }

    const targetIdStr = String(nodeId || id);
    if (!targetIdStr) {
      return res.status(400).json({ success: false, message: 'Node identifier is required.' });
    }

    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Active study plan not found.' });
    }

    if (plan.isLockedByTeacher && user.accountMode !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: '🔒 Your syllabus is managed and locked by your instructor.',
      });
    }

    if (!Array.isArray(plan.subjects) || plan.subjects.length === 0) {
      plan.subjects = deepCloneExamTree(plan.examId?.subjects || []);
    }

    let renamed = false;

    for (const subj of plan.subjects) {
      for (const chap of subj.chapters || []) {
        for (const top of chap.topics || []) {
          for (const st of top.subtopics || []) {
            const subId = String(
              st.nodeId ||
                st._id ||
                st.id ||
                `${subj.subjectName || subj.name}-${chap.chapterName || chap.title}-${top.title}-${st.title}`
            );
            if (subId === targetIdStr || st.title === targetIdStr) {
              st.title = cleanTitle;
              renamed = true;
              break;
            }
          }
          if (renamed) break;
          if (String(top._id || top.id || top.title) === targetIdStr) {
            top.title = cleanTitle;
            renamed = true;
            break;
          }
        }
        if (renamed) break;
        if (String(chap._id || chap.id || chap.chapterName || chap.title) === targetIdStr) {
          chap.chapterName = cleanTitle;
          chap.title = cleanTitle;
          renamed = true;
          break;
        }
      }
      if (renamed) break;
    }

    // Also update title in nodeReviews if present
    for (const review of plan.nodeReviews || []) {
      if (String(review.nodeId) === targetIdStr) {
        review.title = cleanTitle;
      }
    }

    await plan.save();

    res.json({
      success: true,
      message: `Renamed successfully to "${cleanTitle}"!`,
      newTitle: cleanTitle,
      subjects: plan.subjects,
    });
  } catch (error) {
    next(error);
  }
};

router.patch('/study-plan/rename-topic', optionalAuth, renameTopicHandler);
router.patch('/rename-topic', optionalAuth, renameTopicHandler);

/**
 * 5f. Reorder Subtopics within a Topic
 * PATCH /api/study-plan/reorder-subtopics (and alias /api/reorder-subtopics)
 */
const reorderSubtopicsHandler = async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { subjectName, chapterName, topicTitle, subtopics } = req.body;

    if (!Array.isArray(subtopics)) {
      return res
        .status(400)
        .json({ success: false, message: 'Ordered subtopics array is required.' });
    }

    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Active study plan not found.' });
    }

    if (plan.isLockedByTeacher && user.accountMode !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: '🔒 Your syllabus is managed and locked by your instructor.',
      });
    }

    if (!Array.isArray(plan.subjects) || plan.subjects.length === 0) {
      plan.subjects = deepCloneExamTree(plan.examId?.subjects || []);
    }

    for (const subj of plan.subjects) {
      if (!subjectName || (subj.subjectName || subj.name) === subjectName) {
        for (const chap of subj.chapters || []) {
          if (!chapterName || (chap.chapterName || chap.title) === chapterName) {
            for (const top of chap.topics || []) {
              if (!topicTitle || top.title === topicTitle) {
                top.subtopics = subtopics;
                await plan.save();
                return res.json({
                  success: true,
                  message: 'Subtopics reordered successfully!',
                  subtopics: top.subtopics,
                });
              }
            }
          }
        }
      }
    }

    res.status(404).json({ success: false, message: 'Topic target not found to reorder.' });
  } catch (error) {
    next(error);
  }
};

router.patch('/study-plan/reorder-subtopics', optionalAuth, reorderSubtopicsHandler);
router.patch('/reorder-subtopics', optionalAuth, reorderSubtopicsHandler);

/**
 * 6. Update Daily Progress
 * Modifies plan & log, invalidates target cache
 */
router.post('/progress', optionalAuth, async (req, res, next) => {
  try {
    const { studyPlanId, increment = 1, chapterId, isCompleted } = req.body;
    const user = await resolveUser(req);

    let plan = studyPlanId
      ? await StudyPlan.findById(studyPlanId).populate('examId')
      : await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Study plan not found' });
    }

    const todayStr = getTodayDateString();

    let todayLog = await DailyLog.findOne({
      userId: user._id,
      studyPlanId: plan._id,
      date: todayStr,
    });

    if (!todayLog) {
      todayLog = await DailyLog.create({
        userId: user._id,
        studyPlanId: plan._id,
        date: todayStr,
        topicsCompleted: 0,
        timeStudiedMinutes: 0,
      });
    }

    let delta = Number(increment) || 0;

    if (chapterId) {
      const alreadyChecked = plan.completedChapterIds.includes(chapterId);
      if (isCompleted === true || (isCompleted === undefined && !alreadyChecked)) {
        if (!alreadyChecked) {
          plan.completedChapterIds.push(chapterId);
          delta = 1;
        } else {
          delta = 0;
        }
      } else if (isCompleted === false || (isCompleted === undefined && alreadyChecked)) {
        if (alreadyChecked) {
          plan.completedChapterIds = plan.completedChapterIds.filter((id) => id !== chapterId);
          delta = -1;
        } else {
          delta = 0;
        }
      }
    }

    const newTotalCompleted = Math.max(
      0,
      Math.min(plan.totalTopics, (plan.completedTopics || 0) + delta)
    );
    plan.completedTopics = newTotalCompleted;
    await plan.save();

    todayLog.topicsCompleted = Math.max(0, todayLog.topicsCompleted + delta);
    await todayLog.save();

    // Invalidate in-memory target cache so next read recalculates
    const cacheKey = `target:${user._id}:${todayStr}`;
    delCache(cacheKey);

    // Recalculate fresh target
    const calculation = await calculateTodayTarget(plan);
    setCache(cacheKey, calculation, 3600);

    res.json({
      success: true,
      message: 'Progress updated successfully',
      data: {
        todayCompleted: todayLog.topicsCompleted,
        todayTarget: calculation.todayTarget,
        activeStudyDayPace: calculation.activeStudyDayPace,
        totalCompleted: plan.completedTopics,
        remainingTopics: calculation.remainingTopics,
        remainingValidDays: calculation.remainingValidDays,
        completedChapterIds: plan.completedChapterIds,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 7. Focus Timer Session
 * Logs time studied, updates progress, invalidates in-memory target cache
 */
router.post('/timer/session', optionalAuth, async (req, res, next) => {
  try {
    const { studyPlanId, timeStudiedMinutes = 0, topicsCompleted = 0 } = req.body;
    const user = await resolveUser(req);

    let plan = studyPlanId
      ? await StudyPlan.findById(studyPlanId).populate('examId')
      : await StudyPlan.findOne({ userId: user._id, status: 'active' }).populate('examId');

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Study plan not found' });
    }

    const todayStr = getTodayDateString();

    let todayLog = await DailyLog.findOne({
      userId: user._id,
      studyPlanId: plan._id,
      date: todayStr,
    });

    if (!todayLog) {
      todayLog = await DailyLog.create({
        userId: user._id,
        studyPlanId: plan._id,
        date: todayStr,
        topicsCompleted: 0,
        timeStudiedMinutes: 0,
      });
    }

    const addedMinutes = Math.max(0, Math.round(Number(timeStudiedMinutes) || 0));
    const addedTopics = Math.max(0, Math.round(Number(topicsCompleted) || 0));

    todayLog.timeStudiedMinutes += addedMinutes;
    todayLog.topicsCompleted += addedTopics;
    await todayLog.save();

    if (addedTopics > 0) {
      plan.completedTopics = Math.min(plan.totalTopics, (plan.completedTopics || 0) + addedTopics);
      await plan.save();
    }

    // Invalidate in-memory target cache
    const cacheKey = `target:${user._id}:${todayStr}`;
    delCache(cacheKey);

    const calculation = await calculateTodayTarget(plan);
    setCache(cacheKey, calculation, 3600);

    res.json({
      success: true,
      message: 'Focus session recorded successfully',
      data: {
        todayCompleted: todayLog.topicsCompleted,
        todayTarget: calculation.todayTarget,
        timeStudiedMinutes: todayLog.timeStudiedMinutes,
        totalCompleted: plan.completedTopics,
        remainingTopics: calculation.remainingTopics,
        remainingValidDays: calculation.remainingValidDays,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 8. Get Past Daily Logs (Paginated/limited to max 7 days with .lean())
 */
router.get('/logs', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const days = Math.min(30, parseInt(req.query.days) || 7);

    const logs = await DailyLog.find({ userId: user._id }).sort({ date: -1 }).limit(days).lean();

    res.json({ success: true, logs });
  } catch (error) {
    next(error);
  }
});

/**
 * 8b. History API: Previous Day Reflection
 * GET /api/history/yesterday
 * Returns: { date, completedTopics: [{ id, title, subjectName, chapterName }], missedTopics: [{ id, title, subjectName, chapterName }], timeStudied, targetForDay }
 */
router.get('/history/yesterday', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' })
      .populate('examId')
      .lean();

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = getTodayDateString(yesterday);

    let yesterdayLog = await DailyLog.findOne({
      userId: user._id,
      date: yesterdayStr,
    }).lean();

    // Map all topics in user's syllabus tree for fast O(1) lookup
    const topicMap = new Map();
    const subjectsSource =
      Array.isArray(plan?.subjects) && plan.subjects.length > 0
        ? plan.subjects
        : Array.isArray(plan?.examId?.subjects) && plan.examId.subjects.length > 0
          ? plan.examId.subjects
          : [];

    subjectsSource.forEach((subj) => {
      const subjName = subj.subjectName || subj.name || 'General';
      (subj.chapters || []).forEach((ch) => {
        const chName = ch.chapterName || ch.title || 'General';
        (ch.topics || []).forEach((top) => {
          const topTitle = top.title || 'Topic';
          (top.subtopics || []).forEach((st) => {
            const subId = String(
              st.nodeId || st._id || st.id || `${subjName}-${chName}-${topTitle}-${st.title}`
            );
            topicMap.set(subId, {
              id: subId,
              title: st.title,
              subjectName: subjName,
              chapterName: chName,
              topicTitle: topTitle,
            });
          });
          const topId = String(top._id || top.id || `${subjName}-${chName}-${topTitle}`);
          topicMap.set(topId, {
            id: topId,
            title: topTitle,
            subjectName: subjName,
            chapterName: chName,
          });
        });
      });
    });

    // Resolve completed topic titles
    const completedTopicIds = yesterdayLog?.completedTopicIds || [];
    const completedTopics = [];
    const completedIdSet = new Set();

    completedTopicIds.forEach((id) => {
      completedIdSet.add(String(id));
      const info = topicMap.get(String(id));
      if (info) {
        completedTopics.push(info);
      } else {
        completedTopics.push({ id, title: id, subjectName: 'General', chapterName: 'Topic' });
      }
    });

    // If yesterdayLog has topicsCompleted count but empty completedTopicIds array (fallback)
    if (completedTopics.length === 0 && (yesterdayLog?.topicsCompleted || 0) > 0) {
      const completedChapterIds = plan?.completedChapterIds || [];
      const sliceCount = Math.min(yesterdayLog.topicsCompleted, completedChapterIds.length);
      const recentIds = completedChapterIds.slice(-sliceCount);
      recentIds.forEach((id) => {
        completedIdSet.add(String(id));
        const info = topicMap.get(String(id));
        completedTopics.push(
          info || { id, title: id, subjectName: 'General', chapterName: 'Topic' }
        );
      });
    }

    // Determine target and missed topics
    const targetForDay =
      yesterdayLog?.targetForDay || (completedTopics.length > 0 ? completedTopics.length : 3);
    const missedCount = Math.max(0, targetForDay - completedTopics.length);
    const missedTopics = [];

    if (missedCount > 0) {
      for (const [id, info] of topicMap.entries()) {
        if (missedTopics.length >= missedCount) break;
        if (!completedIdSet.has(id) && !(plan?.completedChapterIds || []).includes(id)) {
          missedTopics.push(info);
        }
      }
    }

    res.json({
      success: true,
      date: yesterdayStr,
      targetForDay,
      completedTopics,
      missedTopics,
      timeStudied: yesterdayLog?.timeStudiedMinutes || 0,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 8c. History API: Study Timeline with Detailed Topic Titles
 * GET /api/history/timeline?days=30
 */
router.get('/history/timeline', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const days = parseInt(req.query.days) || 30;
    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' })
      .populate('examId')
      .lean();

    const topicMap = new Map();
    const subjectsSource =
      Array.isArray(plan?.subjects) && plan.subjects.length > 0
        ? plan.subjects
        : Array.isArray(plan?.examId?.subjects) && plan.examId.subjects.length > 0
          ? plan.examId.subjects
          : [];

    subjectsSource.forEach((subj) => {
      const subjName = subj.subjectName || subj.name || 'General';
      (subj.chapters || []).forEach((ch) => {
        const chName = ch.chapterName || ch.title || 'General';
        (ch.topics || []).forEach((top) => {
          const topTitle = top.title || 'Topic';
          (top.subtopics || []).forEach((st) => {
            const subId = String(
              st.nodeId || st._id || st.id || `${subjName}-${chName}-${topTitle}-${st.title}`
            );
            topicMap.set(subId, {
              id: subId,
              title: st.title,
              subjectName: subjName,
              chapterName: chName,
              topicTitle: topTitle,
            });
          });
        });
      });
    });

    const logs = await DailyLog.find({ userId: user._id }).sort({ date: -1 }).limit(days).lean();

    const enrichedLogs = logs.map((log) => {
      const completedTopics = (log.completedTopicIds || []).map((id) => {
        return topicMap.get(String(id)) || { id, title: id, subjectName: 'General' };
      });

      const rawSessions = log.sessions || [];
      const sessions = rawSessions.map((s) => {
        const topicInfo = topicMap.get(String(s.topicId));
        return {
          topicId: s.topicId,
          topicTitle: s.topicTitle || topicInfo?.title || 'Study Session',
          subjectName: s.subjectName || topicInfo?.subjectName || 'General',
          chapterName: s.chapterName || topicInfo?.chapterName || '',
          tag: s.tag || '#Theory',
          durationMinutes: s.durationMinutes || 0,
          plannedMinutes: s.plannedMinutes || s.durationMinutes || 0,
          actualMinutes: s.actualMinutes || s.durationMinutes || 0,
          timeRange: s.timeRange || '',
          startTime: s.startTime || null,
          endTime: s.endTime || null,
          loggedAt: s.loggedAt || null,
        };
      });

      return {
        _id: log._id,
        date: log.date,
        topicsCompleted: log.topicsCompleted || completedTopics.length,
        timeStudiedMinutes: log.timeStudiedMinutes || 0,
        targetForDay: log.targetForDay || 0,
        completedTopics,
        sessions,
        notes: log.notes || '',
      };
    });

    res.json({
      success: true,
      timeline: enrichedLogs,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 8a-2. Time Machine: Retroactive History Log Editor
 * PATCH /api/history/edit-log (and alias /api/edit-log)
 * Accepts: { date, addedTopicIds = [], removedTopicIds = [], overrideTotalMinutes }
 */
const editHistoryLogHandler = async (req, res, next) => {
  try {
    const { date, addedTopicIds = [], removedTopicIds = [], overrideTotalMinutes } = req.body;
    if (!date) {
      return res.status(400).json({ success: false, message: 'Date is required (YYYY-MM-DD)' });
    }

    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({
      userId: user._id,
      status: { $in: ['active', 'paused'] },
    });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Active study plan not found' });
    }

    // 1. Find or create DailyLog for the specific date
    let log = await DailyLog.findOne({ userId: user._id, studyPlanId: plan._id, date });
    if (!log) {
      log = new DailyLog({
        userId: user._id,
        studyPlanId: plan._id,
        date,
        topicsCompleted: 0,
        completedTopicIds: [],
        timeStudiedMinutes: 0,
        totalTimeStudiedMinutes: 0,
      });
    }

    // 2. Update overrideTotalMinutes if provided
    if (overrideTotalMinutes !== undefined && overrideTotalMinutes !== null) {
      const mins = Math.max(0, parseInt(overrideTotalMinutes, 10) || 0);
      log.totalTimeStudiedMinutes = mins;
      log.timeStudiedMinutes = mins;
    }

    // 3. Update completedTopicIds for that day
    const addedSet = new Set((addedTopicIds || []).map(String));
    const removedSet = new Set((removedTopicIds || []).map(String));

    let currentCompletedIds = new Set((log.completedTopicIds || []).map(String));
    addedSet.forEach((id) => currentCompletedIds.add(id));
    removedSet.forEach((id) => currentCompletedIds.delete(id));

    log.completedTopicIds = Array.from(currentCompletedIds);
    log.topicsCompleted = log.completedTopicIds.length;

    // 4. Crucial: Sync main StudyPlan tree and SRS intervals from that past date
    const planCompletedSet = new Set((plan.completedChapterIds || []).map(String));
    const pastDateObj = new Date(`${date}T12:00:00.000Z`);
    // Spaced Repetition multiplier from the historical date of the log, NOT Date.now()
    const srsIntervals = [3, 7, 21, 45];
    const nextReviewFromPast = new Date(
      pastDateObj.getTime() + srsIntervals[0] * 24 * 60 * 60 * 1000
    );

    const updateNodeTree = (subjects) => {
      for (const subj of subjects || []) {
        for (const ch of subj.chapters || []) {
          const chId = String(ch.nodeId || ch._id || ch.id || ch.chapterName || ch.title);
          if (addedSet.has(chId)) {
            ch.isCompleted = true;
          } else if (removedSet.has(chId)) {
            ch.isCompleted = false;
          }

          for (const top of ch.topics || []) {
            const topId = String(top.nodeId || top._id || top.id || top.title);
            if (addedSet.has(topId)) {
              top.isCompleted = true;
            } else if (removedSet.has(topId)) {
              top.isCompleted = false;
            }

            for (const st of top.subtopics || []) {
              const subId = String(st.nodeId || st._id || st.id || st.title);
              if (addedSet.has(subId)) {
                st.isCompleted = true;
                st.reviewCount = (st.reviewCount || 0) + 1;
                st.lastReviewedAt = pastDateObj;
                st.nextReviewDate = nextReviewFromPast;
              } else if (removedSet.has(subId)) {
                st.isCompleted = false;
                st.nextReviewDate = null;
              }
            }
          }
        }
      }
    };

    updateNodeTree(plan.subjects);

    // Sync nodeReviews array (add to queue with historical review date; remove on deletion)
    if (!Array.isArray(plan.nodeReviews)) {
      plan.nodeReviews = [];
    }

    addedSet.forEach((nodeId) => {
      planCompletedSet.add(nodeId);
      const existing = plan.nodeReviews.find((r) => String(r.nodeId) === nodeId);
      if (existing) {
        existing.reviewCount = (existing.reviewCount || 0) + 1;
        existing.lastReviewedAt = pastDateObj;
        existing.nextReviewDate = nextReviewFromPast;
      } else {
        plan.nodeReviews.push({
          nodeId,
          reviewCount: 1,
          nextReviewDate: nextReviewFromPast,
          lastReviewedAt: pastDateObj,
        });
      }
    });

    // Explicitly remove from Spaced Repetition queue on deletion
    if (removedSet.size > 0) {
      removedSet.forEach((nodeId) => planCompletedSet.delete(nodeId));
      plan.nodeReviews = plan.nodeReviews.filter((r) => !removedSet.has(String(r.nodeId)));
    }

    plan.completedChapterIds = Array.from(planCompletedSet);
    plan.completedTopics = plan.completedChapterIds.length;

    await log.save();
    await plan.save();

    // Invalidate caches
    const todayStr = getTodayDateString();
    delCache(`target:${user._id}:${todayStr}`);
    delCache(`target:${user._id}:${date}`);

    res.json({
      success: true,
      message: `Time Machine: Successfully retroactively updated log for ${date}.`,
      log,
      plan: {
        completedTopics: plan.completedTopics,
        totalTopics: plan.totalTopics,
      },
    });
  } catch (error) {
    next(error);
  }
};

router.patch('/history/edit-log', optionalAuth, editHistoryLogHandler);
router.patch('/edit-log', optionalAuth, editHistoryLogHandler);

/**
 * 8b. Streak Calendar & Detailed Consistency Stats
 * Returns monthly logs, streak calculation (with scheduled rest day shield),
 * and longest historical streak.
 */
router.get('/study-logs/calendar', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' }).lean();

    const now = new Date();
    const targetYear = parseInt(req.query.year) || now.getFullYear();
    const targetMonth = parseInt(req.query.month) || now.getMonth() + 1; // 1-12

    const monthStr = String(targetMonth).padStart(2, '0');
    const monthPrefix = `${targetYear}-${monthStr}`;

    // Get logs for the requested month
    const monthlyLogs = await DailyLog.find({
      userId: user._id,
      date: { $regex: `^${monthPrefix}` },
    })
      .sort({ date: 1 })
      .lean();

    // Also fetch last 120 days of logs for accurate streak & longest streak calculation
    const historicalLogs = await DailyLog.find({
      userId: user._id,
    })
      .sort({ date: -1 })
      .limit(120)
      .lean();

    const studyDays = plan?.studyDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // 1. Calculate Current Streak
    let currentStreak = 0;
    const todayStr = getTodayDateString(now);
    const todayLog = historicalLogs.find((l) => l.date === todayStr);
    const todayActive =
      todayLog && (todayLog.topicsCompleted > 0 || todayLog.timeStudiedMinutes >= 15);

    let checkOffset = todayActive ? 0 : 1;
    for (let i = checkOffset; i < 90; i++) {
      const checkDate = new Date(now);
      checkDate.setDate(now.getDate() - i);
      const dateStr = getTodayDateString(checkDate);
      const dayName = DAY_NAMES[checkDate.getDay()];
      const isScheduledStudyDay = studyDays.includes(dayName);
      const log = historicalLogs.find((l) => l.date === dateStr);
      const hadActivity = log && (log.topicsCompleted > 0 || log.timeStudiedMinutes >= 15);

      if (hadActivity) {
        currentStreak++;
      } else if (!isScheduledStudyDay) {
        // Rest day shield: streak not broken
        continue;
      } else {
        // Study day missed: streak ends
        break;
      }
    }

    // 2. Calculate Longest Streak
    let longestStreak = Math.max(currentStreak, 0);
    const sortedLogsAsc = [...historicalLogs].sort((a, b) => a.date.localeCompare(b.date));
    let tempStreak = 0;
    for (let i = 0; i < sortedLogsAsc.length; i++) {
      const log = sortedLogsAsc[i];
      if (log.topicsCompleted > 0 || log.timeStudiedMinutes >= 15) {
        tempStreak++;
        if (tempStreak > longestStreak) {
          longestStreak = tempStreak;
        }
      } else {
        tempStreak = 0;
      }
    }

    // 3. Monthly Metrics
    let totalMonthlyChapters = 0;
    let totalMonthlyMinutes = 0;
    let activeDaysCount = 0;
    let targetHitCount = 0;

    for (const log of monthlyLogs) {
      const ch = log.topicsCompleted || 0;
      const mins = log.timeStudiedMinutes || 0;
      const target = log.targetForDay || 0;
      totalMonthlyChapters += ch;
      totalMonthlyMinutes += mins;
      if (ch > 0 || mins > 0) activeDaysCount++;
      if (target > 0 && ch >= target) targetHitCount++;
    }

    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    let scheduledDaysInMonth = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(targetYear, targetMonth - 1, day);
      const dayName = DAY_NAMES[d.getDay()];
      if (studyDays.includes(dayName)) {
        scheduledDaysInMonth++;
      }
    }

    const completionRate =
      scheduledDaysInMonth > 0 ? Math.round((targetHitCount / scheduledDaysInMonth) * 100) : 0;

    res.json({
      success: true,
      year: targetYear,
      month: targetMonth,
      logs: monthlyLogs,
      studyDays,
      stats: {
        currentStreak,
        longestStreak,
        totalMonthlyChapters,
        totalMonthlyMinutes,
        activeDaysCount,
        targetHitCount,
        scheduledDaysInMonth,
        completionRate,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 9. Admin Automated Syllabus Ingestion Engine
 * Fetches structured syllabus from an educational portal URL using axios + cheerio
 */
router.post('/admin/fetch-syllabus', optionalAuth, async (req, res, next) => {
  try {
    const { targetUrl, examName } = req.body;

    if (!targetUrl || !targetUrl.startsWith('http')) {
      return res.status(400).json({
        success: false,
        message: 'A valid http/https Source URL is required.',
      });
    }

    if (!examName || !examName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Exam name is required.',
      });
    }

    // Call Scraper Service
    const scrapedSyllabus = await scrapeExamSyllabus(targetUrl, examName.trim());

    // Upsert Exam in MongoDB
    const savedExam = await Exam.findOneAndUpdate(
      { code: scrapedSyllabus.code },
      { ...scrapedSyllabus },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Invalidate in-memory 24-hour cache
    examCache.flushAll();

    // If an active study plan is bound to this exam, sync totalTopics
    const affectedPlans = await StudyPlan.find({ examId: savedExam._id });
    for (const plan of affectedPlans) {
      plan.totalTopics = savedExam.totalChapters;
      await plan.save();
    }

    res.json({
      success: true,
      message: `🎉 Successfully ingested ${savedExam.totalChapters} chapters for ${savedExam.name}!`,
      exam: savedExam,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 10. Topic Edit & Management API
 * Allows editing, adding, or removing topics/chapters within any exam
 */
router.put('/admin/exams/:id/topics', optionalAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { subjects, action, subjectIndex, chapterId, newTitle, subjectName } = req.body;

    const exam = await Exam.findById(id);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }

    if (subjects && Array.isArray(subjects)) {
      // Bulk update of subjects & chapters
      let grandTotal = 0;
      subjects.forEach((s) => {
        const count = s.chapters ? s.chapters.length : s.subTopics ? s.subTopics.length : 0;
        s.totalChapters = count;
        grandTotal += count;
      });
      exam.subjects = subjects;
      exam.totalChapters = grandTotal;
      exam.totalLeafNodes = grandTotal;
    } else if (action === 'edit' && chapterId && newTitle) {
      // Edit single chapter title
      let found = false;
      for (const sub of exam.subjects) {
        const ch = sub.chapters?.find((c) => c.id === chapterId || c._id?.toString() === chapterId);
        if (ch) {
          ch.title = newTitle.trim();
          found = true;
          break;
        }
      }
      if (!found && subjectIndex !== undefined && exam.subjects[subjectIndex]) {
        // Fallback to index
        const sub = exam.subjects[subjectIndex];
        const ch = sub.chapters?.find((c) => c.id === chapterId);
        if (ch) ch.title = newTitle.trim();
      }
      if (exam.tree && Array.isArray(exam.tree)) {
        updateNodeTitleInTree(exam.tree, chapterId, newTitle.trim());
      }
    } else if (action === 'add' && (subjectIndex !== undefined || subjectName) && newTitle) {
      // Add new topic/chapter to a subject (by subjectName or subjectIndex)
      let sub = null;
      if (subjectName) {
        sub = exam.subjects.find((s) => s.name?.toLowerCase() === subjectName.toLowerCase());
      }
      if (!sub && subjectIndex !== undefined) {
        const idx = typeof subjectIndex === 'number' ? subjectIndex : parseInt(subjectIndex, 10);
        if (!isNaN(idx) && exam.subjects[idx]) {
          sub = exam.subjects[idx];
        }
      }
      if (!sub && exam.subjects.length > 0) {
        sub = exam.subjects[0];
      }

      if (sub) {
        if (!sub.chapters) sub.chapters = [];
        const newId = `${exam.code}-custom-${Date.now()}`;
        const newChapter = {
          id: newId,
          title: newTitle.trim(),
          estimatedHours: 2,
        };
        sub.chapters.push(newChapter);
        sub.totalChapters = sub.chapters.length;

        if (!sub.subTopics) sub.subTopics = [];
        sub.subTopics.push(newTitle.trim());

        exam.totalChapters = exam.subjects.reduce((sum, s) => sum + (s.chapters?.length || 0), 0);
        exam.totalLeafNodes = exam.totalChapters;

        // Also sync exam.tree if tree exists
        if (exam.tree && Array.isArray(exam.tree)) {
          const treeSubj = exam.tree.find(
            (t) =>
              t.title?.toLowerCase() === sub.name?.toLowerCase() || t.id === sub._id?.toString()
          );
          if (treeSubj) {
            if (!treeSubj.children) treeSubj.children = [];
            treeSubj.children.push({
              id: newId,
              title: newTitle.trim(),
              type: 'chapter',
              children: [],
            });
          }
        }
      } else {
        return res
          .status(400)
          .json({ success: false, message: 'Subject not found for topic addition' });
      }
    } else if (action === 'delete' && chapterId) {
      // Delete a chapter
      for (const sub of exam.subjects) {
        if (!sub.chapters) continue;
        const initialLen = sub.chapters.length;
        sub.chapters = sub.chapters.filter(
          (c) => c.id !== chapterId && c._id?.toString() !== chapterId
        );
        if (sub.chapters.length !== initialLen) {
          sub.totalChapters = sub.chapters.length;
          break;
        }
      }
      exam.totalChapters = exam.subjects.reduce((sum, s) => sum + (s.chapters?.length || 0), 0);
      exam.totalLeafNodes = exam.totalChapters;
      if (exam.tree && Array.isArray(exam.tree)) {
        deleteNodeFromTree(exam.tree, chapterId);
      }
    }

    await exam.save();

    // Invalidate in-memory exam cache
    examCache.flushAll();

    // Sync any active study plan
    const affectedPlans = await StudyPlan.find({ examId: exam._id });
    for (const plan of affectedPlans) {
      if (plan.selectedSubjects && plan.selectedSubjects.length > 0) {
        const activeSubs = exam.subjects.filter((s) => plan.selectedSubjects.includes(s.name));
        plan.totalTopics = activeSubs.reduce((sum, s) => sum + (s.chapters?.length || 0), 0);
      } else {
        plan.totalTopics = exam.totalChapters;
      }
      // Filter out deleted chapters from completedChapterIds if needed
      if (action === 'delete' && chapterId) {
        plan.completedChapterIds = (plan.completedChapterIds || []).filter(
          (cid) => cid !== chapterId
        );
        plan.completedTopics = plan.completedChapterIds.length;
      }
      await plan.save();
      const todayStr = getTodayDateString();
      delCache(`target:${plan.userId}:${todayStr}`);
    }

    res.json({
      success: true,
      message: 'Syllabus topics updated successfully',
      exam,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// SYLLABUS TREE ENGINE & BUILDER APIS
// ==========================================

function updateNodeTitleInTree(nodes, nodeId, newTitle) {
  if (!nodes || !Array.isArray(nodes)) return false;
  for (const node of nodes) {
    if (node.id === nodeId || node._id?.toString() === nodeId) {
      node.title = newTitle;
      return true;
    }
    if (node.children && node.children.length > 0) {
      if (updateNodeTitleInTree(node.children, nodeId, newTitle)) return true;
    }
  }
  return false;
}

function addChildToNodeInTree(nodes, parentId, newNode) {
  if (!nodes || !Array.isArray(nodes)) return false;
  for (const node of nodes) {
    if (node.id === parentId || node._id?.toString() === parentId) {
      if (!node.children) node.children = [];
      node.children.push(newNode);
      return true;
    }
    if (node.children && node.children.length > 0) {
      if (addChildToNodeInTree(node.children, parentId, newNode)) return true;
    }
  }
  return false;
}

function deleteNodeFromTree(nodes, nodeId) {
  if (!nodes || !Array.isArray(nodes)) return false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === nodeId || node._id?.toString() === nodeId) {
      nodes.splice(i, 1);
      return true;
    }
    if (node.children && node.children.length > 0) {
      if (deleteNodeFromTree(node.children, nodeId)) return true;
    }
  }
  return false;
}

/**
 * 11. Scrape URL to Tree (Returns tree without saving to DB yet)
 */
router.post('/syllabus/scrape-url', optionalAuth, async (req, res, next) => {
  try {
    const { url, examName } = req.body;
    if (!url || !url.startsWith('http')) {
      return res
        .status(400)
        .json({ success: false, message: 'A valid http/https URL is required' });
    }
    const parsed = await scrapeUrlToTree(url, examName || 'Exam Syllabus');
    res.json({ success: true, syllabus: parsed });
  } catch (err) {
    next(err);
  }
});

/**
 * 12. Parse Pasted Text to Tree (Returns tree without saving to DB yet)
 */
router.post('/syllabus/parse-text', optionalAuth, async (req, res, next) => {
  try {
    const { text, examName } = req.body;
    if (!text || text.trim().length < 5) {
      return res
        .status(400)
        .json({ success: false, message: 'Please provide syllabus text to parse' });
    }
    const parsed = parseRawTextToTree(text, examName || 'Custom Exam');
    res.json({ success: true, syllabus: parsed });
  } catch (err) {
    next(err);
  }
});

/**
 * 13. Save Exam Template (Commit final edited tree to MongoDB)
 */
router.post('/syllabus/save-template', optionalAuth, async (req, res, next) => {
  try {
    const { name, code, description, tree } = req.body;
    if (!name || !tree || !Array.isArray(tree)) {
      return res
        .status(400)
        .json({ success: false, message: 'Exam name and valid tree array are required' });
    }

    const examCode =
      code ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    const totalLeafNodes = countLeafNodes(tree);
    const subjects = flattenTreeToSubjects(tree, examCode);

    const savedExam = await Exam.findOneAndUpdate(
      { code: examCode },
      {
        name: name.trim(),
        code: examCode,
        description: description || `Syllabus for ${name}`,
        totalChapters: totalLeafNodes,
        totalLeafNodes,
        tree,
        subjects,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    examCache.flushAll();

    // Sync affected active plans
    const affectedPlans = await StudyPlan.find({ examId: savedExam._id });
    for (const plan of affectedPlans) {
      if (!plan.selectedSubjects || plan.selectedSubjects.length === 0) {
        plan.totalTopics = savedExam.totalChapters;
      }
      await plan.save();
    }

    res.json({
      success: true,
      message: `🎉 Successfully saved exam template "${savedExam.name}" with ${totalLeafNodes} topics!`,
      exam: savedExam,
      totalLeafNodes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 14. Edit Node Title in Exam Template
 */
router.put('/syllabus/edit-node', optionalAuth, async (req, res, next) => {
  try {
    const { examId, nodeId, newTitle } = req.body;
    if (!examId || !nodeId || !newTitle) {
      return res
        .status(400)
        .json({ success: false, message: 'examId, nodeId, and newTitle are required' });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }

    if (exam.tree && exam.tree.length > 0) {
      updateNodeTitleInTree(exam.tree, nodeId, newTitle.trim());
      exam.markModified('tree');
    }

    let updatedInSubjects = false;
    for (const sub of exam.subjects) {
      if (sub._id?.toString() === nodeId || sub.id === nodeId) {
        sub.name = newTitle.trim();
        updatedInSubjects = true;
        break;
      }
      const ch = sub.chapters.find((c) => c.id === nodeId || c._id?.toString() === nodeId);
      if (ch) {
        ch.title = newTitle.trim();
        updatedInSubjects = true;
        break;
      }
    }

    if (!updatedInSubjects && exam.tree && exam.tree.length > 0) {
      exam.subjects = flattenTreeToSubjects(exam.tree, exam.code);
    }

    exam.totalLeafNodes =
      exam.tree && exam.tree.length > 0 ? countLeafNodes(exam.tree) : exam.totalChapters;
    exam.totalChapters = exam.totalLeafNodes;

    await exam.save();
    examCache.flushAll();

    res.json({
      success: true,
      message: 'Node title updated successfully',
      exam,
      totalLeafNodes: exam.totalLeafNodes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 15. Add Child Node to Parent in Exam Template
 */
router.post('/syllabus/add-node', optionalAuth, async (req, res, next) => {
  try {
    const { examId, parentId, title, type = 'topic' } = req.body;
    if (!examId || !parentId || !title) {
      return res
        .status(400)
        .json({ success: false, message: 'examId, parentId, and title are required' });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }

    const newNode = {
      id: `${type}-${randomUUID().slice(0, 8)}`,
      title: title.trim(),
      type,
      children: [],
    };

    if (exam.tree && exam.tree.length > 0) {
      addChildToNodeInTree(exam.tree, parentId, newNode);
      exam.markModified('tree');
      exam.subjects = flattenTreeToSubjects(exam.tree, exam.code);
      exam.totalLeafNodes = countLeafNodes(exam.tree);
      exam.totalChapters = exam.totalLeafNodes;
    } else {
      for (const sub of exam.subjects) {
        if (sub.id === parentId || sub._id?.toString() === parentId) {
          sub.chapters.push({
            id: newNode.id,
            title: newNode.title,
            estimatedHours: 2,
          });
          sub.totalChapters = sub.chapters.length;
          break;
        }
      }
      exam.totalChapters = exam.subjects.reduce((sum, s) => sum + s.chapters.length, 0);
      exam.totalLeafNodes = exam.totalChapters;
    }

    await exam.save();
    examCache.flushAll();

    const affectedPlans = await StudyPlan.find({ examId: exam._id });
    for (const plan of affectedPlans) {
      if (!plan.selectedSubjects || plan.selectedSubjects.length === 0) {
        plan.totalTopics = exam.totalChapters;
      }
      await plan.save();
    }

    res.json({
      success: true,
      message: 'Child node added successfully',
      exam,
      newNode,
      totalLeafNodes: exam.totalLeafNodes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 16. Delete Node (and Children) in Exam Template
 */
router.delete('/syllabus/delete-node', optionalAuth, async (req, res, next) => {
  try {
    const { examId, nodeId } = req.body?.examId ? req.body : req.query;
    if (!examId || !nodeId) {
      return res.status(400).json({ success: false, message: 'examId and nodeId are required' });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }

    if (exam.tree && exam.tree.length > 0) {
      deleteNodeFromTree(exam.tree, nodeId);
      exam.markModified('tree');
      exam.subjects = flattenTreeToSubjects(exam.tree, exam.code);
      exam.totalLeafNodes = countLeafNodes(exam.tree);
      exam.totalChapters = exam.totalLeafNodes;
    } else {
      for (const sub of exam.subjects) {
        const initLen = sub.chapters.length;
        sub.chapters = sub.chapters.filter((c) => c.id !== nodeId && c._id?.toString() !== nodeId);
        if (sub.chapters.length !== initLen) {
          sub.totalChapters = sub.chapters.length;
          break;
        }
      }
      exam.totalChapters = exam.subjects.reduce((sum, s) => sum + s.chapters.length, 0);
      exam.totalLeafNodes = exam.totalChapters;
    }

    await exam.save();
    examCache.flushAll();

    const affectedPlans = await StudyPlan.find({ examId: exam._id });
    for (const plan of affectedPlans) {
      plan.completedChapterIds = (plan.completedChapterIds || []).filter((id) => id !== nodeId);
      plan.completedTopics = plan.completedChapterIds.length;
      if (!plan.selectedSubjects || plan.selectedSubjects.length === 0) {
        plan.totalTopics = exam.totalChapters;
      }
      await plan.save();
    }

    res.json({
      success: true,
      message: 'Node deleted successfully',
      exam,
      totalLeafNodes: exam.totalLeafNodes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Cohort Aggregation API: Gamified Leaderboard for Managed Students
 * Inspired by Apple Fitness Activity Sharing
 * GET /api/cohort/leaderboard
 */
router.get('/cohort/leaderboard', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (!user || !user.assignedTeacherId) {
      return res.json({
        success: true,
        leaderboard: [],
        message: 'No assigned teacher cohort found.',
      });
    }

    const cohortStudents = await User.find({
      assignedTeacherId: user.assignedTeacherId,
      accountMode: 'managed',
    })
      .select('_id username email')
      .lean();

    if (cohortStudents.length === 0) {
      return res.json({ success: true, leaderboard: [] });
    }

    const todayStr = getTodayDateString();
    const leaderboard = [];
    const studentIds = cohortStudents.map((s) => s._id);

    // Batch query: fetch all active plans and recent logs in parallel (O(1) instead of N+1)
    const [plans, allLogs] = await Promise.all([
      StudyPlan.find({ userId: { $in: studentIds }, status: 'active' })
        .select('userId totalTopics completedTopics')
        .lean(),
      DailyLog.find({ userId: { $in: studentIds } })
        .sort({ date: -1 })
        .lean(),
    ]);

    const planMap = new Map(plans.map((p) => [p.userId.toString(), p]));
    const logsMap = new Map();
    for (const log of allLogs) {
      const uid = log.userId.toString();
      if (!logsMap.has(uid)) logsMap.set(uid, []);
      logsMap.get(uid).push(log);
    }

    const now = new Date();

    for (const student of cohortStudents) {
      const plan = planMap.get(student._id.toString());

      let completionPercentage = 0;
      let currentStreak = 0;

      if (plan && plan.totalTopics > 0) {
        completionPercentage = Math.min(
          100,
          Math.round(((plan.completedTopics || 0) / plan.totalTopics) * 100)
        );
      }

      // Calculate streak from DailyLog
      const recentLogs = logsMap.get(student._id.toString()) || [];

      for (let i = 0; i < Math.min(30, recentLogs.length); i++) {
        const checkDate = new Date(now);
        checkDate.setDate(now.getDate() - i);
        const dateString = getTodayDateString(checkDate);
        const log = recentLogs.find((l) => l.date === dateString);
        if (i === 0 && (!log || (log.topicsCompleted === 0 && log.timeStudiedMinutes === 0)))
          continue;
        if (log && (log.topicsCompleted > 0 || log.timeStudiedMinutes >= 15)) {
          currentStreak++;
        } else {
          break;
        }
      }

      // Privacy Filter: Only extract first name. Never expose email, IDs, or exact hours to peers!
      const rawName = student.username || student.email.split('@')[0] || 'Aspirant';
      const firstName = rawName.trim().split(' ')[0];
      const isCurrentUser = student._id.toString() === user._id.toString();

      leaderboard.push({
        firstName,
        completionPercentage,
        currentStreak,
        isCurrentUser,
      });
    }

    // Sort descending: primary by completionPercentage, secondary by currentStreak
    leaderboard.sort((a, b) => {
      if (b.completionPercentage !== a.completionPercentage) {
        return b.completionPercentage - a.completionPercentage;
      }
      return b.currentStreak - a.currentStreak;
    });

    res.json({
      success: true,
      leaderboard,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 5-Minute Student Heartbeat API
 * POST /api/user/heartbeat
 * Logs active presence and current focus session for silent peer accountability
 */
router.post('/user/heartbeat', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const { isStudying = false, activeTopicTitle = '' } = req.body || {};

    user.lastHeartbeatAt = new Date();
    user.isCurrentlyStudying = Boolean(isStudying);
    user.currentFocusTopic = activeTopicTitle ? String(activeTopicTitle).slice(0, 80) : '';
    await user.save();

    res.json({
      success: true,
      lastHeartbeatAt: user.lastHeartbeatAt,
      isCurrentlyStudying: user.isCurrentlyStudying,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Classmates Hub: Game Center-style grid data showing peers' real-time focus status
 * GET /api/cohort/classmates
 */
router.get('/cohort/classmates', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    // Filter peers in the same classroom/teacher cohort or active study peers
    let peerQuery = { accountMode: { $ne: 'teacher' } };
    if (user.assignedTeacherId) {
      peerQuery.assignedTeacherId = user.assignedTeacherId;
    }

    const peers = await User.find(peerQuery)
      .sort({ lastHeartbeatAt: -1, createdAt: -1 })
      .select(
        '_id username email avatar lastHeartbeatAt isCurrentlyStudying currentFocusTopic createdAt'
      )
      .limit(30)
      .lean();

    if (!peers.some((p) => p._id.toString() === user._id.toString())) {
      peers.unshift(user);
    }

    const peerIds = peers.map((p) => p._id);
    const [plans, allLogs] = await Promise.all([
      StudyPlan.find({ userId: { $in: peerIds }, status: 'active' })
        .select('userId totalTopics completedTopics completedChapterIds')
        .lean(),
      DailyLog.find({ userId: { $in: peerIds } })
        .sort({ date: -1 })
        .lean(),
    ]);

    const planMap = new Map(plans.map((p) => [p.userId.toString(), p]));
    const logsMap = new Map();
    for (const log of allLogs) {
      const uid = log.userId.toString();
      if (!logsMap.has(uid)) logsMap.set(uid, []);
      logsMap.get(uid).push(log);
    }

    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const now = Date.now();
    const classmates = [];

    for (const peer of peers) {
      const isCurrentUser = peer._id.toString() === user._id.toString();
      const lastBeatTime = peer.lastHeartbeatAt ? new Date(peer.lastHeartbeatAt).getTime() : 0;
      const isOnline = lastBeatTime > 0 && now - lastBeatTime < FIVE_MINUTES_MS;
      const isCurrentlyStudying = isOnline && Boolean(peer.isCurrentlyStudying);

      // Fetch streak & progress from O(1) map
      const plan = planMap.get(peer._id.toString());
      const completedTopics =
        plan?.completedTopics || (plan?.completedChapterIds || []).length || 0;
      const totalTopics = plan?.totalTopics || 100;
      const completionPercentage =
        totalTopics > 0 ? Math.min(100, Math.round((completedTopics / totalTopics) * 100)) : 0;

      // Approximate streak from memory logs
      const recentLogs = logsMap.get(peer._id.toString()) || [];
      let streak = 0;
      for (let i = 0; i < Math.min(7, recentLogs.length); i++) {
        const checkDate = new Date();
        checkDate.setDate(checkDate.getDate() - i);
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

      const rawName = peer.username || peer.email?.split('@')[0] || 'Aspirant';
      const displayName = isCurrentUser ? `${rawName} (You)` : rawName;

      classmates.push({
        id: peer._id,
        name: displayName,
        rawName,
        isCurrentUser,
        avatar: peer.avatar || 'student',
        isOnline,
        isCurrentlyStudying,
        currentFocusTopic: isCurrentlyStudying ? peer.currentFocusTopic || 'Deep Work Session' : '',
        currentStreak: streak,
        completionPercentage,
        lastHeartbeatAt: peer.lastHeartbeatAt,
      });
    }

    // Sort: studying now first, then online, then by streak
    classmates.sort((a, b) => {
      if (b.isCurrentlyStudying !== a.isCurrentlyStudying) {
        return b.isCurrentlyStudying ? 1 : -1;
      }
      if (b.isOnline !== a.isOnline) {
        return b.isOnline ? 1 : -1;
      }
      return b.currentStreak - a.currentStreak;
    });

    res.json({
      success: true,
      classmates,
      activeNowCount: classmates.filter((c) => c.isCurrentlyStudying).length,
      onlineCount: classmates.filter((c) => c.isOnline).length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Student Distribution API: Total minutes and topics completed grouped by Subject
 * GET /api/reports/distribution
 */
router.get('/reports/distribution', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' })
      .populate('examId')
      .lean();

    if (!plan || !plan.examId) {
      return res.json({ success: true, distribution: [] });
    }

    const exam = plan.examId;
    const completedSet = new Set((plan.completedChapterIds || []).map(String));

    // Aggregate user's total study minutes from DailyLog
    const allLogs = await DailyLog.find({ userId: user._id, studyPlanId: plan._id }).lean();
    const totalMinutesLogged = allLogs.reduce((sum, l) => sum + (l.timeStudiedMinutes || 0), 0);
    const totalCompletedTopics = plan.completedTopics || completedSet.size || 0;

    const subjects = exam.subjects || [];
    const distribution = subjects.map((subj) => {
      const sName = subj.name || subj.subjectName || 'Subject';
      const chapters = subj.chapters || [];
      const completedInSubject = chapters.filter((c) => completedSet.has(String(c.id))).length;
      const totalInSubject = chapters.length || subj.totalChapters || 1;

      let proportionalMinutes = 0;
      if (totalCompletedTopics > 0) {
        proportionalMinutes = Math.round(
          (completedInSubject / totalCompletedTopics) * totalMinutesLogged
        );
      } else {
        proportionalMinutes = completedInSubject * 30;
      }
      if (completedInSubject > 0 && proportionalMinutes === 0) {
        proportionalMinutes = completedInSubject * 35;
      }

      // Aggregate sessions logged for this subject
      const subjectSessions = [];
      allLogs.forEach((l) => {
        (l.sessions || []).forEach((s) => {
          if (
            s.subjectName &&
            (s.subjectName === sName || s.subjectName.toLowerCase() === sName.toLowerCase())
          ) {
            subjectSessions.push(s);
          }
        });
      });

      const sessionActualMins = subjectSessions.reduce(
        (sum, s) => sum + (s.actualMinutes || s.durationMinutes || 0),
        0
      );
      const sessionPlannedMins = subjectSessions.reduce(
        (sum, s) => sum + (s.plannedMinutes || 0),
        0
      );

      // Tree-based logged minutes
      let treeActualMins = 0;
      chapters.forEach((c) => {
        (c.topics || []).forEach((t) => {
          treeActualMins += t.timeSpentMinutes || 0;
          (t.subtopics || []).forEach((st) => {
            treeActualMins += st.timeSpentMinutes || 0;
          });
        });
      });

      const actualMinutes = Math.max(sessionActualMins, treeActualMins, proportionalMinutes);
      // Planned time defaults to ~1 hour (60m) per topic in the subject if not specified in sessions
      const plannedMinutes =
        sessionPlannedMins > 0 ? sessionPlannedMins : Math.round(totalInSubject * 60);

      const actualHours = Math.round((actualMinutes / 60) * 10) / 10;
      const plannedHours = Math.round((plannedMinutes / 60) * 10) / 10;
      const efficiencyGapHours = Math.round((actualHours - plannedHours) * 10) / 10;

      return {
        subject: sName,
        subjectName: sName,
        completed: completedInSubject,
        total: totalInSubject,
        completionRate: Math.round((completedInSubject / totalInSubject) * 100),
        minutes: actualMinutes,
        timeSpentMinutes: actualMinutes,
        actualMinutes,
        plannedMinutes,
        actualHours,
        plannedHours,
        efficiencyGapHours,
      };
    });

    res.json({
      success: true,
      distribution,
      totalMinutesLogged,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Student Target vs Actual Trends API: Last 14 days comparison
 * GET /api/reports/trends
 */
router.get('/reports/trends', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const plan = await StudyPlan.findOne({ userId: user._id, status: 'active' }).lean();

    const trends = [];
    const now = new Date();

    const days = 14;
    const dateStrings = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      dateStrings.push(getTodayDateString(d));
    }

    const logs = await DailyLog.find({
      userId: user._id,
      date: { $in: dateStrings },
    }).lean();

    const logMap = new Map(logs.map((l) => [l.date, l]));

    for (const dateStr of dateStrings) {
      const log = logMap.get(dateStr);
      const parts = dateStr.split('-');
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
      const mIdx = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const displayDate = `${monthNames[mIdx]} ${day}`;

      const plannedTopics =
        log?.targetForDay || (plan ? Math.max(2, Math.ceil(plan.totalTopics / 60)) : 3);
      const completedTopics = log?.topicsCompleted || 0;
      const minutesFocused = log?.timeStudiedMinutes || 0;

      trends.push({
        date: displayDate,
        rawDate: dateStr,
        plannedTopics,
        completedTopics,
        minutesFocused,
      });
    }

    res.json({
      success: true,
      trends,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * MongoDB Change Stream: SSE Endpoint for Real-Time Peer Presence
 * GET /api/sessions/stream
 * Listens to the ActiveSession collection and pipes events instantly to the React frontend.
 */
router.get('/sessions/stream', optionalAuth, async (req, res, next) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Ping to keep connection alive
  const keepAlive = setInterval(() => {
    res.write(':\n\n');
  }, 15000);

  try {
    const ActiveSession = (await import('../models/ActiveSession.js')).default;

    // Watch for inserts, updates, and deletes
    // Fallback: If change streams aren't supported (e.g. standalone Mongo), this will throw.
    const changeStream = ActiveSession.watch([], { fullDocument: 'updateLookup' });

    changeStream.on('change', (change) => {
      // We only care about the final document state
      const doc = change.fullDocument;
      if (doc) {
        res.write(`data: ${JSON.stringify(doc)}\n\n`);
      } else if (change.operationType === 'delete') {
        // If a session expires or is deleted, notify frontend it's offline
        res.write(
          `data: ${JSON.stringify({ _id: change.documentKey._id, status: 'offline', deleted: true })}\n\n`
        );
      }
    });

    req.on('close', () => {
      clearInterval(keepAlive);
      changeStream.close();
    });
  } catch (err) {
    next(err);
  }
});

/**
 * MongoDB Active Session Heartbeat
 * POST /api/sessions/heartbeat
 */
router.post('/sessions/heartbeat', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ success: false });

    const ActiveSession = (await import('../models/ActiveSession.js')).default;
    const { status = 'focusing', topic = '' } = req.body;

    const session = await ActiveSession.findOneAndUpdate(
      { userId: user._id },
      {
        userId: user._id,
        username: user.username || user.email.split('@')[0],
        avatar: user.avatar || '',
        status,
        topic,
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, session });
  } catch (error) {
    next(error);
  }
});


// Focus Interruption Endpoint
router.post('/sessions/distraction', optionalAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const todayStr = getTodayDateString();
    
    await DailyLog.findOneAndUpdate(
      { userId: user._id, date: todayStr },
      { $inc: { interruptions: 1 } },
      { new: true, upsert: true }
    );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;


  


