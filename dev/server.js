'use strict';
// Local test console for the attendance Cloud Functions.
//
// Loads the REAL functions (functions/src/index.js) against an in-memory
// Firestore double and exposes them over HTTP plus a browser UI at "/". This
// lets you drive every function end-to-end without the Firebase emulator,
// credentials, network or Java.
//
//   node dev/server.js            # then open http://127.0.0.1:5050
//   PORT=8080 node dev/server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('../harness/harness');

const h = createHarness();
const { handlers, call, tokenNow, reset, snapshotState } = h;

const TASK_FNS = new Set(['issueChallengeTask', 'closeSessionTask']);
const CALLABLE_FNS = [
  'startSession', 'reportPresence', 'checkIn', 'challengeResponse',
  'endSession', 'sessionSummary', 'classStats', 'approveDeviceReset',
];

const PORT = Number(process.env.PORT || 5050);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serializeError(e) {
  return {
    code: e && e.code ? e.code : 'internal',
    message: e && e.message ? e.message : String(e),
    details: e && e.details ? e.details : null,
  };
}

// What the teacher's device is broadcasting over BLE right now: the rotating
// code in the air. A student's phone can only read this while in range.
function currentBeacon() {
  for (const [path, data] of h.db._dump().entries()) {
    if (!path.startsWith('sessions/') || path.split('/').length !== 2) continue;
    if (data.status !== 'active') continue;
    const sessionId = path.split('/')[1];
    const secretDoc = h.db._dump().get(`sessionSecrets/${sessionId}`);
    if (!secretDoc) continue;
    return {
      sessionId,
      shortId: data.shortId,
      classId: data.classId,
      mode: data.mode,
      token: h.tokenNow(secretDoc.secret),
      slotSeconds: 15,
    };
  }
  return null;
}

const state = () => ({ ...snapshotState(), beacon: currentBeacon() });

const DEFAULT_SEED = {
  classId: 'class-1',
  ownerUid: 'owner-1',
  teacherUid: 'teacher-1',
  students: [
    { uid: 'student-1', deviceId: 'device-abc-123456', fcmToken: 'fcm-token-student-1' },
    { uid: 'student-2', deviceId: 'device-xyz-654321', fcmToken: 'fcm-token-student-2' },
  ],
};

async function runSeed(opts = {}) {
  const seed = { ...DEFAULT_SEED, ...opts };
  await h.db.doc(`classes/${seed.classId}`).set({ ownerUid: seed.ownerUid, teacherUid: seed.teacherUid });
  for (const s of seed.students) {
    await h.db.doc(`classes/${seed.classId}/enrollments/${s.uid}`).set({ active: true });
    if (s.fcmToken) await h.db.doc(`fcmTokens/${s.uid}`).set({ token: s.fcmToken });
  }
  return seed;
}

async function handleInvoke(body) {
  const fn = body.fn;
  if (!fn || !handlers[fn]) {
    const err = new Error(`unknown function: ${fn}`);
    err.code = 'not-found';
    throw err;
  }
  const actorUid = body.actorUid || null;
  const data = body.data || {};
  if (TASK_FNS.has(fn)) {
    return handlers[fn]({ data });
  }
  return call(handlers[fn], actorUid, data);
}

const routes = {
  'GET /api/state': async () => state(),

  'POST /api/reset': async () => { reset(); return state(); },

  'POST /api/seed': async (body) => { await runSeed(body); return state(); },

  'POST /api/token': async (body) => {
    if (!body.secret) { const e = new Error('secret is required'); e.code = 'invalid-argument'; throw e; }
    return { token: tokenNow(body.secret), slotSeconds: 15 };
  },

  'POST /api/doc': async (body) => {
    if (!body.path) { const e = new Error('path is required'); e.code = 'invalid-argument'; throw e; }
    await h.db.doc(body.path).set(body.data || {}, { merge: body.merge !== false });
    return state();
  },

  'POST /api/doc/delete': async (body) => {
    if (!body.path) { const e = new Error('path is required'); e.code = 'invalid-argument'; throw e; }
    await h.db.doc(body.path).delete();
    return state();
  },

  'POST /api/invoke': async (body) => {
    const result = await handleInvoke(body);
    return { result: result ?? null, state: state() };
  },
};

function serveStatic(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('UI not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveStatic(res);
  }
  const route = routes[key];
  if (!route) return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route ${key}` } });

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await route(body);
    // /api/invoke already returns { result, state }; other routes return state or a value.
    if (key === 'POST /api/invoke') return sendJson(res, 200, { ok: true, ...result });
    if (key === 'POST /api/token') return sendJson(res, 200, { ok: true, ...result });
    return sendJson(res, 200, { ok: true, state: result });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: serializeError(e) });
  }
});

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(path.join(__dirname, '.server.pid'), String(process.pid)); } catch { /* ignore */ }
  console.log(`Attendance test console -> http://${HOST}:${PORT}`);
  console.log(`Callable functions: ${CALLABLE_FNS.join(', ')}`);
  console.log(`Task functions:     ${[...TASK_FNS].join(', ')}`);
  console.log('Open the same URL on a second device on your LAN (HOST=0.0.0.0) to test teacher + student.');
});
