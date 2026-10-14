'use strict';
// Pure decision logic. No Firebase imports, so every rule is unit-testable.
const { verifyToken } = require('./token');

const MAX_ATTEMPTS = 5;
// Passive phones re-report every few seconds, so presence has its own, larger bucket.
const PRESENCE_MAX_ATTEMPTS = 60;
const RATE_WINDOW_MS = 60 * 1000;
const CHALLENGE_WINDOW_MS = 60 * 1000;
const RETENTION_DAYS = 180;
const MAX_SESSION_MIN = 180;

// --- BLE proximity presence (the "signal" is a rotating beacon over BLE) -----
// A student's phone passively scans the room beacon, measures signal strength and
// uploads a sighting. Presence is only confirmed after enough sightings spread
// over a minimum dwell, so someone merely walking past the door is not marked
// present. A sighting weaker than RSSI_MIN is treated as out of range.
const RSSI_MIN = -80; // dBm floor: weaker than this is "not in the room"
const MAX_SIGHTING_AGE_MS = 60 * 1000; // tolerate a phone with a skewed clock
const PRESENCE_MIN_SIGHTINGS = 3; // default distinct reports required
const PRESENCE_MIN_DWELL_MS = 30 * 1000; // default span from first to last sighting
const PRESENCE_GAP_MS = 60 * 1000; // a missed report within this gap keeps the dwell
const MAX_PRESENCE_SIGHTINGS = 10;
const MAX_PRESENCE_DWELL_MS = 300 * 1000;
const PRESENCE_BATCH_MAX = 400; // writes per fan-out batch

const MODES = ['passive', 'manual'];

const STATUS_FOR = {
  'session-not-found': 'not-found',
  'session-closed': 'failed-precondition',
  'outside-window': 'failed-precondition',
  'not-enrolled': 'permission-denied',
  'already-checked-in': 'already-exists',
  'invalid-token': 'permission-denied',
  'device-mismatch': 'permission-denied',
  'device-in-use': 'permission-denied',
  'rate-limited': 'resource-exhausted',
  'weak-signal': 'failed-precondition',
  'stale-reading': 'failed-precondition',
  'challenge-not-found': 'not-found',
  'challenge-expired': 'failed-precondition',
  'not-checked-in': 'failed-precondition',
  'not-challenged': 'permission-denied',
  'already-answered': 'already-exists',
};

const bad = (code) => ({ ok: false, code });

// A reported RSSI is usable when it is a real number in a plausible dBm range.
function signalOk(rssi) {
  return typeof rssi === 'number' && Number.isFinite(rssi) && rssi <= 0 && rssi >= RSSI_MIN;
}

function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : 'passive';
}

function clampInt(value, lo, hi, dflt) {
  if (!Number.isInteger(value)) return dflt;
  return Math.min(hi, Math.max(lo, value));
}

// Per-session presence thresholds, clamped to safe bounds. Defaults keep passive
// attendance from being trivially spoofed by a single weak sighting.
function normalizePresence(input) {
  const src = input || {};
  return {
    minSightings: clampInt(src.minSightings, 1, MAX_PRESENCE_SIGHTINGS, PRESENCE_MIN_SIGHTINGS),
    minDwellMs: clampInt(src.minDwellMs, 0, MAX_PRESENCE_DWELL_MS, PRESENCE_MIN_DWELL_MS),
  };
}

const sessionMinSightings = (session) =>
  (session.presence && Number.isInteger(session.presence.minSightings) ? session.presence.minSightings : PRESENCE_MIN_SIGHTINGS);
const sessionMinDwellMs = (session) =>
  (session.presence && Number.isInteger(session.presence.minDwellMs) ? session.presence.minDwellMs : PRESENCE_MIN_DWELL_MS);

function decideCheckIn(i) {
  const { session, enrolled, existingCheckin, presentedToken, secret, nowMs,
          uid, deviceHash, boundDeviceHash, deviceOwnerUid } = i;
  if (!session) return bad('session-not-found');
  if (session.status !== 'active') return bad('session-closed');
  if (nowMs < session.startAtMs || nowMs > session.endAtMs) return bad('outside-window');
  if (!enrolled) return bad('not-enrolled');
  if (existingCheckin) return bad('already-checked-in');
  const slot = verifyToken(secret, presentedToken, nowMs);
  if (slot === null) return bad('invalid-token');
  if (boundDeviceHash && boundDeviceHash !== deviceHash) return bad('device-mismatch');
  if (deviceOwnerUid && deviceOwnerUid !== uid) return bad('device-in-use');
  return { ok: true, slot, bindDevice: !boundDeviceHash };
}

