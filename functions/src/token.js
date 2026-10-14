'use strict';
const crypto = require('crypto');

const SLOT_SECONDS = 15;
const TOLERANCE_SLOTS = 1;
const TOKEN_BYTES = 6;
const TOKEN_HEX_RE = /^[0-9a-f]{12}$/;

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function slotOf(ms) {
  return Math.floor(ms / 1000 / SLOT_SECONDS);
}

function tokenForSlot(secretHex, slot) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(slot));
  return crypto
    .createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(msg)
    .digest()
    .subarray(0, TOKEN_BYTES)
    .toString('hex');
}

// Returns the matched slot number, or null. Always checks every slot in the
// tolerance range with a constant-time compare.
function verifyToken(secretHex, presented, nowMs) {
  if (typeof secretHex !== 'string' || typeof presented !== 'string') return null;
  if (!TOKEN_HEX_RE.test(presented)) return null;
  const presentedBuf = Buffer.from(presented, 'hex');
  const current = slotOf(nowMs);
  let matched = null;
  for (let d = -TOLERANCE_SLOTS; d <= TOLERANCE_SLOTS; d++) {
    const expected = Buffer.from(tokenForSlot(secretHex, current + d), 'hex');
    if (crypto.timingSafeEqual(expected, presentedBuf) && matched === null) {
      matched = current + d;
    }
  }
  return matched;
}

module.exports = { SLOT_SECONDS, TOLERANCE_SLOTS, generateSecret, slotOf, tokenForSlot, verifyToken };
