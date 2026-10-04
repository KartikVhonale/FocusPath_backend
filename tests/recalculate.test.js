import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTodayTarget,
  countLeafNodes,
  countCompletedLeafNodes,
  getTodayDateString,
} from '../utils/recalculate.js';

describe('Adaptive Recalculation Engine & Math Protection', () => {
  const mockSyllabus = [
    {
      subjectName: 'Engineering Mathematics',
      chapters: [
        {
          chapterName: 'Linear Algebra',
          topics: [
            {
              title: 'Matrices',
              subtopics: [
                { title: 'Rank of a Matrix', isCompleted: false },
                { title: 'Eigenvalues & Eigenvectors', isCompleted: false },
              ],
            },
            {
              title: 'Determinants',
              subtopics: [{ title: 'Properties of Determinants', isCompleted: false }],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Computer Networks',
      chapters: [
        {
          chapterName: 'IP Addressing',
          topics: [
            {
              title: 'Subnetting',
              subtopics: [
                { title: 'CIDR Notation', isCompleted: false },
                { title: 'VLSM Calculation', isCompleted: false },
              ],
            },
          ],
        },
      ],
    },
  ];

  it('correctly calculates atomic leaf nodes (subtopics) across nested hierarchy', () => {
    const totalLeaves = countLeafNodes(mockSyllabus);
    // 2 (Matrices) + 1 (Determinants) + 2 (IP Addressing) = 5 subtopics
    assert.equal(totalLeaves, 5);
  });

  it('handles divide-by-zero protection when targetDate is today (0 remaining days)', async () => {
    const today = new Date();
    const todayStr = getTodayDateString(today);

    const plan = {
      targetDate: todayStr,
      studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      vacationDates: [],
      subjects: mockSyllabus,
    };

    const result = await calculateTodayTarget(plan, today);

    // When exam date is today, validDaysCount is 1 (today is study day)
    // All remaining topics should be scheduled without throwing divide-by-zero NaN or Infinity
    assert.ok(!Number.isNaN(result.todayTarget), 'todayTarget must not be NaN');
    assert.ok(Number.isFinite(result.todayTarget), 'todayTarget must be finite');
    assert.equal(result.remainingTopics, 5);
    assert.equal(result.todayTarget, 5);
  });

  it('safely handles targetDate in the past (0 valid days remaining)', async () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);

    const plan = {
      targetDate: pastDate,
      studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      vacationDates: [],
      subjects: mockSyllabus,
    };

    const result = await calculateTodayTarget(plan, new Date());

    assert.equal(result.remainingValidDays, 0);
    // Even with 0 remaining days, it should safely return all remaining topics rather than Infinity
    assert.equal(result.todayTarget, 5);
    assert.ok(Number.isFinite(result.todayTarget));
  });

  it('returns 0 target when 100% of syllabus is completed', async () => {
    const completedSyllabus = JSON.parse(JSON.stringify(mockSyllabus));
    completedSyllabus.forEach((subj) =>
      subj.chapters.forEach((chap) =>
        chap.topics.forEach((top) =>
          top.subtopics.forEach((sub) => {
            sub.isCompleted = true;
          })
        )
      )
    );

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 10);

    const plan = {
      targetDate,
      studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      vacationDates: [],
      subjects: completedSyllabus,
    };

    const result = await calculateTodayTarget(plan, new Date());

    assert.equal(result.remainingTopics, 0);
    assert.equal(result.todayTarget, 0);
    assert.equal(result.activeStudyDayPace, 0);
  });

  it('properly subtracts vacation days from remaining valid study days', async () => {
    const today = new Date('2026-10-01T00:00:00.000Z');
    const targetDate = new Date('2026-10-10T00:00:00.000Z'); // 10 days span

    // 2 vacation days in that range
    const vacationDates = ['2026-10-03', '2026-10-04'];

    const plan = {
      targetDate,
      studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      vacationDates,
      subjects: mockSyllabus,
    };

    const resultWithVacations = await calculateTodayTarget(plan, today);

    const planNoVacations = {
      ...plan,
      vacationDates: [],
    };
    const resultNoVacations = await calculateTodayTarget(planNoVacations, today);

    assert.equal(resultWithVacations.remainingValidDays, resultNoVacations.remainingValidDays - 2);
  });

  it('returns todayTarget = 0 on non-study days while maintaining activeStudyDayPace', async () => {
    // Pick a date that is a Sunday
    const sundayDate = new Date('2026-10-04T00:00:00.000Z'); // 2026-10-04 is a Sunday
    const targetDate = new Date('2026-10-18T00:00:00.000Z');

    // Only study on Mon, Wed, Fri
    const plan = {
      targetDate,
      studyDays: ['Mon', 'Wed', 'Fri'],
      vacationDates: [],
      subjects: mockSyllabus,
    };

    const result = await calculateTodayTarget(plan, sundayDate);

    assert.equal(result.isStudyDay, false);
    assert.equal(result.todayTarget, 0);
    assert.ok(result.activeStudyDayPace > 0, 'Active study day pace should be calculated');
  });

  it('correctly calculates completed leaf nodes across nested syllabus tree', () => {
    const partiallyCompleted = JSON.parse(JSON.stringify(mockSyllabus));
    // Complete 2 out of 5 subtopics
    partiallyCompleted[0].chapters[0].topics[0].subtopics[0].isCompleted = true;
    partiallyCompleted[1].chapters[0].topics[0].subtopics[0].isCompleted = true;

    assert.equal(countCompletedLeafNodes(partiallyCompleted), 2);
    assert.equal(countCompletedLeafNodes([]), 0);
  });

  describe('Spaced Repetition System (SRS) Multiplier Algorithm', () => {
    const baseDate = new Date('2026-10-01T12:00:00.000Z');

    it('schedules Level 0 (1st review) at +3 days', async () => {
      const { calculateSpacedRepetition } = await import('../utils/recalculate.js');
      const res = calculateSpacedRepetition(0, baseDate);
      assert.equal(res.daysAdded, 3);
      assert.equal(res.reviewCount, 1);
      const expected = new Date(baseDate);
      expected.setDate(expected.getDate() + 3);
      assert.equal(res.nextReviewDate.getTime(), expected.getTime());
    });

    it('schedules Level 1 (2nd review) at +7 days', async () => {
      const { calculateSpacedRepetition } = await import('../utils/recalculate.js');
      const res = calculateSpacedRepetition(1, baseDate);
      assert.equal(res.daysAdded, 7);
      assert.equal(res.reviewCount, 2);
      const expected = new Date(baseDate);
      expected.setDate(expected.getDate() + 7);
      assert.equal(res.nextReviewDate.getTime(), expected.getTime());
    });

    it('schedules Level 2 (3rd review) at +21 days', async () => {
      const { calculateSpacedRepetition } = await import('../utils/recalculate.js');
      const res = calculateSpacedRepetition(2, baseDate);
      assert.equal(res.daysAdded, 21);
      assert.equal(res.reviewCount, 3);
      const expected = new Date(baseDate);
      expected.setDate(expected.getDate() + 21);
      assert.equal(res.nextReviewDate.getTime(), expected.getTime());
    });

    it('schedules Level 3 (4th review) at +45 days', async () => {
      const { calculateSpacedRepetition } = await import('../utils/recalculate.js');
      const res = calculateSpacedRepetition(3, baseDate);
      assert.equal(res.daysAdded, 45);
      assert.equal(res.reviewCount, 4);
      const expected = new Date(baseDate);
      expected.setDate(expected.getDate() + 45);
      assert.equal(res.nextReviewDate.getTime(), expected.getTime());
    });

    it('caps interval at +45 days for Level 4 and beyond', async () => {
      const { calculateSpacedRepetition } = await import('../utils/recalculate.js');
      const res = calculateSpacedRepetition(5, baseDate);
      assert.equal(res.daysAdded, 45);
      assert.equal(res.reviewCount, 6);
    });

    it('safely handles invalid, null, or negative reviewCount', async () => {
      const { calculateSpacedRepetition } = await import('../utils/recalculate.js');
      const resNegative = calculateSpacedRepetition(-2, baseDate);
      assert.equal(resNegative.daysAdded, 3);
      assert.equal(resNegative.reviewCount, 1);

      const resNull = calculateSpacedRepetition(null, baseDate);
      assert.equal(resNull.daysAdded, 3);
      assert.equal(resNull.reviewCount, 1);
    });
  });

  it('safely handles plan with empty syllabus subjects', async () => {
    const emptyPlan = {
      targetDate: new Date('2026-12-01T00:00:00.000Z'),
      studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      vacationDates: [],
      subjects: [],
    };
    const result = await calculateTodayTarget(emptyPlan, new Date('2026-10-01T00:00:00.000Z'));
    assert.equal(result.totalTopics, 0);
    assert.equal(result.remainingTopics, 0);
    assert.equal(result.todayTarget, 0);
    assert.equal(result.activeStudyDayPace, 0);
  });

  describe('Autonomous Distribution Engine (Planner DNA)', () => {
    it('splits massive goals (e.g., 500 MCQs) dynamically across remaining study days', async () => {
      const today = new Date('2026-10-01T00:00:00.000Z');
      const targetDate = new Date('2026-10-11T00:00:00.000Z'); // 11 days (10 valid study days remaining)

      const planWithGoal = {
        targetDate,
        studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        vacationDates: [],
        subjects: [],
        goalType: 'mcqs',
        customGoalTitle: 'Solve 500 MCQs in Physics',
        goalUnit: 'MCQs',
        targetQuantity: 500,
        completedQuantity: 100, // 400 remaining
      };

      const result = await calculateTodayTarget(planWithGoal, today);
      assert.equal(result.targetQuantity, 500);
      assert.equal(result.completedQuantity, 100);
      assert.equal(result.remainingQuantity, 400);
      // 400 MCQs / 11 valid days = Math.ceil(400 / 11) = 37
      assert.equal(result.dailyTargetQuantity, 37);
    });

    it('executes ruthless rollover absorbing missed topics into future daily workload', async () => {
      // Day 1: 50 total topics, 10 valid days -> pace is 5/day
      const day1 = new Date('2026-10-01T00:00:00.000Z');
      const targetDate = new Date('2026-10-10T00:00:00.000Z'); // 10 days total

      const plan = {
        targetDate,
        studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        vacationDates: [],
        totalTopics: 50,
        completedTopics: 0,
      };

      const day1Result = await calculateTodayTarget(plan, day1);
      assert.equal(day1Result.todayTarget, 5); // 50 / 10 = 5

      // Student was assigned 5 but only completed 3.
      // Day 2 (midnight rollover): 9 days left, 47 topics remaining (50 - 3 = 47)
      const day2 = new Date('2026-10-02T00:00:00.000Z');
      const planDay2 = {
        ...plan,
        completedTopics: 3, // Only 3 completed yesterday!
      };

      const day2Result = await calculateTodayTarget(planDay2, day2);
      // 47 / 9 valid days = Math.ceil(47 / 9) = 6 topics/day.
      // Notice the daily target automatically increased from 5 to 6 to absorb the 2 missed topics!
      assert.equal(day2Result.remainingTopics, 47);
      assert.equal(day2Result.todayTarget, 6);
      assert.ok(
        day2Result.todayTarget > day1Result.todayTarget,
        'Ruthless rollover must increase daily target'
      );
    });

    it('triggers Safe Mode override warning when daily required workload exceeds 12 hours', async () => {
      const today = new Date('2026-10-01T00:00:00.000Z');
      const targetDate = new Date('2026-10-03T00:00:00.000Z'); // Only 3 days left

      const heavyPlan = {
        targetDate,
        studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        vacationDates: [],
        totalTopics: 90, // 90 topics in 3 days = 30 topics/day
        completedTopics: 0,
        estimatedHoursPerTopic: 1, // 30 hrs/day > 12 hrs limit!
      };

      const result = await calculateTodayTarget(heavyPlan, today);
      assert.equal(result.todayTarget, 30);
      assert.equal(result.estimatedDailyHours, 30);
      assert.equal(result.isSafeModeExceeded, true);
      assert.ok(result.safeModeWarning.includes('Safe Mode'));
      assert.ok(result.safeModeSuggestions.length > 0);
    });
  });
});
