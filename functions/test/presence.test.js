'use strict';
// Passive BLE attendance: pure decision rules (decidePresence) plus an
// end-to-end run of the real handlers through the in-memory harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validate');
const { tokenForSlot, slotOf } = require('../src/token');
const { createHarness } = require('../../harness/harness');

// ---------------------------------------------------------------- unit: rules
const SECRET = 'a1'.repeat(32);
const START = 1_700_000_000_000;
const END = START + 45 * 60000;
const NOW = START + 10 * 60000;
const SESSION = {
  status: 'active', startAtMs: START, endAtMs: END, mode: 'passive',
  presence: { minSightings: 3, minDwellMs: 30000 },
};
const goodToken = tokenForSlot(SECRET, slotOf(NOW));
const base = (over = {}) => ({
  session: SESSION, secret: SECRET, enrolled: true, priorCheckin: null,
  presentedToken: goodToken, nowMs: NOW, seenAtMs: NOW,
  uid: 'student-1', deviceHash: 'hash-1', boundDeviceHash: null, deviceOwnerUid: null,
  rssi: -60, ...over,
});
const code = (r) => (r.ok ? 'ok' : r.code);

test('signalOk accepts plausible dBm and rejects garbage', () => {
  assert.equal(v.signalOk(-60), true);
  assert.equal(v.signalOk(0), true);
  assert.equal(v.signalOk(v.RSSI_MIN), true);
  assert.equal(v.signalOk(v.RSSI_MIN - 1), false);
  assert.equal(v.signalOk(5), false);
  assert.equal(v.signalOk(undefined), false);
  assert.equal(v.signalOk('x'), false);
  assert.equal(v.signalOk(NaN), false);
});

test('presence: a first sighting is pending, not yet present', () => {
  const r = v.decidePresence(base());
  assert.equal(r.ok, true);
  assert.equal(r.sightings, 1);
  assert.equal(r.firstSeenMs, NOW);
  assert.equal(r.confirmed, false);
});

test('presence: confirming after enough sightings over the dwell window', () => {
  const r = v.decidePresence(base({
    priorCheckin: { status: 'pending', lastSeenMs: NOW - 10000, firstSeenMs: NOW - 40000, sightings: 2 },
  }));
  assert.equal(r.sightings, 3);
  assert.equal(r.firstSeenMs, NOW - 40000);
  assert.equal(r.dwellMs, 40000);
  assert.equal(r.confirmed, true);
  assert.equal(r.newlyConfirmed, true);
});

test('presence: enough sightings but too short a dwell stays pending', () => {
  const r = v.decidePresence(base({
    priorCheckin: { status: 'pending', lastSeenMs: NOW - 5000, firstSeenMs: NOW - 20000, sightings: 2 },
  }));
  assert.equal(r.sightings, 3);
  assert.equal(r.dwellMs, 20000);
  assert.equal(r.confirmed, false);
});

test('presence: a long gap resets the dwell window', () => {
  const r = v.decidePresence(base({
    priorCheckin: { status: 'pending', lastSeenMs: NOW - 120000, firstSeenMs: NOW - 120000, sightings: 5 },
  }));
  assert.equal(r.sightings, 1);
  assert.equal(r.firstSeenMs, NOW);
  assert.equal(r.confirmed, false);
});

test('presence: an already-present student stays present without re-confirming', () => {
  const r = v.decidePresence(base({
    priorCheckin: { status: 'present', lastSeenMs: NOW - 1000, firstSeenMs: NOW - 1000, sightings: 9 },
  }));
  assert.equal(r.confirmed, true);
  assert.equal(r.newlyConfirmed, false);
});

test('presence: per-session thresholds are honoured', () => {
  const session = { ...SESSION, presence: { minSightings: 1, minDwellMs: 0 } };
  const r = v.decidePresence(base({ session }));
  assert.equal(r.confirmed, true);
  assert.equal(r.newlyConfirmed, true);
});

test('presence: weak, stale and malformed sightings are rejected', () => {
  assert.equal(code(v.decidePresence(base({ rssi: -90 }))), 'weak-signal');
  assert.equal(code(v.decidePresence(base({ rssi: undefined }))), 'weak-signal');
  assert.equal(code(v.decidePresence(base({ seenAtMs: NOW - 120000 }))), 'stale-reading');
});

