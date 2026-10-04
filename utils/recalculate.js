import StudyPlan from '../models/StudyPlan.js';

/**
 * Adaptive Recalculation Engine for Competitive Exams with 4-Level Hierarchy
 *
 * Hierarchy: Subject -> Chapter -> Topic -> Subtopic
 * The deepest level (Subtopic) serves as the atomic leaf node.
 *
 * Formula:
 * Daily Target = Math.ceil(remainingTopics / remainingValidDays)
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function getTodayDateString(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Traverses a 4-level nested syllabus structure (or tree) down to the Subtopics
 * to calculate the total atomic leaf nodes.
 * Structure:
 * subjects: [{ subjectName, chapters: [{ chapterName, topics: [{ title, subtopics: [{ title }] }] }] }]
 */
export function countLeafNodes(subjectsOrTree, excludePersonal = false) {
  if (!subjectsOrTree) return 0;

  // Support passing an Exam or StudyPlan object directly
  const list = Array.isArray(subjectsOrTree)
    ? subjectsOrTree
    : subjectsOrTree.subjects && Array.isArray(subjectsOrTree.subjects)
      ? subjectsOrTree.subjects
      : subjectsOrTree.tree && Array.isArray(subjectsOrTree.tree)
        ? subjectsOrTree.tree
        : [];

  let count = 0;

  for (const subject of list) {
    if (Array.isArray(subject.chapters) && subject.chapters.length > 0) {
      for (const chapter of subject.chapters) {
        if (Array.isArray(chapter.topics) && chapter.topics.length > 0) {
          for (const topic of chapter.topics) {
            if (Array.isArray(topic.subtopics) && topic.subtopics.length > 0) {
              // 4th Level: Atomic Subtopics
              if (excludePersonal) {
                count += topic.subtopics.filter((st) => !st.isPersonal).length;
              } else {
                count += topic.subtopics.length;
              }
            } else {
              // Fallback if topic has no subtopics
              count += 1;
            }
          }
        } else if (Array.isArray(chapter.subtopics) && chapter.subtopics.length > 0) {
          if (excludePersonal) {
            count += chapter.subtopics.filter((st) => !st.isPersonal).length;
          } else {
            count += chapter.subtopics.length;
          }
        } else {
          // Chapter with no topics
          count += 1;
        }
      }
    } else if (Array.isArray(subject.children) && subject.children.length > 0) {
      // Generic recursive tree fallback
      count += countRecursiveTreeLeaves(subject.children);
    } else {
      count += 1;
    }
  }

  return count;
}

function countRecursiveTreeLeaves(nodes) {
  let c = 0;
  for (const node of nodes) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      c += countRecursiveTreeLeaves(node.children);
    } else {
      c += 1;
    }
  }
  return c;
}

/**
 * Counts how many leaf subtopics are marked completed in a 4-level study plan
 */
export function countCompletedLeafNodes(planOrSubjects, completedIdsSet = null) {
  if (!planOrSubjects) return 0;
  const subjects = Array.isArray(planOrSubjects) ? planOrSubjects : planOrSubjects.subjects || [];

  const completedSet =
    completedIdsSet || new Set((planOrSubjects.completedChapterIds || []).map(String));

  let completed = 0;

  for (const subject of subjects) {
    for (const chapter of subject.chapters || []) {
      for (const topic of chapter.topics || []) {
        if (Array.isArray(topic.subtopics) && topic.subtopics.length > 0) {
          for (const subtopic of topic.subtopics) {
            const subId = String(
              subtopic.nodeId ||
                subtopic._id ||
                subtopic.id ||
                `${subject.subjectName || subject.name}-${chapter.chapterName || chapter.title}-${topic.title}-${subtopic.title}`
            );
            if (subtopic.isCompleted || completedSet.has(subId)) {
              completed++;
            }
          }
        } else {
          const tId = String(topic.id || topic._id || `${chapter.chapterName}-${topic.title}`);
          if (topic.isCompleted || completedSet.has(tId)) {
            completed++;
          }
        }
      }
    }
  }

  return completed;
}

/**
 * Calculates today's study target by traversing down to subtopics
 * Daily Target = Math.ceil(remainingTopics / remainingValidDays)
 */
