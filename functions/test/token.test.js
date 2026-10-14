'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { slotOf, tokenForSlot, verifyToken, SLOT_SECONDS } = require('../src/token');

const SECRET = 'a1'.repeat(32);
const OTHER_SECRET = 'b2'.repeat(32);
const NOW = 1_700_000_010_000;
const slot = slotOf(NOW);

test('token is 12 lowercase hex chars and deterministic per slot', () => {
  const t = tokenForSlot(SECRET, slot);
  assert.match(t, /^[0-9a-f]{12}$/);
  assert.equal(t, tokenForSlot(SECRET, slot));
  assert.notEqual(t, tokenForSlot(SECRET, slot + 1));
  assert.notEqual(t, tokenForSlot(OTHER_SECRET, slot));
});

test('accepts current, previous and next slot', () => {
  for (const d of [-1, 0, 1]) {
    assert.equal(verifyToken(SECRET, tokenForSlot(SECRET, slot + d), NOW), slot + d);
  }
});

test('rejects tokens two or more slots away', () => {
  for (const d of [-2, 2, -10, 10]) {
    assert.equal(verifyToken(SECRET, tokenForSlot(SECRET, slot + d), NOW), null);
  }
});

test('token expires as time advances past tolerance', () => {
  const t = tokenForSlot(SECRET, slot);
  assert.equal(verifyToken(SECRET, t, NOW + 1 * SLOT_SECONDS * 1000), slot);
  assert.equal(verifyToken(SECRET, t, NOW + 2 * SLOT_SECONDS * 1000), null);
});

test('rejects wrong secret and malformed input', () => {
  const t = tokenForSlot(SECRET, slot);
  assert.equal(verifyToken(OTHER_SECRET, t, NOW), null);
  assert.equal(verifyToken(SECRET, t.toUpperCase(), NOW), null);
  assert.equal(verifyToken(SECRET, t.slice(0, 10), NOW), null);
  assert.equal(verifyToken(SECRET, 'zzzzzzzzzzzz', NOW), null);
  assert.equal(verifyToken(SECRET, null, NOW), null);
  assert.equal(verifyToken(SECRET, 123456, NOW), null);
  assert.equal(verifyToken(null, t, NOW), null);
});
