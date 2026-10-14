'use strict';
// End-to-end test of the real Cloud Functions handlers against an in-memory
// Firestore double (see ../../harness/harness.js). No emulator, credentials or
// Java required.
//
// It exercises the full lifecycle: startSession -> checkIn -> issueChallengeTask
// -> challengeResponse -> endSession, asserting the Firestore documents that are
// written, the task-queue entries that are scheduled and the pushes that are sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createHarness } = require('../../harness/harness');

const h = createHarness();
const { db, handlers: fns, call, tokenNow: tokenFor } = h;

const rejects = async (promise, code) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
};

const TEACHER = 'teacher-1';
const OWNER = 'owner-1';
const STUDENT = 'student-1';
const STUDENT2 = 'student-2';
const CLASS = 'class-1';
const DEVICE = 'device-abc-123456';
const DEVICE2 = 'device-xyz-654321';

const clearRateLimits = () => {
  for (const key of [...db._dump().keys()]) {
    if (key.startsWith('rateLimits/')) db._dump().delete(key);
  }
};

let sessionId; let shortId; let secret;

test('seed class, enrollments and an FCM token', async () => {
  await db.doc(`classes/${CLASS}`).set({ ownerUid: OWNER, teacherUid: TEACHER });
  await db.doc(`classes/${CLASS}/enrollments/${STUDENT}`).set({ active: true });
  await db.doc(`classes/${CLASS}/enrollments/${STUDENT2}`).set({ active: true });
  await db.doc(`fcmTokens/${STUDENT}`).set({ token: 'fcm-token-student' });
  assert.equal(db._dump().size, 4);
});

test('startSession rejects a non-teacher', async () => {
  await rejects(call(fns.startSession, 'stranger', { classId: CLASS, durationMin: 45 }), 'permission-denied');
});