export async function calculateTodayTarget(studyPlanOrId, referenceDate = new Date()) {
  let studyPlan = studyPlanOrId;

  if (typeof studyPlanOrId === 'string' || (studyPlanOrId && studyPlanOrId._bsontype)) {
    studyPlan = await StudyPlan.findById(studyPlanOrId).populate('examId').lean();
  }

  if (!studyPlan) {
    return {
      todayTarget: 0,
      activeStudyDayPace: 0,
      remainingTopics: 0,
      remainingValidDays: 0,
      isStudyDay: true,
      daysUntilExam: 0,
      dailyPaceNeeded: 0,
    };
  }

  // Calculate total leaf nodes (subtopics)
  let totalTopics = 0;
  if (Array.isArray(studyPlan.subjects) && studyPlan.subjects.length > 0) {
    totalTopics = countLeafNodes(studyPlan.subjects);
  }
  if (!totalTopics && studyPlan.examId?.subjects) {
    totalTopics = countLeafNodes(studyPlan.examId.subjects);
  }
  if (!totalTopics) {
    totalTopics = Number(studyPlan.targetQuantity) || Number(studyPlan.totalTopics) || 0;
  }

  // Calculate completed leaf nodes
  let completedTopics = 0;
  if (Array.isArray(studyPlan.subjects) && studyPlan.subjects.length > 0) {
    completedTopics = countCompletedLeafNodes(studyPlan);
  }
  if (!completedTopics && Array.isArray(studyPlan.completedChapterIds)) {
    completedTopics = studyPlan.completedChapterIds.length;
  }
  if (!completedTopics) {
    completedTopics = Number(studyPlan.completedQuantity) || Number(studyPlan.completedTopics) || 0;
  }

  const remainingTopics = Math.max(0, totalTopics - completedTopics);

  if (remainingTopics === 0) {
    return {
      todayTarget: 0,
      activeStudyDayPace: 0,
      remainingTopics: 0,
      remainingValidDays: 0,
      isStudyDay: true,
      daysUntilExam: 0,
      dailyPaceNeeded: 0,
      totalTopics,
      completedTopics,
      goalType: studyPlan.goalType || 'topics',
      customGoalTitle: studyPlan.customGoalTitle || '',
      goalUnit: studyPlan.goalUnit || 'Topics',
      targetQuantity: Number(studyPlan.targetQuantity) || totalTopics,
      completedQuantity: Number(studyPlan.completedQuantity) || completedTopics,
      remainingQuantity: 0,
      dailyTargetQuantity: 0,
      estimatedHoursPerTopic: Number(studyPlan.estimatedHoursPerTopic) || 1,
      estimatedDailyHours: 0,
      isSafeModeExceeded: false,
      safeModeWarning: null,
      safeModeSuggestions: [],
      subjectWorkloads: [],
    };
  }

  // Normalize reference date (today) to midnight
  const today = new Date(referenceDate);
  today.setHours(0, 0, 0, 0);

  // Normalize target date to midnight
  const target = new Date(studyPlan.targetDate);
  target.setHours(0, 0, 0, 0);

  // Study days array (defaults to all 7 days if empty)
  const studyDays =
    studyPlan.studyDays && studyPlan.studyDays.length > 0
      ? studyPlan.studyDays
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Normalize vacation dates to YYYY-MM-DD set
  const vacationSet = new Set(
    (studyPlan.vacationDates || []).map((v) => getTodayDateString(new Date(v)))
  );

  const todayStr = getTodayDateString(today);
  const todayDayName = DAY_NAMES[today.getDay()];
  const isTodayStudyDay = studyDays.includes(todayDayName) && !vacationSet.has(todayStr);

  // Calculate remaining valid study days (excluding vacations)
  let validDaysCount = 0;

  // Loop from tomorrow until the targetDate
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1);

  while (cursor <= target) {
    const dayName = DAY_NAMES[cursor.getDay()];
    const cursorDateStr = getTodayDateString(cursor);
    const isVacation = vacationSet.has(cursorDateStr);

    if (studyDays.includes(dayName) && !isVacation) {
      validDaysCount++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // If today is a valid study day and not past target and not vacation, add 1 to the count
  if (isTodayStudyDay && today <= target) {
    validDaysCount += 1;
  }

  const calendarDaysLeft = Math.max(0, Math.ceil((target - today) / (1000 * 60 * 60 * 24)));

  // Adaptive Math Formula: ⌈Remaining Topics / Remaining Valid Days⌉
  let todayTarget;
  if (validDaysCount <= 0) {
    todayTarget = remainingTopics;
  } else if (!isTodayStudyDay) {
    todayTarget = 0;
  } else {
    todayTarget = Math.ceil(remainingTopics / validDaysCount);
  }

  // Active study day pace (the target on valid study days)
  const activeStudyDayPace =
    validDaysCount > 0 ? Math.ceil(remainingTopics / validDaysCount) : remainingTopics;

  // Safe Mode Evaluation: Flag if required study load exceeds human limits (>12 hrs/day)
  const estimatedHoursPerTopic = Number(studyPlan.estimatedHoursPerTopic) || 1;
  const estimatedDailyHours = todayTarget * estimatedHoursPerTopic;
  const SAFE_MODE_MAX_HOURS = 12;
  const isSafeModeExceeded = estimatedDailyHours > SAFE_MODE_MAX_HOURS;
  const safeModeWarning = isSafeModeExceeded
    ? '⚠️ Safe Mode: Daily study workload exceeds realistic human limits (>12 hrs/day). Consider extending your exam date or pruning low-weight chapters.'
    : null;
  const safeModeSuggestions = isSafeModeExceeded
    ? [
        'Extend exam target date to lower daily required pace',
        'Prioritize high-yield chapters and prune low-weight topics',
        'Add more valid study days to your weekly schedule',
      ]
    : [];

  // Subject-level workload breakdown
  const subjectWorkloads = [];
  if (Array.isArray(studyPlan.subjects) && studyPlan.subjects.length > 0) {
    const completedSet = new Set((studyPlan.completedChapterIds || []).map(String));
    for (const subject of studyPlan.subjects) {
      const sName = subject.subjectName || subject.name || 'Subject';
      const sTotal = countLeafNodes([subject]);
      const sCompleted = countCompletedLeafNodes([subject], completedSet);
      const sRemaining = Math.max(0, sTotal - sCompleted);
      const sPace = validDaysCount > 0 ? Math.ceil(sRemaining / validDaysCount) : sRemaining;
      const sHours = sPace * estimatedHoursPerTopic;
      subjectWorkloads.push({
        subjectName: sName,
        totalTopics: sTotal,
        completedTopics: sCompleted,
        remainingTopics: sRemaining,
        dailyPace: sPace,
        estimatedDailyHours: sHours,
        isSafeModeExceeded: sHours > SAFE_MODE_MAX_HOURS,
      });
    }
  }

  // Dynamic Goal Support (e.g. "Solve 500 MCQs" or "Complete 120 Subtopics")
  const goalType = studyPlan.goalType || 'topics';
  const customGoalTitle = studyPlan.customGoalTitle || '';
  const goalUnit = studyPlan.goalUnit || 'Topics';
  const targetQuantity = Number(studyPlan.targetQuantity) || totalTopics;
  const completedQuantity = Number(studyPlan.completedQuantity) || completedTopics;
  const remainingQuantity = Math.max(0, targetQuantity - completedQuantity);
  const dailyTargetQuantity =
    validDaysCount > 0 ? Math.ceil(remainingQuantity / validDaysCount) : remainingQuantity;

  return {
    todayTarget,
    activeStudyDayPace,
    remainingTopics,
    remainingValidDays: validDaysCount,
    isStudyDay: isTodayStudyDay,
    daysUntilExam: calendarDaysLeft,
    totalTopics,
    completedTopics,
    vacationDaysCount: vacationSet.size,
    // Safe Mode Engine
    estimatedHoursPerTopic,
    estimatedDailyHours,
    isSafeModeExceeded,
    safeModeWarning,
    safeModeSuggestions,
    subjectWorkloads,
    // Autonomous Goal Distribution
    goalType,
    customGoalTitle,
    goalUnit,
    targetQuantity,
    completedQuantity,
    remainingQuantity,
    dailyTargetQuantity,
  };
}

/**
 * Spaced Repetition System (SRS) Multiplier: [3, 7, 21, 45] days
 * Calculates the next review date and review cycle based on retention curve
 */
export function calculateSpacedRepetition(reviewCount = 0, currentDate = new Date()) {
  const intervals = [3, 7, 21, 45];
  const count = Math.max(0, Number(reviewCount) || 0);
  const daysToAdd = intervals[Math.min(count, intervals.length - 1)];
  const nextDate = new Date(currentDate);
  nextDate.setDate(nextDate.getDate() + daysToAdd);
  return {
    nextReviewDate: nextDate,
    reviewCount: count + 1,
    daysAdded: daysToAdd,
  };
}

export const calculateDailyTarget = calculateTodayTarget;
export default calculateTodayTarget;
