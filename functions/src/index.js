'use strict';
/*
 * Attendance backend. All attendance writes happen here (Admin SDK); clients
 * have no write access to attendance data (see firestore.rules).
 *
 * One-time setup for retention (TTL on the expireAt field):
 *   gcloud firestore fields ttls update expireAt --collection-group=sessions  --enable-ttl
 *   gcloud firestore fields ttls update expireAt --collection-group=checkins  --enable-ttl
 *   gcloud firestore fields ttls update expireAt --collection-group=rateLimits --enable-ttl
 *
 * Classes, enrollments and owner/teacher assignment are provisioned by the
 * owner through admin tooling and are not created by these functions.
 */
const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getFunctions } = require('firebase-admin/functions');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { generateSecret, SLOT_SECONDS } = require('./token');
const v = require('./validate');

const REGION = 'us-central1';
setGlobalOptions({ region: REGION, maxInstances: 20 });
initializeApp();
const db = getFirestore();

const CALL = { enforceAppCheck: true };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHORT_RE = /^[0-9a-f]{8}$/;
const TOKEN_RE = /^[0-9a-f]{12}$/;
const DEVICE_RE = /^[\x21-\x7e]{8,128}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const expireAt = (ms) => Timestamp.fromMillis(ms + v.RETENTION_DAYS * 86400000);

function requireUid(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'unauthenticated');
  return req.auth.uid;
}
function requireField(value, name, re) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new HttpsError('invalid-argument', `invalid-${name}`);
  }
  return value;
}
function reject(code, details) {
  throw new HttpsError(v.STATUS_FOR[code] || 'internal', code, details);
}