test('presence: every gate mirrors check-in', () => {
  assert.equal(code(v.decidePresence(base({ session: null }))), 'session-not-found');
  assert.equal(code(v.decidePresence(base({ session: { ...SESSION, status: 'closed' } }))), 'session-closed');
  assert.equal(code(v.decidePresence(base({ nowMs: START - 1 }))), 'outside-window');
  assert.equal(code(v.decidePresence(base({ nowMs: END + 1 }))), 'outside-window');
  assert.equal(code(v.decidePresence(base({ enrolled: false }))), 'not-enrolled');
  assert.equal(code(v.decidePresence(base({ presentedToken: tokenForSlot(SECRET, slotOf(NOW) - 5) }))), 'invalid-token');
  assert.equal(code(v.decidePresence(base({ boundDeviceHash: 'other' }))), 'device-mismatch');
  assert.equal(code(v.decidePresence(base({ deviceOwnerUid: 'someone' }))), 'device-in-use');
});

test('presence counts: pending is not present and is never flagged', () => {
  const rows = [
    { status: 'present', dueChallenges: ['c1'], passedChallenges: [] },   // flagged
    { status: 'pending', dueChallenges: ['c1'], passedChallenges: [] },   // not present, not flagged
    { status: 'present', dueChallenges: ['c1'], passedChallenges: ['c1'] },
    { dueChallenges: [], passedChallenges: [] },                          // legacy = present
  ];
  assert.equal(v.countPresent(rows), 3);
  assert.equal(v.countPending(rows), 1);
  assert.equal(v.countFlagged(rows), 1);
});

test('rate limiting: the presence bucket has a much larger allowance', () => {
  let state = null;
  for (let i = 0; i < v.PRESENCE_MAX_ATTEMPTS; i++) {
    const r = v.nextRateState(state, NOW + i, v.PRESENCE_MAX_ATTEMPTS);
    assert.equal(r.allowed, true);
    state = r.state;
  }
  assert.equal(v.nextRateState(state, NOW + 100, v.PRESENCE_MAX_ATTEMPTS).allowed, false);
  assert.equal(v.nextRateState(null, NOW, v.MAX_ATTEMPTS).allowed, true); // default stays 5
});

// -------------------------------------------------------- end-to-end: handlers
const h = createHarness();
const { db, handlers: fns, call, tokenNow } = h;
const clearRate = () => {
  for (const key of [...db._dump().keys()]) {
    if (key.startsWith('rateLimits/')) db._dump().delete(key);
  }
};
const rejects = async (promise, status) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, status, `expected ${status}, got ${e.code}: ${e.message}`);
    return true;
  });
};

const CLASS = 'class-1';
const CLASS2 = 'class-2';
const CLASS3 = 'class-3';
const OWNER = 'owner-1';
const TEACHER = 'teacher-1';
const S1 = 'student-1';
const S2 = 'student-2';
const D1 = 'device-abc-123456';
const D2 = 'device-xyz-654321';

let sessionId; let shortId; let secret;
const token = () => tokenNow(secret);

test('seed classes, enrollments and FCM tokens', async () => {
  for (const c of [CLASS, CLASS2, CLASS3]) {
    await db.doc(`classes/${c}`).set({ ownerUid: OWNER, teacherUid: TEACHER });
  }
  await db.doc(`classes/${CLASS}/enrollments/${S1}`).set({ active: true });
  await db.doc(`classes/${CLASS}/enrollments/${S2}`).set({ active: true });
  await db.doc(`classes/${CLASS2}/enrollments/${S1}`).set({ active: true });
  await db.doc(`fcmTokens/${S1}`).set({ token: 'fcm-token-1' });
  await db.doc(`fcmTokens/${S2}`).set({ token: 'fcm-token-2' });
});

test('startSession stores passive mode and presence thresholds', async () => {
  const res = await call(fns.startSession, TEACHER, {
    classId: CLASS, durationMin: 45, mode: 'passive', presence: { minSightings: 1, minDwellMs: 0 },
  });
  sessionId = res.sessionId; shortId = res.shortId; secret = res.secret;
  const s = db._dump().get(`sessions/${sessionId}`);
  assert.equal(s.mode, 'passive');
  assert.deepEqual(s.presence, { minSightings: 1, minDwellMs: 0 });
});

test('reportPresence confirms attendance passively and binds the device', async () => {
  const r1 = await call(fns.reportPresence, S1, { shortId, token: token(), deviceId: D1, rssi: -60 });
  assert.equal(r1.status, 'present');
  assert.equal(r1.confirmed, true);
  assert.equal(r1.sightings, 1);

  const r2 = await call(fns.reportPresence, S2, { shortId, token: token(), deviceId: D2, rssi: -70 });
  assert.equal(r2.status, 'present');

  const c1 = db._dump().get(`sessions/${sessionId}/checkins/${S1}`);
  assert.equal(c1.status, 'present');
  assert.equal(c1.bestRssi, -60);
  assert.ok(c1.confirmedAtMs > 0);
  assert.ok(db._dump().has(`bindings/${S1}`));
});

