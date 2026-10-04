import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:5000/api';

async function apiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`;
  const headers = {
    'x-test-suite': 'true',
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

describe('Auth Validation, Security & Teacher Cohort Integration Tests', () => {
  const timestamp = Date.now();
  const validEmail = `aspirant_auth_${timestamp}@adaptive-test.org`;
  const teacherEmail = `teacher_${timestamp}@adaptive-test.org`;
  const managedStudentEmail = `managed_student_${timestamp}@adaptive-test.org`;
  const testPassword = 'SecurePassword123!';

  let teacherToken = '';
  let teacherCode = '';
  let studentToken = '';

  it('rejects registration when email, password, or username are missing', async () => {
    // Missing email
    const resNoEmail = await apiFetch(`/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'No Email User', password: testPassword }),
    });
    assert.ok(resNoEmail.status >= 400, 'Should reject registration without email');

    // Missing password
    const resNoPass = await apiFetch(`/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'No Pass User', email: `nopass_${timestamp}@test.org` }),
    });
    assert.ok(resNoPass.status >= 400, 'Should reject registration without password');
  });

  it('registers a Teacher user and assigns a 6-character unique teacherCode', async () => {
    const res = await apiFetch(`/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Prof. Ramanujan',
        email: teacherEmail,
        password: testPassword,
        accountMode: 'teacher',
        cohortNotes: 'GATE Mathematics Mentorship 2026',
      }),
    });

    assert.equal(res.status, 201, 'Teacher registration should return 201 Created');
    const data = await res.json();
    assert.ok(data.success, 'Registration should be successful');
    assert.ok(data.token, 'Should return JWT token');
    assert.equal(data.user.role, 'teacher');
    assert.ok(data.user.teacherCode, 'Teacher must have a teacherCode');
    assert.equal(data.user.teacherCode.length, 6, 'Teacher code must be 6 characters');

    teacherToken = data.token;
    teacherCode = data.user.teacherCode;
  });

  it('rejects managed student registration with an invalid teacherCode', async () => {
    const res = await apiFetch(`/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Orphan Student',
        email: `orphan_${timestamp}@test.org`,
        password: testPassword,
        accountMode: 'managed',
        teacherCode: 'NON999', // Invalid code
      }),
    });

    assert.equal(res.status, 400, 'Invalid teacherCode should be rejected with 400');
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(
      data.message.toLowerCase().includes('teacher invite code'),
      'Error message should mention teacher invite code'
    );
  });

  it('registers a managed student linked to the teacher via teacherCode', async () => {
    const res = await apiFetch(`/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Cohort Aspirant',
        email: managedStudentEmail,
        password: testPassword,
        accountMode: 'managed',
        teacherCode,
      }),
    });

    assert.equal(res.status, 201, 'Managed student should register with 201 Created');
    const data = await res.json();
    assert.ok(data.success);
    assert.equal(data.user.accountMode, 'managed');
    assert.equal(data.user.teacherName, 'Prof. Ramanujan');
    assert.equal(data.user.cohortNotes, 'GATE Mathematics Mentorship 2026');
  });

  it('rejects registration with a duplicate email', async () => {
    const res = await apiFetch(`/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Duplicate Imposter',
        email: teacherEmail,
        password: testPassword,
      }),
    });

    assert.equal(res.status, 400, 'Duplicate email must be rejected with 400 Bad Request');
    const data = await res.json();
    assert.equal(data.success, false);
  });

  it('authenticates a valid user and issues JWT token', async () => {
    const res = await apiFetch(`/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: teacherEmail,
        password: testPassword,
      }),
    });

    assert.equal(res.status, 200, 'Valid login should return 200 OK');
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(data.token, 'Should return token');
    assert.equal(data.user.email, teacherEmail);
  });

  it('rejects login with incorrect password', async () => {
    const res = await apiFetch(`/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: teacherEmail,
        password: 'WrongPassword999!',
      }),
    });

    assert.ok(res.status >= 400 && res.status <= 401, 'Wrong password must be rejected');
    const data = await res.json();
    assert.equal(data.success, false);
  });

  it('protects /api/auth/me endpoint from unauthenticated requests', async () => {
    // No Authorization header
    const resNoAuth = await apiFetch(`/auth/me`);
    assert.equal(resNoAuth.status, 401, 'Unauthenticated /auth/me should return 401');

    // Invalid bearer token
    const resBadToken = await apiFetch(`/auth/me`, {
      headers: { Authorization: 'Bearer invalid.fake.token' },
    });
    assert.equal(resBadToken.status, 401, 'Malformed token should return 401');
  });

  it('returns current authenticated user profile on /api/auth/me without sensitive password hash', async () => {
    const res = await apiFetch(`/auth/me`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });

    assert.equal(res.status, 200, 'Authenticated request to /auth/me should return 200');
    const data = await res.json();
    assert.ok(data.success);
    assert.equal(data.user.email, teacherEmail);
    assert.equal(
      data.user.password,
      undefined,
      'Password hash must never be returned in user payload'
    );
  });
});