// Separate buckets so a passive phone reporting every few seconds does not
// exhaust the small allowance reserved for manual attempts.
async function consumeRateLimit(uid, nowMs, { scope = '', maxAttempts = v.MAX_ATTEMPTS } = {}) {
  const ref = db.doc(`rateLimits/${scope ? `${uid}-${scope}` : uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : null;
    const r = v.nextRateState(prev, nowMs, maxAttempts);
    if (!r.allowed) reject('rate-limited');
    tx.set(ref, { ...r.state, expireAt: Timestamp.fromMillis(nowMs + 86400000) });
  });
}

async function pushToUsers(uids, message) {
  const refs = uids.map((u) => db.doc(`fcmTokens/${u}`));
  if (refs.length === 0) return;
  const snaps = await db.getAll(...refs);
  const targets = snaps.filter((s) => s.exists).map((s) => ({ uid: s.id, token: s.data().token }));
  for (let i = 0; i < targets.length; i += 500) {
    const chunk = targets.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast({
      tokens: chunk.map((t) => t.token),
      ...message,
    });
    await Promise.all(res.responses.map(async (r, idx) => {
      if (r.success) return;
      if (r.error && r.error.code === 'messaging/registration-token-not-registered') {
        await db.doc(`fcmTokens/${chunk[idx].uid}`).delete();
      } else {
        throw r.error;
      }
    }));
  }
}

function queueFor(name) {
  return getFunctions().taskQueue(`locations/${REGION}/functions/${name}`);
}

// ---------------------------------------------------------------- startSession
class ShortIdCollision extends Error {}

exports.startSession = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const classId = requireField((req.data || {}).classId, 'classId', ID_RE);
  const durationMin = (req.data || {}).durationMin;
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > v.MAX_SESSION_MIN) {
    throw new HttpsError('invalid-argument', 'invalid-durationMin');
  }

  const classSnap = await db.doc(`classes/${classId}`).get();
  if (!classSnap.exists) throw new HttpsError('not-found', 'class-not-found');
  const cls = classSnap.data();
  if (cls.teacherUid !== uid) throw new HttpsError('permission-denied', 'not-class-teacher');

  const mode = v.normalizeMode((req.data || {}).mode);
  const presence = v.normalizePresence((req.data || {}).presence);

  const nowMs = Date.now();
  const startAtMs = nowMs;
  const endAtMs = nowMs + durationMin * 60000;
  const secret = generateSecret();
  const sessionRef = db.collection('sessions').doc();
  const sessionId = sessionRef.id;
  let shortId = null;

  for (let attempt = 0; attempt < 5 && shortId === null; attempt++) {
    const candidate = crypto.randomBytes(4).toString('hex');
    try {
      await db.runTransaction(async (tx) => {
        const lockRef = db.doc(`activeSessions/${classId}`);
        const shortRef = db.doc(`shortIds/${candidate}`);
        const [lock, sh] = await Promise.all([tx.get(lockRef), tx.get(shortRef)]);
        if (lock.exists) {
          reject('session-closed', { activeSessionId: lock.data().sessionId });
        }
        if (sh.exists) throw new ShortIdCollision();
        tx.create(sessionRef, {
          classId, ownerUid: cls.ownerUid, teacherUid: uid, shortId: candidate,
          mode, presence,
          status: 'active', startAtMs, endAtMs, expireAt: expireAt(endAtMs),
        });
        tx.create(db.doc(`sessionSecrets/${sessionId}`), { secret });
        tx.create(shortRef, { sessionId, classId });
        tx.create(lockRef, { sessionId });
      });
      shortId = candidate;
    } catch (e) {
      if (!(e instanceof ShortIdCollision)) throw e;
    }
  }
  if (shortId === null) throw new HttpsError('unavailable', 'short-id-unavailable');

  try {
    await queueFor('closeSessionTask').enqueue(
      { sessionId },
      { scheduleTime: new Date(endAtMs), id: `close-${sessionId}` },
    );
    const times = v.planChallengeTimes(startAtMs, endAtMs, (lo, hi) => crypto.randomInt(lo, hi));
    await Promise.all(times.map((t, n) => queueFor('issueChallengeTask').enqueue(
      { sessionId, challengeId: `c${n + 1}` },
      { scheduleTime: new Date(t), id: `challenge-${sessionId}-c${n + 1}` },
    )));
  } catch (e) {
    await closeSessionImpl(sessionId, { notify: false });
    throw new HttpsError('internal', 'scheduling-failed');
  }

  return { sessionId, shortId, secret, startAtMs, endAtMs, slotSeconds: SLOT_SECONDS };
});

// --------------------------------------------------------------------- checkIn
exports.checkIn = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const data = req.data || {};
  const shortId = requireField(data.shortId, 'shortId', SHORT_RE);
  const token = requireField(data.token, 'token', TOKEN_RE);
  const deviceId = requireField(data.deviceId, 'deviceId', DEVICE_RE);
  const deviceHash = sha256(deviceId);
  const nowMs = Date.now();

  await consumeRateLimit(uid, nowMs);

  const shortSnap = await db.doc(`shortIds/${shortId}`).get();
  if (!shortSnap.exists) reject('session-not-found');
  const { sessionId, classId } = shortSnap.data();

  await db.runTransaction(async (tx) => {
    const sessionRef = db.doc(`sessions/${sessionId}`);
    const checkinRef = sessionRef.collection('checkins').doc(uid);
    const bindingRef = db.doc(`bindings/${uid}`);
    const ownerRef = db.doc(`deviceOwners/${deviceHash}`);
    const [sessionSnap, secretSnap, enrollSnap, checkinSnap, bindingSnap, ownerSnap] =
      await Promise.all([
        tx.get(sessionRef),
        tx.get(db.doc(`sessionSecrets/${sessionId}`)),
        tx.get(db.doc(`classes/${classId}/enrollments/${uid}`)),
        tx.get(checkinRef),
        tx.get(bindingRef),
        tx.get(ownerRef),
      ]);

    const decision = v.decideCheckIn({
      session: sessionSnap.exists ? sessionSnap.data() : null,
      secret: secretSnap.exists ? secretSnap.data().secret : null,
      enrolled: enrollSnap.exists && enrollSnap.data().active === true,
      existingCheckin: checkinSnap.exists,
      presentedToken: token,
      nowMs,
      uid,
      deviceHash,
      boundDeviceHash: bindingSnap.exists ? bindingSnap.data().deviceHash : null,
      deviceOwnerUid: ownerSnap.exists ? ownerSnap.data().uid : null,
    });
    if (!decision.ok) reject(decision.code);

    tx.create(checkinRef, {
      serverTs: FieldValue.serverTimestamp(),
      deviceHash,
      tokenSlot: decision.slot,
      status: 'present',
      confirmedAtMs: nowMs,
      dueChallenges: [],
      passedChallenges: [],
      expireAt: sessionSnap.data().expireAt,
    });
    tx.set(
      sessionRef.collection('counters').doc(String(crypto.randomInt(10))),
      { count: FieldValue.increment(1) },
      { merge: true },
    );
    if (decision.bindDevice) {
      tx.set(bindingRef, { deviceHash, boundAtMs: nowMs });
      tx.set(ownerRef, { uid });
    }
  });

  return { status: 'checked-in' };
});

// -------------------------------------------------------------- reportPresence
// Passive automatic attendance: the student's phone detects the room's BLE
// beacon, measures RSSI, and uploads a sighting with no user interaction.
exports.reportPresence = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const data = req.data || {};
  const shortId = requireField(data.shortId, 'shortId', SHORT_RE);
  const token = requireField(data.token, 'token', TOKEN_RE);
  const deviceId = requireField(data.deviceId, 'deviceId', DEVICE_RE);
  const rssi = data.rssi; // validated by decidePresence (weak-signal)
  const seenAtMs = Number.isFinite(data.seenAtMs) ? data.seenAtMs : null;
  const deviceHash = sha256(deviceId);
  const nowMs = Date.now();

  await consumeRateLimit(uid, nowMs, { scope: 'presence', maxAttempts: v.PRESENCE_MAX_ATTEMPTS });

  const shortSnap = await db.doc(`shortIds/${shortId}`).get();
  if (!shortSnap.exists) reject('session-not-found');
  const { sessionId, classId } = shortSnap.data();

  const result = await db.runTransaction(async (tx) => {
    const sessionRef = db.doc(`sessions/${sessionId}`);
    const checkinRef = sessionRef.collection('checkins').doc(uid);
    const bindingRef = db.doc(`bindings/${uid}`);
    const ownerRef = db.doc(`deviceOwners/${deviceHash}`);
    const [sessionSnap, secretSnap, enrollSnap, checkinSnap, bindingSnap, ownerSnap] =
      await Promise.all([
        tx.get(sessionRef),
        tx.get(db.doc(`sessionSecrets/${sessionId}`)),
        tx.get(db.doc(`classes/${classId}/enrollments/${uid}`)),
        tx.get(checkinRef),
        tx.get(bindingRef),
        tx.get(ownerRef),
      ]);

    const prior = checkinSnap.exists ? checkinSnap.data() : null;
    const decision = v.decidePresence({
      session: sessionSnap.exists ? sessionSnap.data() : null,
      secret: secretSnap.exists ? secretSnap.data().secret : null,
      enrolled: enrollSnap.exists && enrollSnap.data().active === true,
      priorCheckin: prior,
      presentedToken: token,
      nowMs,
      seenAtMs,
      uid,
      deviceHash,
      rssi,
      boundDeviceHash: bindingSnap.exists ? bindingSnap.data().deviceHash : null,
      deviceOwnerUid: ownerSnap.exists ? ownerSnap.data().uid : null,
    });
    if (!decision.ok) reject(decision.code);

    const base = {
      deviceHash,
      rssi,
      bestRssi: prior && Number.isFinite(prior.bestRssi) ? Math.max(prior.bestRssi, rssi) : rssi,
      tokenSlot: decision.slot,
      firstSeenMs: decision.firstSeenMs,
      lastSeenMs: nowMs,
      sightings: decision.sightings,
      status: decision.confirmed ? 'present' : 'pending',
      confirmedAtMs: decision.confirmed
        ? (prior && Number.isFinite(prior.confirmedAtMs) ? prior.confirmedAtMs : nowMs)
        : (prior && Number.isFinite(prior.confirmedAtMs) ? prior.confirmedAtMs : null),
      expireAt: sessionSnap.data().expireAt,
    };
    if (prior) {
      // merge keeps dueChallenges/passedChallenges written by the challenge fan-out
      tx.set(checkinRef, base, { merge: true });
    } else {
      tx.set(checkinRef, {
        ...base, serverTs: FieldValue.serverTimestamp(), dueChallenges: [], passedChallenges: [],
      });
    }
    if (decision.bindDevice) {
      tx.set(bindingRef, { deviceHash, boundAtMs: nowMs });
      tx.set(ownerRef, { uid });
    }
    if (decision.newlyConfirmed) {
      tx.set(
        sessionRef.collection('counters').doc(String(crypto.randomInt(10))),
        { count: FieldValue.increment(1) },
        { merge: true },
      );
    }
    return decision;
  });

  return {
    status: result.confirmed ? 'present' : 'pending',
    confirmed: result.confirmed,
    sightings: result.sightings,
    firstSeenMs: result.firstSeenMs,
  };
});
// ------------------------------------------------------------ challengeResponse
exports.challengeResponse = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const data = req.data || {};
  const sessionId = requireField(data.sessionId, 'sessionId', ID_RE);
  const challengeId = requireField(data.challengeId, 'challengeId', ID_RE);
  const token = requireField(data.token, 'token', TOKEN_RE);
  const deviceHash = sha256(requireField(data.deviceId, 'deviceId', DEVICE_RE));
  const rssi = data.rssi; // required for passive sessions, ignored for manual
  const nowMs = Date.now();

  await consumeRateLimit(uid, nowMs);

  await db.runTransaction(async (tx) => {
    const sessionRef = db.doc(`sessions/${sessionId}`);
    const checkinRef = sessionRef.collection('checkins').doc(uid);
    const [sessionSnap, secretSnap, challengeSnap, checkinSnap, bindingSnap] = await Promise.all([
      tx.get(sessionRef),
      tx.get(db.doc(`sessionSecrets/${sessionId}`)),
      tx.get(sessionRef.collection('challenges').doc(challengeId)),
      tx.get(checkinRef),
      tx.get(db.doc(`bindings/${uid}`)),
    ]);
    const decision = v.decideChallengeResponse({
      session: sessionSnap.exists ? sessionSnap.data() : null,
      secret: secretSnap.exists ? secretSnap.data().secret : null,
      challengeId,
      challenge: challengeSnap.exists ? challengeSnap.data() : null,
      checkin: checkinSnap.exists ? checkinSnap.data() : null,
      presentedToken: token,
      nowMs,
      deviceHash,
      rssi,
      boundDeviceHash: bindingSnap.exists ? bindingSnap.data().deviceHash : null,
    });
    if (!decision.ok) reject(decision.code);
    tx.update(checkinRef, { passedChallenges: FieldValue.arrayUnion(challengeId) });
  });

  return { status: 'challenge-passed' };
});

// -------------------------------------------------------------- issueChallenge
exports.issueChallengeTask = onTaskDispatched(
  { retryConfig: { maxAttempts: 3, minBackoffSeconds: 5 }, rateLimits: { maxConcurrentDispatches: 6 } },
  async (req) => {
    const { sessionId, challengeId } = req.data;
    const sessionRef = db.doc(`sessions/${sessionId}`);
    const challengeRef = sessionRef.collection('challenges').doc(challengeId);
    const nowMs = Date.now();

    // Idempotently create the challenge; a task retry must not duplicate it.
    const session = await db.runTransaction(async (tx) => {
      const [sessionSnap, challengeSnap] = await Promise.all([tx.get(sessionRef), tx.get(challengeRef)]);
      if (!sessionSnap.exists || sessionSnap.data().status !== 'active') return null;
      if (!challengeSnap.exists) {
        tx.create(challengeRef, {
          issuedAtMs: nowMs,
          expiresAtMs: nowMs + v.CHALLENGE_WINDOW_MS,
          expireAt: sessionSnap.data().expireAt,
        });
      }
      return sessionSnap.data();
    });
    if (!session) return;

    // Fan out in bounded batches so any class size works (no transaction write cap).
    const checkinsSnap = await sessionRef.collection('checkins').get();
    const audience = checkinsSnap.docs.map((d) => d.id);
    for (let i = 0; i < audience.length; i += v.PRESENCE_BATCH_MAX) {
      const batch = db.batch();
      for (const studentUid of audience.slice(i, i + v.PRESENCE_BATCH_MAX)) {
        batch.update(
          sessionRef.collection('checkins').doc(studentUid),
          { dueChallenges: FieldValue.arrayUnion(challengeId) },
        );
      }
      await batch.commit();
    }

    if (audience.length === 0) return;
    await pushToUsers(audience, {
      data: {
        type: session.mode === 'passive' ? 'presence-probe' : 'challenge',
        sessionId,
        challengeId,
      },
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1 } } },
    });
  },
);

// ---------------------------------------------------------------- closeSession
async function closeSessionImpl(sessionId, { notify = true } = {}) {
  const sessionRef = db.doc(`sessions/${sessionId}`);

  const before = await db.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) return null;
    const d = snap.data();
    const lockRef = db.doc(`activeSessions/${d.classId}`);
    const lock = await tx.get(lockRef);
    if (d.status === 'active') {
      tx.update(sessionRef, { status: 'closed', closedAtMs: Date.now() });
      tx.delete(db.doc(`sessionSecrets/${sessionId}`));
      tx.delete(db.doc(`shortIds/${d.shortId}`));
      if (lock.exists && lock.data().sessionId === sessionId) tx.delete(lockRef);
    }
    return d;
  });
  if (!before || !notify || before.notifiedAtMs) return;

  const [checkinsSnap, enrolledAgg] = await Promise.all([
    sessionRef.collection('checkins').get(),
    db.collection(`classes/${before.classId}/enrollments`).where('active', '==', true).count().get(),
  ]);
  const rows = checkinsSnap.docs.map((d) => d.data());
  const summary = {
    enrolled: enrolledAgg.data().count,
    present: v.countPresent(rows),
    pending: v.countPending(rows),
    flagged: v.countFlagged(rows),
  };
  await sessionRef.update({ summary });
  await pushToUsers([before.ownerUid], {
    notification: {
      title: 'Attendance summary',
      body: `${summary.present}/${summary.enrolled} present, ${summary.flagged} flagged`,
    },
    data: { type: 'summary', sessionId },
  });
  await sessionRef.update({ notifiedAtMs: Date.now() });
}

exports.closeSessionTask = onTaskDispatched(
  { retryConfig: { maxAttempts: 5, minBackoffSeconds: 10 } },
  async (req) => closeSessionImpl(req.data.sessionId),
);

exports.endSession = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const sessionId = requireField((req.data || {}).sessionId, 'sessionId', ID_RE);
  const snap = await db.doc(`sessions/${sessionId}`).get();
  if (!snap.exists) reject('session-not-found');
  const s = snap.data();
  if (s.teacherUid !== uid && s.ownerUid !== uid) {
    throw new HttpsError('permission-denied', 'not-session-staff');
  }
  await closeSessionImpl(sessionId);
  return { status: 'closed' };
});

// -------------------------------------------------------------- sessionSummary
// Live attendance for the teacher's device, without reading Firestore directly.
exports.sessionSummary = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const sessionId = requireField((req.data || {}).sessionId, 'sessionId', ID_RE);
  const sessionRef = db.doc(`sessions/${sessionId}`);
  const snap = await sessionRef.get();
  if (!snap.exists) reject('session-not-found');
  const s = snap.data();
  if (s.teacherUid !== uid && s.ownerUid !== uid) {
    throw new HttpsError('permission-denied', 'not-session-staff');
  }
  const [checkinsSnap, enrolledAgg] = await Promise.all([
    sessionRef.collection('checkins').get(),
    db.collection(`classes/${s.classId}/enrollments`).where('active', '==', true).count().get(),
  ]);
  const rows = checkinsSnap.docs.map((d) => d.data());
  return {
    status: s.status,
    mode: s.mode,
    enrolled: enrolledAgg.data().count,
    present: v.countPresent(rows),
    pending: v.countPending(rows),
    flagged: v.countFlagged(rows),
  };
});

// ------------------------------------------------------------------ classStats
// Owner-only attendance statistics across every session of a class.
// Requires a Firestore composite index on sessions(classId, startAtMs).
exports.classStats = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const classId = requireField((req.data || {}).classId, 'classId', ID_RE);
  const cls = await db.doc(`classes/${classId}`).get();
  if (!cls.exists || cls.data().ownerUid !== uid) {
    throw new HttpsError('permission-denied', 'not-class-owner');
  }

  const [sessionsSnap, enrollsSnap] = await Promise.all([
    db.collection('sessions').where('classId', '==', classId).get(),
    db.collection(`classes/${classId}/enrollments`).where('active', '==', true).get(),
  ]);

  const students = enrollsSnap.docs.map((d) => d.id);
  const perStudent = new Map(students.map((s) => [s, { sessions: 0, attended: 0, flagged: 0 }]));
  const sessions = [];

  for (const sdoc of sessionsSnap.docs) {
    const s = sdoc.data();
    const checkinsSnap = await db.doc(`sessions/${sdoc.id}`).collection('checkins').get();
    const rows = checkinsSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    sessions.push({
      sessionId: sdoc.id, classId, status: s.status, startAtMs: s.startAtMs, endAtMs: s.endAtMs,
      enrolled: students.length,
      present: v.countPresent(rows), pending: v.countPending(rows), flagged: v.countFlagged(rows),
    });
    const presentUids = new Set(rows.filter(v.isPresent).map((r) => r.uid));
    const flaggedUids = new Set(rows.filter(v.isFlagged).map((r) => r.uid));
    for (const st of students) {
      const acc = perStudent.get(st);
      acc.sessions += 1;
      if (presentUids.has(st)) acc.attended += 1;
      if (flaggedUids.has(st)) acc.flagged += 1;
    }
  }
  sessions.sort((a, b) => a.startAtMs - b.startAtMs);

  const totalSlots = sessions.length * students.length;
  const totalPresent = sessions.reduce((acc, s) => acc + s.present, 0);
  return {
    classId,
    totals: {
      sessions: sessions.length,
      enrolled: students.length,
      presentRate: totalSlots ? totalPresent / totalSlots : 0,
    },
    students: students.map((st) => ({ uid: st, ...perStudent.get(st) })),
    sessions,
  };
});

// ----------------------------------------------------------- approveDeviceReset
exports.approveDeviceReset = onCall(CALL, async (req) => {
  const uid = requireUid(req);
  const data = req.data || {};
  const classId = requireField(data.classId, 'classId', ID_RE);
  const studentUid = requireField(data.studentUid, 'studentUid', ID_RE);

  const [cls, enroll] = await Promise.all([
    db.doc(`classes/${classId}`).get(),
    db.doc(`classes/${classId}/enrollments/${studentUid}`).get(),
  ]);
  if (!cls.exists || cls.data().ownerUid !== uid) {
    throw new HttpsError('permission-denied', 'not-class-owner');
  }
  if (!enroll.exists) reject('not-enrolled');

  await db.runTransaction(async (tx) => {
    const bindingRef = db.doc(`bindings/${studentUid}`);
    const binding = await tx.get(bindingRef);
    if (!binding.exists) return;
    tx.delete(db.doc(`deviceOwners/${binding.data().deviceHash}`));
    tx.delete(bindingRef);
  });
  return { status: 'device-reset' };
});
