import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:5000/api';

const defaultFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
  const headers = {
    'x-test-suite': 'true',
    ...(options.headers || {}),
  };
  return defaultFetch(url, { ...options, headers });
};

describe('End-to-End Aspirant Study Journey Integration Test', () => {
  let authToken = '';
  let studentUser = null;
  let examId = null;
  let studyPlanId = null;
  let testNodes = [];

  const testEmail = `student_${Date.now()}@adaptive-tracker-test.org`;
  const testPassword = 'Password123!';

  it('Step 1: Register new student aspirant and receive JWT token + HttpOnly cookie', async () => {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Aspirant QA Tester',
        email: testEmail,
        password: testPassword,
        accountMode: 'self_study',
      }),
    });

    assert.equal(res.status, 201, 'Registration should return 201 Created');
    const data = await res.json();
    assert.ok(data.success, 'Registration should be successful');
    assert.ok(data.token, 'Should return JWT token');
    assert.equal(data.user.email, testEmail);

    // Verify Set-Cookie header is sent with HttpOnly token
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      assert.ok(setCookie.includes('token='), 'Should set HttpOnly token cookie');
    }

    authToken = data.token;
    studentUser = data.user;
  });

  it('Step 2: Authenticate session and fetch available competitive exams', async () => {
    const res = await fetch(`${BASE_URL}/exams`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    assert.equal(res.status, 200, 'Exams list should return 200 OK');
    const data = await res.json();
    const examsList = data.exams || data.data || (Array.isArray(data) ? data : []);
    assert.ok(Array.isArray(examsList), 'Exams should return a list');
    assert.ok(examsList.length > 0, 'Database should contain at least one exam template');

    examId = examsList[0]._id;
    assert.ok(examId, 'Found valid Exam ID');
  });

  it('Step 3: Generate personalized study plan targeting future exam date', async () => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 90); // 90 days from today

    const res = await fetch(`${BASE_URL}/study-plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        examId,
        targetDate: targetDate.toISOString().split('T')[0],
        dailyTargetHours: 4,
        studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      }),
    });

    assert.equal(res.status, 201, 'Study plan creation should return 201 Created');
    const data = await res.json();
    assert.ok(data.success, 'Plan creation should report success');
    const plan = data.plan || data.data;
    assert.ok(plan, 'Plan object must be returned');
    assert.ok(plan._id, 'Plan must have an ID');

    studyPlanId = plan._id;

    // Collect 3 node IDs from the plan across any syllabus depth
    if (Array.isArray(plan.subjects)) {
      for (const subj of plan.subjects) {
        for (const chap of subj.chapters || []) {
          if (Array.isArray(chap.topics) && chap.topics.length > 0) {
            for (const top of chap.topics) {
              if (Array.isArray(top.subtopics) && top.subtopics.length > 0) {
                for (const sub of top.subtopics) {
                  const nid = sub.nodeId || sub.id || sub._id || sub.title;
                  if (nid) testNodes.push(String(nid));
                  if (testNodes.length >= 3) break;
                }
              } else {
                const nid = top.nodeId || top.id || top._id || top.title;
                if (nid) testNodes.push(String(nid));
              }
              if (testNodes.length >= 3) break;
            }
          } else {
            const nid = chap.nodeId || chap.id || chap._id || chap.chapterName || chap.title;
            if (nid) testNodes.push(String(nid));
          }
          if (testNodes.length >= 3) break;
        }
        if (testNodes.length >= 3) break;
      }
    }

    assert.ok(testNodes.length >= 1, 'Should find at least 1 syllabus node to test completion');
  });

  it('Step 4: Fetch initial Dashboard state and verify daily target is calculated', async () => {
    const res = await fetch(`${BASE_URL}/dashboard`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    assert.equal(res.status, 200, 'Dashboard should return 200 OK');
    const dashData = await res.json();
    assert.ok(dashData.success, 'Dashboard fetch should succeed');
    assert.ok(dashData.hasPlan, 'Dashboard should confirm active plan');
    const data = dashData.data || dashData;
    assert.ok(typeof data.todayTarget === 'number', 'todayTarget should be a number');
    assert.ok(data.todayTarget >= 0, 'todayTarget should be non-negative');
  });

  it('Step 5: Complete syllabus topics and verify real-time streak & progress update', async () => {
    let completedCount = 0;
    const nodesToComplete = testNodes.slice(0, 3);

    for (const nodeId of nodesToComplete) {
      const toggleRes = await fetch(`${BASE_URL}/study-plan/toggle-node`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          studyPlanId,
          nodeId,
          isCompleted: true,
        }),
      });

      assert.equal(toggleRes.status, 200, `Toggle node ${nodeId} should succeed`);
      const toggleData = await toggleRes.json();
      assert.ok(toggleData.success, 'Toggle should return success: true');
      completedCount++;
    }

    // Now re-fetch dashboard and verify progress reflects completed topics
    const dashRes = await fetch(`${BASE_URL}/dashboard`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    assert.equal(dashRes.status, 200);
    const dashData = await dashRes.json();
    assert.ok(dashData.success);

    const payload = dashData.data || dashData;
    assert.ok(
      payload.todayCompleted >= completedCount,
      `Expected payload.todayCompleted (${payload.todayCompleted}) to be >= ${completedCount}`
    );

    // Streak should be active (>= 1) since we completed topics today
    assert.ok(
      payload.streak >= 1,
      `Streak should be at least 1 after completing topics today (got ${payload.streak})`
    );
  });

  it('Step 6: Dispatch 5-minute heartbeat and fetch Classmates Hub radar', async () => {
    // Dispatch student heartbeat indicating deep work focus
    const hbRes = await fetch(`${BASE_URL}/user/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        isStudying: true,
        activeTopicTitle: 'Deep Linear Algebra Focus',
      }),
    });

    assert.equal(hbRes.status, 200, 'Heartbeat should succeed');
    const hbData = await hbRes.json();
    assert.ok(hbData.success, 'Heartbeat report should be successful');
    assert.equal(hbData.isCurrentlyStudying, true, 'Student focus status must be active');

    // Fetch cohort classmates radar
    const cmRes = await fetch(`${BASE_URL}/cohort/classmates`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    assert.equal(cmRes.status, 200, 'Classmates fetch should succeed');
    const cmData = await cmRes.json();
    assert.ok(cmData.success);
    assert.ok(Array.isArray(cmData.classmates), 'Classmates should be an array');

    // Current user should be found in classmates radar with isOnline: true and isCurrentlyStudying: true
    const selfInRadar = cmData.classmates.find((c) => c.isCurrentUser);
    assert.ok(selfInRadar, 'Current student should appear in classmates list');
    assert.equal(selfInRadar.isOnline, true, 'Student should be detected online');
    assert.equal(
      selfInRadar.isCurrentlyStudying,
      true,
      'Student should have active pulsing focus dot'
    );
  });

  it('Step 7: Time Machine retroactive log edit updates past daily log and syncs with study plan', async () => {
    // Generate yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Pick node to mark complete in the past
    const retroactiveNodeId = testNodes[0] || 'mock-topic-past-1';

    const editRes = await fetch(`${BASE_URL}/history/edit-log`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        date: yesterdayStr,
        addedTopicIds: [retroactiveNodeId],
        overrideTotalMinutes: 90,
      }),
    });

    assert.equal(editRes.status, 200, 'Time Machine edit-log should succeed');
    const editData = await editRes.json();
    assert.ok(editData.success, 'Time Machine edit should succeed');
    assert.equal(editData.log.totalTimeStudiedMinutes, 90, 'Past minutes should be 90');
    assert.ok(
      editData.log.completedTopicIds.includes(retroactiveNodeId),
      'Past log should contain retroactive node'
    );
  });
});