// Passive BLE proximity report. Accumulates sightings into a dwell window and
// reports whether presence is now confirmed. Repeated reports are expected, so
// unlike decideCheckIn a second sighting is not an error.
function decidePresence(i) {
  const { session, secret, enrolled, priorCheckin, presentedToken, nowMs, seenAtMs,
          uid, deviceHash, boundDeviceHash, deviceOwnerUid, rssi } = i;
  if (!session) return bad('session-not-found');
  if (session.status !== 'active') return bad('session-closed');
  if (nowMs < session.startAtMs || nowMs > session.endAtMs) return bad('outside-window');
  if (!enrolled) return bad('not-enrolled');
  if (!signalOk(rssi)) return bad('weak-signal');
  if (Number.isFinite(seenAtMs) && Math.abs(nowMs - seenAtMs) > MAX_SIGHTING_AGE_MS) return bad('stale-reading');
  const slot = verifyToken(secret, presentedToken, nowMs);
  if (slot === null) return bad('invalid-token');
  if (boundDeviceHash && boundDeviceHash !== deviceHash) return bad('device-mismatch');
  if (deviceOwnerUid && deviceOwnerUid !== uid) return bad('device-in-use');

  const prior = priorCheckin || null;
  const keepsDwell = prior && Number.isFinite(prior.lastSeenMs) && (nowMs - prior.lastSeenMs) <= PRESENCE_GAP_MS;
  const sightings = keepsDwell ? (prior.sightings || 0) + 1 : 1;
  const firstSeenMs = keepsDwell ? prior.firstSeenMs : nowMs;
  const dwellMs = nowMs - firstSeenMs;
  const alreadyPresent = prior && prior.status === 'present';
  const confirmed = alreadyPresent ||
    (sightings >= sessionMinSightings(session) && dwellMs >= sessionMinDwellMs(session));

  return {
    ok: true, slot, bindDevice: !boundDeviceHash,
    sightings, firstSeenMs, dwellMs, confirmed, newlyConfirmed: confirmed && !alreadyPresent,
  };
}

function decideChallengeResponse(i) {
  const { session, challengeId, challenge, checkin, presentedToken, secret, nowMs,
          deviceHash, boundDeviceHash, rssi } = i;
  if (!session) return bad('session-not-found');
  if (session.status !== 'active') return bad('session-closed');
  // In passive mode a challenge response must carry fresh in-room BLE evidence.
  if (session.mode === 'passive' && !signalOk(rssi)) return bad('weak-signal');
  if (!challenge) return bad('challenge-not-found');
  if (nowMs > challenge.expiresAtMs) return bad('challenge-expired');
  if (!checkin) return bad('not-checked-in');
  if (checkin.status === 'pending') return bad('not-checked-in');
  if (!(checkin.dueChallenges || []).includes(challengeId)) return bad('not-challenged');
  if ((checkin.passedChallenges || []).includes(challengeId)) return bad('already-answered');
  if (!boundDeviceHash || boundDeviceHash !== deviceHash) return bad('device-mismatch');
  const slot = verifyToken(secret, presentedToken, nowMs);
  if (slot === null) return bad('invalid-token');
  return { ok: true, slot };
}

function nextRateState(state, nowMs, maxAttempts = MAX_ATTEMPTS) {
  if (!state || nowMs - state.windowStartMs >= RATE_WINDOW_MS) {
    return { allowed: true, state: { windowStartMs: nowMs, count: 1 } };
  }
  if (state.count >= maxAttempts) return { allowed: false, state };
  return { allowed: true, state: { windowStartMs: state.windowStartMs, count: state.count + 1 } };
}

const isPresent = (c) => c.status === undefined || c.status === 'present';

// Confirmed present (legacy check-in docs with no explicit status count as present).
function countPresent(checkins) {
  return checkins.filter(isPresent).length;
}

// Seen but not yet past the dwell threshold.
function countPending(checkins) {
  return checkins.filter((c) => c.status === 'pending').length;
}

// A present student is flagged when any challenge they were due for was not
// passed. Pending students are not yet counted, so they are never flagged.
function isFlagged(c) {
  if (!isPresent(c)) return false;
  const passed = new Set(c.passedChallenges || []);
  return (c.dueChallenges || []).some((id) => !passed.has(id));
}

function countFlagged(checkins) {
  return checkins.filter(isFlagged).length;
}

// One challenge per equal segment of the usable window; randomInt(min, max) is injected.
function planChallengeTimes(startMs, endMs, randomInt) {
  const durMin = (endMs - startMs) / 60000;
  const count = durMin >= 30 ? 2 : durMin >= 5 ? 1 : 0;
  const lo = startMs + 0.2 * (endMs - startMs);
  const hi = endMs - (CHALLENGE_WINDOW_MS + 30 * 1000);
  if (count === 0 || hi <= lo) return [];
  const seg = (hi - lo) / count;
  const times = [];
  for (let n = 0; n < count; n++) {
    times.push(randomInt(Math.floor(lo + n * seg), Math.floor(lo + (n + 1) * seg)));
  }
  return times;
}

module.exports = {
  MAX_ATTEMPTS, PRESENCE_MAX_ATTEMPTS, RATE_WINDOW_MS, CHALLENGE_WINDOW_MS, RETENTION_DAYS, MAX_SESSION_MIN,
  RSSI_MIN, MAX_SIGHTING_AGE_MS, PRESENCE_MIN_SIGHTINGS, PRESENCE_MIN_DWELL_MS,
  PRESENCE_GAP_MS, MAX_PRESENCE_SIGHTINGS, MAX_PRESENCE_DWELL_MS, PRESENCE_BATCH_MAX, MODES,
  STATUS_FOR, signalOk, normalizeMode, normalizePresence,
  decideCheckIn, decidePresence, decideChallengeResponse, nextRateState,
  isPresent, isFlagged, countPresent, countPending, countFlagged, planChallengeTimes,
};
