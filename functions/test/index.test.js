'use strict';
// Smoke tests for the deployed surface: the entrypoint must load (all imports
// resolve, all handlers register) and the expected callable/task handlers must
// be exported. These run without the Firebase emulator or any credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_HANDLERS = [
  'startSession',
  'checkIn',
  'reportPresence',
  'challengeResponse',
  'issueChallengeTask',
  'closeSessionTask',
  'endSession',
  'sessionSummary',
  'classStats',
  'approveDeviceReset',
];

test('entrypoint loads and exports every Cloud Function', () => {
  const fns = require('../src/index.js');
  for (const name of EXPECTED_HANDLERS) {
    assert.equal(typeof fns[name], 'function', `missing export: ${name}`);
  }
});

test('package.json main points at an existing entrypoint', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.main, 'src/index.js');
  assert.ok(fs.existsSync(path.join(__dirname, '..', pkg.main)), `main not found: ${pkg.main}`);
});

test('build metadata targets Node 20 (Firebase runtime)', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.engines.node, '20');
});

test('firestore rules default-deny everything not explicitly allowed', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');
  assert.match(rules, /match \/\{document=\*\*\} \{ allow read, write: if false; \}/);
  assert.match(rules, /match \/sessions\/\{sessionId\} \{[\s\S]*allow write: if false;/);
});
