# Attendance Backend

Firebase Cloud Functions (v2) for class-session attendance. All attendance data is
written server-side with the Admin SDK; clients have **no** write access to
attendance data (see [`firestore.rules`](firestore.rules)).

## Layout

```
firebase.json            # Firebase project config (Firestore rules + Functions source)
firestore.rules          # Security rules (default-deny)
functions/
  package.json           # entrypoint: src/index.js, runtime: Node 20
  src/index.js           # Cloud Functions (callable + task-queue handlers)
  src/token.js           # Rotating HMAC attendance tokens
  src/validate.js        # Pure decision logic (unit-testable, no Firebase imports)
  test/                  # node:test suites
```

## Functions

| Handler | Type | Purpose |
| --- | --- | --- |
| `startSession` | callable | Teacher opens a session; issues short id + rotating secret; sets `mode` (`passive`/`manual`) and presence thresholds; schedules challenge + close tasks |
| `reportPresence` | callable | **Passive BLE attendance.** Phone uploads a beacon sighting (rotating code + RSSI); backend accumulates dwell and confirms presence |
| `checkIn` | callable | Manual/token check-in (QR fallback); binds the device and marks present immediately |
| `challengeResponse` | callable | Answers a presence probe; in passive mode it must carry fresh in-room BLE evidence |
| `issueChallengeTask` | task | Fans a challenge out to every presence record in bounded batches (push) |
| `closeSessionTask` | task | Auto-closes a session at its end time and writes a summary |
| `endSession` | callable | Teacher/owner closes a session early |
| `sessionSummary` | callable | Live attendance (present/pending/flagged) for the teacher's device |
| `classStats` | callable | Owner-only attendance statistics across every session of a class |
| `approveDeviceReset` | callable | Class owner clears a student's device binding |

## Passive BLE attendance

The "signal" is the room's BLE beacon. The teacher's device advertises the same
rotating HMAC code the token path uses (new value every 15s, `token.js`), so it can
also be shown as a QR fallback. The student's phone passively scans, measures RSSI,
and calls `reportPresence` with no user interaction.

Presence is only **confirmed** after enough sightings spread over a minimum dwell,
so a student merely walking past the door is not marked present:

- `RSSI_MIN` = -80 dBm — weaker sightings are rejected as `weak-signal`.
- `PRESENCE_MIN_SIGHTINGS` = 3 · `PRESENCE_MIN_DWELL_MS` = 30s (defaults, per-session overridable
  via `startSession` `presence: { minSightings, minDwellMs }`, clamped to safe bounds).
- `PRESENCE_GAP_MS` = 60s — a missed report within this gap keeps the dwell; longer restarts it.
- A record moves `pending` → `present` once confirmed; only `present` counts in summaries and is
  eligible to be challenged/flagged.
- Passive reports use their own rate-limit bucket (`PRESENCE_MAX_ATTEMPTS` = 60/min, vs 5/min for
  manual attempts) because a phone re-reports every few seconds.

Anti-proxy: the rotating code is only obtainable near the beacon, device binding keeps one phone
per student, and passive challenge probes are answered automatically from fresh BLE evidence. A
client-reported RSSI is still client-controlled — see the note in `sessionSummary`/`reportPresence`
when hardening further (server-signed beacon advertisements or a second factor).

## Scaling

`issueChallengeTask` no longer fans out inside a single Firestore transaction. It creates the
challenge idempotently, reads the presence records once, then writes `dueChallenges` in batches of
`PRESENCE_BATCH_MAX` (400) with `db.batch().commit()`. Classes of any size work, and a task retry is
safe because `arrayUnion` is idempotent.

## Testing (no credentials, no emulator needed)

```bash
cd functions
npm install        # first time only
npm test
```

The suite runs with the built-in `node:test` runner and covers:

- **`test/token.test.js`** — token generation and rotation tolerance.
- **`test/validate.test.js`** — every accept/reject rule, rate limiting, challenge planning.
- **`test/index.test.js`** — smoke test: the entrypoint loads and exports all handlers.
- **`test/presence.test.js`** — passive BLE rules (`decidePresence`: RSSI gate, dwell
  accumulation, gaps) plus an end-to-end passive run and a 600-student fan-out test.
- **`test/integration.test.js`** — end-to-end lifecycle against an in-memory Firestore
  double: `startSession → checkIn → issueChallengeTask → challengeResponse → endSession`,
  asserting the documents written, tasks scheduled and pushes sent.

### Getting the output

Each file reports TAP. To see a compact summary:

```bash
cd functions
npm test -- --test-reporter=spec     # human-readable spec output
npm test 2>&1 | grep -E '^# (tests|pass|fail)'
```

Run a single file or a single test:

```bash
node --test test/integration.test.js
node --test --test-name-pattern="checkIn" test/
```

### Runtime version

`package.json` targets the Firebase `nodejs20` runtime (`engines.node = "20"`).
The suite also passes on Node 18. To verify on Node 20 without changing your
installed Node:

```bash
cd functions && npx -y node@20 --test test/
```

## Browser test console

A zero-dependency test console drives the **real** handlers through the same
in-memory harness the tests use, with no emulator, credentials or Java required.
It has three role sections: **Teacher**, **Student** and **Owner**.

```bash
node dev/server.js                        # then open http://127.0.0.1:5050
PORT=8080 node dev/server.js              # custom port
HOST=0.0.0.0 node dev/server.js           # accept connections from your LAN
```

- **Teacher** — start a session (class, duration, `mode`, presence thresholds), see the
  live rotating BLE beacon the device would advertise, end the session, send a presence
  probe, and watch present/pending/flagged update.
- **Student** — set your actor uid and deviceId, pick your *distance to the teacher*,
  and toggle passive auto-reporting. Attendance is only granted when the phone is close
  enough: `next to teacher`, `in the room`, `at the door (weak → rejected)` or `no signal`.
- **Owner** — pull class statistics: sessions, present rate, per-student attendance and a
  per-session breakdown; plus `approveDeviceReset`.

### Testing with two devices

The server keeps one shared in-memory store, so any number of clients share a session.
Start the server with `HOST=0.0.0.0`, open the URL on the teacher's laptop and on a
student's phone (same Wi‑Fi, use the laptop's LAN IP), then start a session in the Teacher
section and watch it appear in the Student section. Both devices hit the same backend.

Files: [`harness/harness.js`](harness/harness.js) (shared in-memory Firestore),
[`dev/server.js`](dev/server.js) (HTTP + static), [`dev/public/index.html`](dev/public/index.html) (UI).

## Running against the Firebase Emulator Suite

`firebase emulators:start` for `firestore` requires **JDK 11 or newer**
(firebase-tools refuses older JDKs):

```bash
firebase login                                  # needed for non-demo projects
firebase emulators:start --project demo-attendance
```

Callable handlers are exposed at `http://127.0.0.1:5002/<project>/us-central1/<name>`.

> Cloud Tasks (used by `issueChallengeTask` / `closeSessionTask`) is not part of the
> emulator suite; those task handlers are exercised directly in `test/integration.test.js`.

## Deploy

```bash
firebase deploy --only functions,firestore:rules
```

## One-time retention setup (TTL)

```bash
gcloud firestore fields ttls update expireAt --collection-group=sessions  --enable-ttl
gcloud firestore fields ttls update expireAt --collection-group=checkins  --enable-ttl
gcloud firestore fields ttls update expireAt --collection-group=rateLimits --enable-ttl
```
