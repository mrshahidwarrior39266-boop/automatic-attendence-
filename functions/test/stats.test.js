'use strict';
// Owner statistics: classStats aggregates attendance across a class's sessions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('../../harness/harness');

const h = createHarness();
const { db, handlers: fns, call, tokenNow } = h;
const rejects = async (promise, status) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, status, `expected ${status}, got ${e.code}: ${e.message}`);
    return true;
  });
};
const clearRate = () => {
  for (const key of [...db._dump().keys()]) if (key.startsWith('rateLimits/')) db._dump().delete(key);
};

const CLASS = 'class-1';
const OWNER = 'owner-1';
const TEACHER = 'teacher-1';
const S1 = 'student-1'; const S2 = 'student-2'; const S3 = 'student-3';
const D1 = 'device-aaa-111111'; const D2 = 'device-bbb-222222'; const D3 = 'device-ccc-333333';

test('seed class with three enrolled students', async () => {
  await db.doc(`classes/${CLASS}`).set({ ownerUid: OWNER, teacherUid: TEACHER });
  for (const s of [S1, S2, S3]) await db.doc(`classes/${CLASS}/enrollments/${s}`).set({ active: true });
});

test('classStats rejects a non-owner', async () => {
  await rejects(call(fns.classStats, TEACHER, { classId: CLASS }), 'permission-denied');
  await rejects(call(fns.classStats, OWNER, { classId: 'nope' }), 'permission-denied');
});

// Session A: S1 + S2 present, S3 absent.
test('session A records two present students', async () => {
  clearRate();
  const s = await call(fns.startSession, TEACHER, {
    classId: CLASS, durationMin: 45, mode: 'passive', presence: { minSightings: 1, minDwellMs: 0 },
  });
  await call(fns.reportPresence, S1, { shortId: s.shortId, token: tokenNow(s.secret), deviceId: D1, rssi: -58 });
  await call(fns.reportPresence, S2, { shortId: s.shortId, token: tokenNow(s.secret), deviceId: D2, rssi: -66 });
  await call(fns.endSession, TEACHER, { sessionId: s.sessionId });
  assert.equal(db._dump().get(`sessions/${s.sessionId}`).summary.present, 2);
});

// Session B: S2 + S3 present, S1 absent.
test('session B records a different set', async () => {
  clearRate();
  const s = await call(fns.startSession, TEACHER, {
    classId: CLASS, durationMin: 45, mode: 'passive', presence: { minSightings: 1, minDwellMs: 0 },
  });
  await call(fns.reportPresence, S2, { shortId: s.shortId, token: tokenNow(s.secret), deviceId: D2, rssi: -60 });
  await call(fns.reportPresence, S3, { shortId: s.shortId, token: tokenNow(s.secret), deviceId: D3, rssi: -72 });
  await call(fns.endSession, TEACHER, { sessionId: s.sessionId });
});

test('classStats aggregates per-student attendance for the owner', async () => {
  const res = await call(fns.classStats, OWNER, { classId: CLASS });
  assert.equal(res.totals.sessions, 2);
  assert.equal(res.totals.enrolled, 3);
  assert.equal(res.totals.presentRate, 4 / 6); // 4 present across 2 sessions x 3 students

  const byUid = Object.fromEntries(res.students.map((s) => [s.uid, s]));
  assert.deepEqual(byUid[S1], { uid: S1, sessions: 2, attended: 1, flagged: 0 });
  assert.deepEqual(byUid[S2], { uid: S2, sessions: 2, attended: 2, flagged: 0 });
  assert.deepEqual(byUid[S3], { uid: S3, sessions: 2, attended: 1, flagged: 0 });

  assert.equal(res.sessions.length, 2);
  assert.deepEqual(res.sessions.map((s) => s.present), [2, 2]);
  assert.ok(res.sessions[0].startAtMs <= res.sessions[1].startAtMs, 'sessions sorted by start time');
});
