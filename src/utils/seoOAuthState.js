'use strict';
// ─────────────────────────────────────────────────────────────────
// utils/seoOAuthState.js — signed OAuth `state` for SEObot's Search Console,
// LinkedIn and Facebook connections.
//
// The callbacks used to always redirect to config.frontendUrl (app.crmtree.pl).
// A tenant working on its own subdomain (comparme.crmtree.pl) was dropped on
// the global app host after connecting (Adam, 2026-09-28). The state now also
// carries the tenant subdomain the flow started from, so the callback can send
// the user back there. Only a recognized tenant-subdomain host is ever
// recorded, and it's covered by the HMAC, so the callback can't be turned into
// an open redirect.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const config = require('../config');
const { matchTenantSlug, resolveRequestHost } = require('../config/tenantHost');

const STATE_TTL_MS = 30 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', config.jwt.secret).update(payload).digest('hex').slice(0, 16);
}

/** The tenant subdomain the request came from, or '' for app/API/local hosts. */
function returnHostFor(req) {
  const host = String(resolveRequestHost(req)).toLowerCase().split(':')[0];
  return matchTenantSlug(host) ? host : '';
}

function makeOAuthState(tenantId, userId, returnHost = '') {
  const ts = Date.now();
  const encodedHost = Buffer.from(returnHost).toString('base64url');
  return `${tenantId}.${userId}.${ts}.${encodedHost}.${sign(`${tenantId}:${userId}:${ts}:${returnHost}`)}`;
}

/** Returns { tenantId, userId, returnHost } or null when missing, expired or tampered with. */
function parseOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const parts = state.split('.');
  // 4 parts = issued before the return host existed (a flow started just before a deploy).
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [tenantId, userId, tsStr] = parts;
  const sig = parts[parts.length - 1];
  const returnHost = parts.length === 5 ? Buffer.from(parts[3], 'base64url').toString() : '';
  const ts = parseInt(tsStr, 10);
  if (!ts || Date.now() - ts > STATE_TTL_MS) return null;
  const payload = parts.length === 5 ? `${tenantId}:${userId}:${ts}:${returnHost}` : `${tenantId}:${userId}:${ts}`;
  if (sig !== sign(payload)) return null;
  if (returnHost && !matchTenantSlug(returnHost)) return null;
  return { tenantId, userId, returnHost };
}

/** Frontend origin to send the user back to after the provider's callback. */
function frontendBaseFor(parsedState) {
  return parsedState?.returnHost ? `https://${parsedState.returnHost}` : config.frontendUrl;
}

module.exports = { returnHostFor, makeOAuthState, parseOAuthState, frontendBaseFor };
