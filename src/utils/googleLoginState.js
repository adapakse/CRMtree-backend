'use strict';

// Signed, short-lived `state` for "Sign in with Google" (OAuth 2.0 / OIDC).
// It carries what has to survive the round-trip through Google: the client
// (web|mobile), the device id (mobile), the originating tenant host and a
// random nonce. The nonce is also stored in an HttpOnly cookie at the start of
// the flow and sent to Google as the OIDC `nonce`, so the callback can prove
// the browser that returns is the one that started the login (CSRF) and that
// the ID token was minted for this very request (replay).
//
// Same construction as mobileSamlState.js: HMAC-SHA256 with a key derived from
// JWT_SECRET, domain-separated so it can never be confused with a JWT or with
// the SAML RelayState. Format: "g1.<base64url(JSON)>.<base64url(HMAC)>".
const crypto = require('crypto');
const config = require('../config');
const { isValidDeviceId } = require('./mobileSamlState');

const PREFIX = 'g1.';
const TTL_MS = 10 * 60 * 1000;
const CLIENTS = ['web', 'mobile'];

const key = () => crypto.createHmac('sha256', config.jwt.secret).update('crmtree:google-login-state:v1').digest();
const sign = (payload) => crypto.createHmac('sha256', key()).update(payload).digest('base64url');

const newNonce = () => crypto.randomBytes(24).toString('base64url');

// Returns { state, nonce }. `host` is the originating request host (may be '').
function signGoogleState({ client, deviceId = null, host = '' }, now = Date.now()) {
  if (!CLIENTS.includes(client)) throw new Error('invalid client');
  if (client === 'mobile' && !isValidDeviceId(deviceId)) throw new Error('invalid device_id');
  const nonce = newNonce();
  const body = { c: client, h: String(host || '').toLowerCase().slice(0, 255), n: nonce, e: now + TTL_MS };
  if (client === 'mobile') body.d = deviceId;
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return { state: `${PREFIX}${payload}.${sign(payload)}`, nonce };
}

// Returns { client, deviceId, host, nonce } for a valid, unexpired state, else null.
function verifyGoogleState(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { c, d, h, n, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!CLIENTS.includes(c) || typeof n !== 'string' || !n || typeof e !== 'number' || e <= now) return null;
    if (c === 'mobile' && !isValidDeviceId(d)) return null;
    return { client: c, deviceId: c === 'mobile' ? d : null, host: typeof h === 'string' ? h : '', nonce: n };
  } catch { return null; }
}

module.exports = { signGoogleState, verifyGoogleState, TTL_MS };
