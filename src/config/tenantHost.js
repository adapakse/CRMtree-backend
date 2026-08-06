'use strict';
// src/config/tenantHost.js
//
// Single source of truth for tenant-subdomain hostnames ({slug}.crmtree.pl).
// Used by middleware/auth.js (subdomain -> tenant isolation guard),
// utils/corsOrigin.js (allow tenant subdomains as CORS origins) and
// routes/admin-tenants.js (reject reserved slugs at tenant creation).
//
// BASE_DOMAINS is env-configurable so a local/dev domain (e.g. a *.localtest.me
// entry, which publicly resolves to 127.0.0.1) can be added for testing the
// subdomain flow without touching production code.

const BASE_DOMAINS = (process.env.TENANT_BASE_DOMAINS || 'crmtree.pl,crmtree.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Infra/product hostnames that must never be resolved as a tenant slug, even
// if a tenant row with that slug somehow existed.
const RESERVED_SLUGS = new Set([
  'app', 'api', 'www', 'admin', 'mail', 'ftp', 'static', 'cdn', 'assets',
  'int', 'staging', 'stage', 'dev', 'test', 'preview', 'crmtree-gold',
]);

const HOST_REGEX = new RegExp(
  `^([a-z0-9][a-z0-9-]*)\\.(${BASE_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|')})$`,
  'i',
);

// True when `slug` is allowed to be resolved as (or registered as) a tenant
// subdomain — i.e. it isn't one of the reserved infra/product hostnames.
function isSlugAllowed(slug) {
  return !!slug && !RESERVED_SLUGS.has(String(slug).toLowerCase());
}

/**
 * Extracts a candidate tenant slug from a hostname, or null when the host
 * isn't a recognized tenant-subdomain shape (wrong base domain, reserved
 * word, bare base domain, etc.). Does NOT check the slug against the
 * database — callers do that.
 */
function matchTenantSlug(hostname) {
  if (!hostname) return null;
  const match = String(hostname).toLowerCase().match(HOST_REGEX);
  if (!match) return null;
  const slug = match[1];
  return isSlugAllowed(slug) ? slug : null;
}

// Resolves the hostname to treat as "what the browser actually visited" for
// a given request. The frontend's own SSR reverse-proxy (server.ts) sits
// between the browser and this API, and its `changeOrigin: true` rewrites
// the real Host header to match the API's own upstream target — so by the
// time a proxied request reaches us, req.hostname/Host is always the API's
// own host, never the tenant subdomain. server.ts compensates by forwarding
// the original host in a custom `X-CRM-Tenant-Host` header (not the
// standard X-Forwarded-Host, which Azure's own ingress in front of the API
// container may rewrite for its own hop). A caller hitting this API
// directly (no proxy in front) still works via the req.hostname/Host
// fallback below.
//
// Trust note: X-CRM-Tenant-Host is attacker-controllable on a direct call
// to the API. That's acceptable — this value only ever feeds the tenant
// subdomain isolation guard (an extra safety net against session/host
// confusion), never tenant data scoping, which is always derived from the
// JWT alone (req.tenantId), regardless of this header.
function resolveRequestHost(req) {
  return req.headers['x-crm-tenant-host'] || req.hostname || req.headers.host || '';
}

module.exports = {
  BASE_DOMAINS, RESERVED_SLUGS, HOST_REGEX,
  matchTenantSlug, isSlugAllowed, resolveRequestHost,
};
