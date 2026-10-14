'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenForSlot, slotOf } = require('../src/token');
const v = require('../src/validate');

// Controlled fixtures: one class session, named students, fixed times.
const SECRET = 'a1'.repeat(32);
const START = 1_700_000_000_000;
const END = START + 45 * 60000;
const NOW = START + 10 * 60000;
const SESSION = { status: 'active', startAtMs: START, endAtMs: END };
const ASHA = { uid: 'student-asha', deviceHash: 'device-hash-asha' };
const BEN = { uid: 'student-ben', deviceHash: 'device-hash-ben' };
const goodToken = tokenForSlot(SECRET, slotOf(NOW));

function base(over = {}) {
  return {
    session: SESSION, secret: SECRET, enrolled: true, existingCheckin: false,
    presentedToken: goodToken, nowMs: NOW,
    uid: ASHA.uid, deviceHash: ASHA.deviceHash, boundDeviceHash: null, deviceOwnerUid: null,
    ...over,
  };
}
const code = (r) => (r.ok ? 'ok' : r.code);

test('check-in: first valid check-in binds device', () => {
  const r = v.decideCheckIn(base());
  assert.equal(r.ok, true);
  assert.equal(r.bindDevice, true);
  assert.equal(r.slot, slotOf(NOW));
});

test('check-in: bound matching device does not rebind', () => {
  const r = v.decideCheckIn(base({ boundDeviceHash: ASHA.deviceHash, deviceOwnerUid: ASHA.uid }));
  assert.equal(r.ok, true);
  assert.equal(r.bindDevice, false);
});

test('check-in: unknown or closed session', () => {
  assert.equal(code(v.decideCheckIn(base({ session: null }))), 'session-not-found');
  assert.equal(code(v.decideCheckIn(base({ session: { ...SESSION, status: 'closed' } }))), 'session-closed');
});

test('check-in: outside the time window (early and late)', () => {
  assert.equal(code(v.decideCheckIn(base({ nowMs: START - 1 }))), 'outside-window');
  assert.equal(code(v.decideCheckIn(base({ nowMs: END + 1 }))), 'outside-window');
});

test('check-in: unenrolled student', () => {
  assert.equal(code(v.decideCheckIn(base({ enrolled: false }))), 'not-enrolled');
});

test('check-in: duplicate attempt', () => {
  assert.equal(code(v.decideCheckIn(base({ existingCheckin: true }))), 'already-checked-in');
});

test('check-in: stale, wrong-secret and malformed tokens', () => {
  const stale = tokenForSlot(SECRET, slotOf(NOW) - 2);
  const forged = tokenForSlot('c3'.repeat(32), slotOf(NOW));
  assert.equal(code(v.decideCheckIn(base({ presentedToken: stale }))), 'invalid-token');
  assert.equal(code(v.decideCheckIn(base({ presentedToken: forged }))), 'invalid-token');
  assert.equal(code(v.decideCheckIn(base({ presentedToken: 'nothex' }))), 'invalid-token');
  assert.equal(code(v.decideCheckIn(base({ secret: null }))), 'invalid-token');
});

test('check-in: account bound to a different device', () => {
  assert.equal(code(v.decideCheckIn(base({ boundDeviceHash: 'device-hash-other' }))), 'device-mismatch');
});

test('check-in: device already owned by another account (proxy attempt)', () => {
  const r = v.decideCheckIn(base({ uid: BEN.uid, deviceHash: ASHA.deviceHash, deviceOwnerUid: ASHA.uid }));
  assert.equal(code(r), 'device-in-use');
});

test('every rejection code maps to a status', () => {
  for (const c of ['session-not-found', 'session-closed', 'outside-window', 'not-enrolled',
    'already-checked-in', 'invalid-token', 'device-mismatch', 'device-in-use', 'rate-limited',
    'challenge-not-found', 'challenge-expired', 'not-checked-in', 'not-challenged', 'already-answered']) {
    assert.ok(v.STATUS_FOR[c], c);
  }
});

