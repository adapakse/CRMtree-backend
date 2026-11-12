'use strict';

// Signed, short-lived SAML RelayState for the mobile app's Google SSO login.
// The app opens GET /api/auth/saml?client=mobile&device_id=…; the device id has
// to survive the round-trip through the IdP, and RelayState is the only thing
// the IdP echoes back. It is HMAC-signed (key derived from JWT_SECRET, domain-
// separated so it can never be confused with a JWT) and expires after 10 min,
// so a user can't smuggle a different device_id/client into the callback.
//
// Format: "m1.<base64url(JSON {d, e})>.<base64url(HMAC-SHA256)>"
const crypto = require('crypto');
const config = require('../config');

const PREFIX = 'm1.';
const TTL_MS = 10 * 60 * 1000;

const key = () => crypto.createHmac('sha256', config.jwt.secret).update('crmtree:mobile-saml-relaystate:v1').digest();
const sign = (payload) => crypto.createHmac('sha256', key()).update(payload).digest('base64url');

// Same rule as POST /auth/mobile/login.
function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.length >= 8 && deviceId.length <= 128;
}

function signMobileRelayState(deviceId, now = Date.now()) {
  if (!isValidDeviceId(deviceId)) throw new Error('invalid device_id');
  const payload = Buffer.from(JSON.stringify({ d: deviceId, e: now + TTL_MS })).toString('base64url');
  return `${PREFIX}${payload}.${sign(payload)}`;
}

// True when the value claims to be a mobile RelayState (valid or not).
const looksLikeMobileRelayState = (v) => typeof v === 'string' && v.startsWith(PREFIX);

// Returns { deviceId } for a valid, unexpired state, otherwise null.
function verifyMobileRelayState(value, now = Date.now()) {
  if (!looksLikeMobileRelayState(value)) return null;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { d, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isValidDeviceId(d) || typeof e !== 'number' || e <= now) return null;
    return { deviceId: d };
  } catch { return null; }
}

module.exports = { signMobileRelayState, verifyMobileRelayState, looksLikeMobileRelayState, isValidDeviceId, TTL_MS };