test('startSession creates an active session, secret, short id, lock and tasks', async () => {
  const beforeClose = h.queued.length;
  // manual mode: this suite exercises the token/QR path, not passive BLE presence
  const res = await call(fns.startSession, TEACHER, { classId: CLASS, durationMin: 45, mode: 'manual' });
  sessionId = res.sessionId;
  shortId = res.shortId;
  secret = res.secret;

  assert.match(sessionId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(shortId, /^[0-9a-f]{8}$/);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(res.slotSeconds, 15);
  assert.equal(res.endAtMs - res.startAtMs, 45 * 60000);

  const session = db._dump().get(`sessions/${sessionId}`);
  assert.equal(session.status, 'active');
  assert.equal(session.classId, CLASS);
  assert.equal(session.teacherUid, TEACHER);
  assert.equal(session.ownerUid, OWNER);
  assert.equal(session.shortId, shortId);
  assert.equal(session.mode, 'manual');

  assert.ok(db._dump().has(`sessionSecrets/${sessionId}`));
  assert.equal(db._dump().get(`sessionSecrets/${sessionId}`).secret, secret);
  assert.equal(db._dump().get(`shortIds/${shortId}`).sessionId, sessionId);
  assert.equal(db._dump().get(`activeSessions/${CLASS}`).sessionId, sessionId);

  const scheduled = h.queued.slice(beforeClose);
  assert.equal(scheduled.filter((q) => q.name.endsWith('closeSessionTask')).length, 1);
  const closeTask = scheduled.find((q) => q.name.endsWith('closeSessionTask'));
  assert.equal(closeTask.data.sessionId, sessionId);
  assert.equal(closeTask.opts.scheduleTime.getTime(), res.endAtMs);
  // 45 minute session -> two challenges, each scheduled before the session ends.
  const challengeTasks = scheduled.filter((q) => q.name.endsWith('issueChallengeTask'));
  assert.equal(challengeTasks.length, 2);
  for (const t of challengeTasks) {
    assert.equal(t.data.sessionId, sessionId);
    assert.ok(t.opts.scheduleTime.getTime() < res.endAtMs);
  }
});

const tokenNow = () => tokenFor(secret);

test('checkIn rejects a bad token, a wrong device and an unenrolled student', async () => {
  await rejects(call(fns.checkIn, STUDENT, { shortId, token: 'deadbeefcafe', deviceId: DEVICE }), 'permission-denied');
  await rejects(call(fns.checkIn, STUDENT, { shortId: 'ffffffff', token: tokenNow(), deviceId: DEVICE }), 'not-found');

  const otherSecret = 'b2'.repeat(32);
  await rejects(
    call(fns.checkIn, STUDENT, { shortId, token: tokenFor(otherSecret), deviceId: DEVICE }),
    'permission-denied',
  );
});

test('checkIn succeeds, binds the device and shards a counter', async () => {
  clearRateLimits();
  const res = await call(fns.checkIn, STUDENT, { shortId, token: tokenNow(), deviceId: DEVICE });
  assert.equal(res.status, 'checked-in');

  const checkin = db._dump().get(`sessions/${sessionId}/checkins/${STUDENT}`);
  assert.ok(checkin);
  assert.deepEqual(checkin.dueChallenges, []);
  assert.deepEqual(checkin.passedChallenges, []);
  assert.equal(checkin.tokenSlot, require('../../harness/harness').slotOf(Date.now()));

  const deviceHash = crypto.createHash('sha256').update(DEVICE).digest('hex');
  assert.equal(db._dump().get(`bindings/${STUDENT}`).deviceHash, deviceHash);
  assert.equal(db._dump().get(`deviceOwners/${deviceHash}`).uid, STUDENT);

  const counters = [...db._dump().keys()].filter((k) => k.startsWith(`sessions/${sessionId}/counters/`));
  assert.equal(counters.length, 1);
});

test('checkIn is idempotent-rejected on the second attempt', async () => {
  await rejects(call(fns.checkIn, STUDENT, { shortId, token: tokenNow(), deviceId: DEVICE }), 'already-exists');
});

test('checkIn blocks another account presenting the same physical device', async () => {
  // STUDENT2 is enrolled, but has not bound a device; using STUDENT's device must fail.
  await rejects(call(fns.checkIn, STUDENT2, { shortId, token: tokenNow(), deviceId: DEVICE }), 'permission-denied');
});

test('issueChallengeTask delivers a challenge and notifies checkins', async () => {
  const before = h.pushes.length;
  await fns.issueChallengeTask({ data: { sessionId, challengeId: 'c1' } });

  const challenge = db._dump().get(`sessions/${sessionId}/challenges/c1`);
  assert.ok(challenge, 'challenge doc created');
  assert.ok(challenge.expiresAtMs > Date.now());

  const checkin = db._dump().get(`sessions/${sessionId}/checkins/${STUDENT}`);
  assert.deepEqual(checkin.dueChallenges, ['c1']);
  assert.equal(h.pushes.length, before + 1);
  assert.equal(h.pushes[h.pushes.length - 1].tokens.length, 1); // STUDENT has an FCM token
});

test('challengeResponse passes a due challenge and rejects a replay', async () => {
  clearRateLimits();
  const res = await call(fns.challengeResponse, STUDENT, {
    sessionId, challengeId: 'c1', token: tokenNow(), deviceId: DEVICE,
  });
  assert.equal(res.status, 'challenge-passed');
  assert.deepEqual(db._dump().get(`sessions/${sessionId}/checkins/${STUDENT}`).passedChallenges, ['c1']);

  await rejects(
    call(fns.challengeResponse, STUDENT, { sessionId, challengeId: 'c1', token: tokenNow(), deviceId: DEVICE }),
    'already-exists',
  );
});

test('challengeResponse rejects a response from a non-bound device', async () => {
  clearRateLimits();
  await fns.issueChallengeTask({ data: { sessionId, challengeId: 'c2' } });
  await rejects(
    call(fns.challengeResponse, STUDENT, { sessionId, challengeId: 'c2', token: tokenNow(), deviceId: DEVICE2 }),
    'permission-denied',
  );
});

test('endSession closes, cleans up secrets/short ids and writes a summary', async () => {
  const res = await call(fns.endSession, TEACHER, { sessionId });
  assert.equal(res.status, 'closed');

  const session = db._dump().get(`sessions/${sessionId}`);
  assert.equal(session.status, 'closed');
  // STUDENT passed c1 but never answered c2, so is flagged; STUDENT2 never checked in.
  assert.deepEqual(session.summary, { enrolled: 2, present: 1, pending: 0, flagged: 1 });
  assert.ok(session.notifiedAtMs > 0);
  assert.ok(!db._dump().has(`sessionSecrets/${sessionId}`));
  assert.ok(!db._dump().has(`shortIds/${shortId}`));
  assert.ok(!db._dump().has(`activeSessions/${CLASS}`));
});

test('a closed session no longer accepts check-ins', async () => {
  await rejects(call(fns.checkIn, STUDENT2, { shortId, token: tokenNow(), deviceId: DEVICE2 }), 'not-found');
});

test('endSession rejects a non-staff caller', async () => {
  await rejects(call(fns.endSession, 'stranger', { sessionId }), 'permission-denied');
});

test('approveDeviceReset clears a student binding for the class owner', async () => {
  const res = await call(fns.approveDeviceReset, OWNER, { classId: CLASS, studentUid: STUDENT });
  assert.equal(res.status, 'device-reset');
  assert.ok(!db._dump().has(`bindings/${STUDENT}`));
  await rejects(
    call(fns.approveDeviceReset, TEACHER, { classId: CLASS, studentUid: STUDENT }),
    'permission-denied',
  );
});