// ---- challenges
const CH = { expiresAtMs: NOW + 60000 };
function cbase(over = {}) {
  return {
    session: SESSION, secret: SECRET, challengeId: 'c1', challenge: CH,
    checkin: { dueChallenges: ['c1'], passedChallenges: [] },
    presentedToken: goodToken, nowMs: NOW,
    deviceHash: ASHA.deviceHash, boundDeviceHash: ASHA.deviceHash, ...over,
  };
}

test('challenge: valid response passes', () => {
  assert.equal(code(v.decideChallengeResponse(cbase())), 'ok');
});

test('challenge: each failure path', () => {
  assert.equal(code(v.decideChallengeResponse(cbase({ session: null }))), 'session-not-found');
  assert.equal(code(v.decideChallengeResponse(cbase({ session: { ...SESSION, status: 'closed' } }))), 'session-closed');
  assert.equal(code(v.decideChallengeResponse(cbase({ challenge: null }))), 'challenge-not-found');
  assert.equal(code(v.decideChallengeResponse(cbase({ nowMs: CH.expiresAtMs + 1 }))), 'challenge-expired');
  assert.equal(code(v.decideChallengeResponse(cbase({ checkin: null }))), 'not-checked-in');
  assert.equal(code(v.decideChallengeResponse(cbase({ checkin: { dueChallenges: [], passedChallenges: [] } }))), 'not-challenged');
  assert.equal(code(v.decideChallengeResponse(cbase({ checkin: { dueChallenges: ['c1'], passedChallenges: ['c1'] } }))), 'already-answered');
  assert.equal(code(v.decideChallengeResponse(cbase({ deviceHash: 'device-hash-other' }))), 'device-mismatch');
  assert.equal(code(v.decideChallengeResponse(cbase({ boundDeviceHash: null }))), 'device-mismatch');
  assert.equal(code(v.decideChallengeResponse(cbase({ presentedToken: tokenForSlot(SECRET, slotOf(NOW) + 5) }))), 'invalid-token');
});

test('flagged count: only students who missed a due challenge', () => {
  const rows = [
    { dueChallenges: ['c1', 'c2'], passedChallenges: ['c1', 'c2'] },
    { dueChallenges: ['c1', 'c2'], passedChallenges: ['c1'] },
    { dueChallenges: ['c2'], passedChallenges: [] },
    { dueChallenges: [], passedChallenges: [] },
    { dueChallenges: ['c2'], passedChallenges: ['c1'] }, // answering a different challenge does not mask a miss
  ];
  assert.equal(v.countFlagged(rows), 3);
  assert.equal(v.countFlagged([]), 0);
});

// ---- rate limit
test('rate limit: allows 5 attempts per window, blocks the 6th, resets after window', () => {
  let state = null;
  for (let n = 1; n <= v.MAX_ATTEMPTS; n++) {
    const r = v.nextRateState(state, NOW + n);
    assert.equal(r.allowed, true);
    state = r.state;
  }
  assert.equal(state.count, v.MAX_ATTEMPTS);
  const blocked = v.nextRateState(state, NOW + 1000);
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.state, state);
  const reset = v.nextRateState(state, state.windowStartMs + v.RATE_WINDOW_MS);
  assert.equal(reset.allowed, true);
  assert.equal(reset.state.count, 1);
});

// ---- challenge planning (random source injected, so the test is deterministic)
test('challenge plan: count by duration, inside the safe window', () => {
  const MIN = 60000;
  assert.deepEqual(v.planChallengeTimes(START, START + 4 * MIN, (lo) => lo), []);
  assert.equal(v.planChallengeTimes(START, START + 10 * MIN, (lo) => lo).length, 1);
  const two = v.planChallengeTimes(START, END, (lo) => lo);
  assert.equal(two.length, 2);
  const latest = v.planChallengeTimes(START, END, (lo, hi) => hi);
  const last = latest[latest.length - 1];
  assert.ok(last <= END - v.CHALLENGE_WINDOW_MS, 'challenge window must close before session ends');
  assert.ok(two[0] >= START + 0.2 * (END - START));
  assert.ok(two[1] > latest[0] - 1, 'second challenge falls in a later segment');
});