test('sessionSummary reports live attendance to staff only', async () => {
  clearRate();
  const sum = await call(fns.sessionSummary, TEACHER, { sessionId });
  assert.deepEqual(sum, { status: 'active', mode: 'passive', enrolled: 2, present: 2, pending: 0, flagged: 0 });
  await rejects(call(fns.sessionSummary, 'stranger', { sessionId }), 'permission-denied');
});

test('passive challenge probes go out and require in-room signal to answer', async () => {
  clearRate();
  const before = h.pushes.length;
  await fns.issueChallengeTask({ data: { sessionId, challengeId: 'c1' } });
  const push = h.pushes[h.pushes.length - 1];
  assert.equal(h.pushes.length, before + 1);
  assert.equal(push.data.type, 'presence-probe');
  assert.equal(push.tokens.length, 2);

  // A passive response without BLE evidence is refused; with it, it passes.
  await rejects(
    call(fns.challengeResponse, S1, { sessionId, challengeId: 'c1', token: token(), deviceId: D1 }),
    'failed-precondition',
  );
  const ok = await call(fns.challengeResponse, S1, {
    sessionId, challengeId: 'c1', token: token(), deviceId: D1, rssi: -58,
  });
  assert.equal(ok.status, 'challenge-passed');
});

test('reportPresence refuses an out-of-range signal', async () => {
  clearRate();
  await rejects(
    call(fns.reportPresence, S2, { shortId, token: token(), deviceId: D2, rssi: -95 }),
    'failed-precondition',
  );
});

test('endSession writes a passive summary (unanswered probe is flagged)', async () => {
  const res = await call(fns.endSession, TEACHER, { sessionId });
  assert.equal(res.status, 'closed');
  const s = db._dump().get(`sessions/${sessionId}`);
  assert.deepEqual(s.summary, { enrolled: 2, present: 2, pending: 0, flagged: 1 });
});

test('default thresholds leave a single sighting pending', async () => {
  clearRate();
  const res = await call(fns.startSession, TEACHER, { classId: CLASS2, durationMin: 45, mode: 'passive' });
  const r = await call(fns.reportPresence, S1, {
    shortId: res.shortId, token: tokenNow(res.secret), deviceId: 'device-abc-123456', rssi: -62,
  });
  assert.equal(r.status, 'pending');
  const sum = await call(fns.sessionSummary, TEACHER, { sessionId: res.sessionId });
  assert.equal(sum.present, 0);
  assert.equal(sum.pending, 1);
  await call(fns.endSession, TEACHER, { sessionId: res.sessionId });
});

test('passive reporting is not throttled by the small manual attempt limit', async () => {
  clearRate();
  const res = await call(fns.startSession, TEACHER, {
    classId: CLASS2, durationMin: 45, mode: 'passive', presence: { minSightings: 1, minDwellMs: 0 },
  });
  // 8 quick sightings: well past the 5/minute manual limit, allowed on the presence bucket.
  for (let i = 0; i < 8; i++) {
    await call(fns.reportPresence, S1, { shortId: res.shortId, token: tokenNow(res.secret), deviceId: D1, rssi: -62 });
  }
  assert.ok(db._dump().has(`rateLimits/${S1}-presence`), 'presence reports use their own bucket');
  assert.ok(!db._dump().has(`rateLimits/${S1}`), 'the manual bucket is untouched by passive reports');
  await call(fns.endSession, TEACHER, { sessionId: res.sessionId });
});

test('issueChallengeTask fans out to a large class without the old 450 cap', async () => {
  const N = 600;
  const res = await call(fns.startSession, TEACHER, { classId: CLASS3, durationMin: 45, mode: 'manual' });
  for (let i = 0; i < N; i++) {
    await db.doc(`sessions/${res.sessionId}/checkins/student-${i}`).set({ dueChallenges: [], passedChallenges: [] });
  }
  await fns.issueChallengeTask({ data: { sessionId: res.sessionId, challengeId: 'c1' } });
  await fns.issueChallengeTask({ data: { sessionId: res.sessionId, challengeId: 'c1' } }); // idempotent retry

  const docs = [...db._dump().entries()].filter(([k]) => k.startsWith(`sessions/${res.sessionId}/checkins/`));
  assert.equal(docs.length, N);
  assert.ok(docs.every(([, d]) => d.dueChallenges.length === 1 && d.dueChallenges[0] === 'c1'),
    'every check-in got exactly one challenge (no duplicate on retry)');
  assert.ok(db._dump().has(`sessions/${res.sessionId}/challenges/c1`));
});
