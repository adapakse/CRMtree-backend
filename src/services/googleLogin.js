'use strict';

// "Sign in with Google" — the Google-facing half (no DB, no sessions).
// Reuses the existing Google OAuth client (GOOGLE_CLIENT_ID/SECRET, also used
// for Gmail) with its own redirect URI and ONLY the openid/email/profile
// scopes — never a Gmail scope.
const { google } = require('googleapis');
const config = require('../config');

const SCOPES = ['openid', 'email', 'profile'];

const isConfigured = () => !!(config.google.clientId && config.google.clientSecret && config.google.loginRedirectUri);

const makeClient = () => new google.auth.OAuth2(
  config.google.clientId, config.google.clientSecret, config.google.loginRedirectUri,
);

function buildAuthUrl({ state, nonce }) {
  return makeClient().generateAuthUrl({
    response_type: 'code',
    scope: SCOPES,
    state,
    nonce,
    prompt: 'select_account',
    access_type: 'online',
  });
}

// Exchanges the code and verifies the ID token (signature via Google certs,
// issuer, audience = our client id, expiry) and the OIDC nonce.
// Returns { email, emailVerified }; throws on any failure.
async function exchangeCodeForIdentity(code, expectedNonce) {
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  if (!tokens?.id_token) throw new Error('no id_token');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
  const p = ticket.getPayload();
  if (!p || p.nonce !== expectedNonce) throw new Error('nonce mismatch');
  return { email: typeof p.email === 'string' ? p.email : '', emailVerified: p.email_verified === true };
}

module.exports = { isConfigured, buildAuthUrl, exchangeCodeForIdentity, SCOPES };
