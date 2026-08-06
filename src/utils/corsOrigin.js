'use strict';
// src/utils/corsOrigin.js
//
// CORS origin check for app.js. Beyond the static frontend/app URLs, also
// accepts any https://{slug}.{tenantBaseDomain} origin so tenant subdomains
// (acme.crmtree.pl) can call the API without hardcoding every tenant host.

const config = require('../config');
const { BASE_DOMAINS } = require('../config/tenantHost');

const STATIC_ALLOWED = [config.frontendUrl, config.appUrl].filter(Boolean);

const TENANT_ORIGIN_REGEX = new RegExp(
  `^https?:\\/\\/[a-z0-9][a-z0-9-]*\\.(${BASE_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|')})$`,
  'i',
);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser requests carry no Origin header
  if (STATIC_ALLOWED.includes(origin)) return true;
  return TENANT_ORIGIN_REGEX.test(origin);
}

module.exports = { isAllowedOrigin };
