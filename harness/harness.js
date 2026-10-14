'use strict';
// Shared, dependency-free test harness for the attendance Cloud Functions.
//
// It provides an in-memory Firestore double, records task-queue enqueues and
// push notifications, injects module stubs for `firebase-admin/*` and
// `firebase-functions/*`, and then loads the REAL functions from
// ../functions/src/index.js. Both the integration test and the local dev
// server (dev/server.js) build on this, so there is a single source of truth.
//
// No emulator, credentials, network or Java required.
const Module = require('module');
const crypto = require('crypto');
const { tokenForSlot, slotOf } = require('../functions/src/token');

class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
  static fromMillis(ms) { return new Timestamp(ms); }
}

const FieldValue = {
  serverTimestamp: () => ({ __type: 'serverTimestamp' }),
  increment: (n) => ({ __type: 'increment', n }),
  arrayUnion: (...vals) => ({ __type: 'arrayUnion', vals }),
  delete: () => ({ __type: 'deleteField' }),
};

function makeFirestore() {
  const store = new Map();
  let idCounter = 0;
  const newId = () => `auto${++idCounter}`;

  function applyValues(prev, values) {
    const next = { ...(prev || {}) };
    for (const [k, val] of Object.entries(values || {})) {
      if (val && val.__type === 'increment') next[k] = (typeof next[k] === 'number' ? next[k] : 0) + val.n;
      else if (val && val.__type === 'arrayUnion') next[k] = Array.from(new Set([...(next[k] || []), ...val.vals]));
      else if (val && val.__type === 'serverTimestamp') next[k] = new Timestamp(Date.now());
      else if (val && val.__type === 'deleteField') delete next[k];
      else next[k] = val;
    }
    return next;
  }

  function docRef(path) {
    return {
      id: path.split('/').pop(),
      path,
      collection: (name) => collectionRef(`${path}/${name}`),
      async get() { return snapshot(path); },
      async set(values, opts) {
        const base = opts && opts.merge ? store.get(path) : undefined;
        store.set(path, applyValues(base, values));
      },
      async create(values) {
        if (store.has(path)) throw new Error(`ALREADY_EXISTS: ${path}`);
        store.set(path, applyValues(undefined, values));
      },
      async update(values) {
        if (!store.has(path)) throw new Error(`NOT_FOUND: ${path}`);
        store.set(path, applyValues(store.get(path), values));
      },
      async delete() { store.delete(path); },
    };
  }

  function childKeys(collectionPath) {
    const prefix = `${collectionPath}/`;
    return [...store.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
  }

  function collectionRef(path) {
    const make = (matcher) => ({
      count: () => ({
        async get() {
          return { data: () => ({ count: childKeys(path).filter(matcher).length }) };
        },
      }),
      async get() {
        const docs = childKeys(path).filter(matcher).map(snapshot);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    });
    return {
      path,
      _isCollection: true,
      doc: (id) => docRef(`${path}/${id === undefined ? newId() : id}`),
      async get() {
        const docs = childKeys(path).map(snapshot);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
      where(field, op, value) {
        return make((key) => {
          const d = store.get(key) || {};
          return op === '==' ? d[field] === value : false;
        });
      },
    };
  }

  function snapshot(path) {
    return {
      id: path.split('/').pop(),
      ref: docRef(path),
      exists: store.has(path),
      data: () => (store.has(path) ? { ...store.get(path) } : undefined),
    };
  }

  const tx = () => {
    const ops = [];
    return {
      get: async (ref) => (ref && ref._isCollection
        ? { docs: childKeys(ref.path).map(snapshot), size: childKeys(ref.path).length }
        : snapshot(ref.path)),
      create: (ref, values) => ops.push(() => docRef(ref.path).create(values)),
      set: (ref, values, opts) => ops.push(() => docRef(ref.path).set(values, opts)),
      update: (ref, values) => ops.push(() => docRef(ref.path).update(values)),
      delete: (ref) => ops.push(() => docRef(ref.path).delete()),
      _commit: () => ops.forEach((op) => op()),
    };
  };

  return {
    doc: docRef,
    collection: collectionRef,
    async getAll(...refs) { return refs.map((r) => snapshot(r.path)); },
    batch() {
      const ops = [];
      return {
        update: (ref, values) => ops.push(() => docRef(ref.path).update(values)),
        set: (ref, values, opts) => ops.push(() => docRef(ref.path).set(values, opts)),
        delete: (ref) => ops.push(() => docRef(ref.path).delete()),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    async runTransaction(fn) {
      const t = tx();
      const result = await fn(t); // ops are applied only if fn resolves
      t._commit();
      return result;
    },
    _dump: () => store,
    _clear: () => store.clear(),
  };
}

class HttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function serialize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return { __timestampMs: value.toMillis(), iso: value.toDate().toISOString() };
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

function createHarness() {
  const db = makeFirestore();
  const pushes = [];
  const queued = [];

  const messaging = {
    async sendEachForMulticast(msg) {
      pushes.push({ tokens: msg.tokens, ...msg, tokensCount: msg.tokens.length });
      return { responses: msg.tokens.map(() => ({ success: true })) };
    },
  };
  const functionsApi = {
    taskQueue: (name) => ({
      async enqueue(data, opts) { queued.push({ name, data, opts }); },
    }),
  };

  const stubs = {
    'firebase-admin/app': { initializeApp() {} },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue, Timestamp },
    'firebase-admin/messaging': { getMessaging: () => messaging },
    'firebase-admin/functions': { getFunctions: () => functionsApi },
    'firebase-functions/v2': { setGlobalOptions() {} },
    'firebase-functions/v2/https': { onCall: (opts, handler) => handler, HttpsError },
    'firebase-functions/v2/tasks': { onTaskDispatched: (opts, handler) => handler },
  };

  const indexPath = require.resolve('../functions/src/index.js');
  delete require.cache[indexPath];

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  let handlers;
  try {
    handlers = require(indexPath);
  } finally {
    Module._load = originalLoad;
  }

  // Callable handler as the platform invokes it: { auth, data }.
  const call = (handler, uid, data) => handler({ auth: uid ? { uid } : null, data: data || {} });

  // Current rotating token for a session secret (as the mobile client computes it).
  const tokenNow = (secret, nowMs = Date.now()) => tokenForSlot(secret, slotOf(nowMs));

  const reset = () => {
    db._clear();
    pushes.length = 0;
    queued.length = 0;
  };

  const snapshotState = () => ({
    docs: [...db._dump().entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, data]) => ({ path, data: serialize(data) })),
    pushes: pushes.map((p) => ({
      type: p.data && p.data.type,
      tokens: p.tokens,
      sessionId: p.data && p.data.sessionId,
      notification: p.notification || null,
    })),
    queued: queued.map((q) => ({
      name: q.name,
      data: q.data,
      scheduleTime: q.opts && q.opts.scheduleTime ? q.opts.scheduleTime.toISOString() : null,
      id: q.opts && q.opts.id,
    })),
  });

  return { db, handlers, call, tokenNow, reset, snapshotState, serialize, HttpsError, pushes, queued };
}

module.exports = { createHarness, makeFirestore, Timestamp, FieldValue, HttpsError, serialize, tokenForSlot, slotOf, crypto };
