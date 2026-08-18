'use strict';
// src/config/emailProviderRequiredFields.js
//
// Per-tenant required config fields for gmail/outlook/zoho, plus a helper to
// find which ones are missing from a tenant_email_providers row. This is the
// single source of truth for "required" — used by the admin-tenants.js save
// validation AND by each service's getTenant*Creds() read-time validation.
//
// Kept in its own module, separate from config/email-providers.js, because
// that file requires the service modules (gmailService/outlookService/
// zohoService) — importing it back from those services would be a circular
// require.
//
// pubsub_subscription is intentionally NOT listed here: it exists in the
// Gmail config UI but is not read by any code path today, so marking it
// "required" would just force admins to fill in a value nothing uses. That
// field is a separate decision (pending), not part of this required-fields set.

const REQUIRED_CONFIG_FIELDS = {
  gmail:   ['client_id', 'client_secret', 'redirect_uri', 'pubsub_topic'],
  // No azure_tenant_id — the app is registered as multitenant ("Accounts in
  // any organizational directory and personal Microsoft accounts") and the
  // OAuth authority is always the fixed "common" endpoint (see
  // outlookService.js). Requiring a specific tenant GUID here would push
  // admins toward exactly the misconfiguration that broke sign-in for every
  // account outside one organization.
  outlook: ['client_id', 'client_secret', 'redirect_uri'],
  zoho:    ['client_id', 'client_secret', 'redirect_uri'],
};

// Fields stored as real columns on tenant_email_providers; anything else is
// looked up inside the extra_config JSONB column.
const TOP_LEVEL_FIELDS = ['client_id', 'client_secret', 'redirect_uri'];

function getFieldValue(field, row) {
  if (TOP_LEVEL_FIELDS.includes(field)) return row[field];
  return row.extra_config ? row.extra_config[field] : undefined;
}

function isMissing(value) {
  return value === null || value === undefined || value === '';
}

// row: { client_id, client_secret, redirect_uri, extra_config }
function getMissingRequiredFields(providerKey, row) {
  const required = REQUIRED_CONFIG_FIELDS[providerKey] || [];
  return required.filter((field) => isMissing(getFieldValue(field, row)));
}

module.exports = { REQUIRED_CONFIG_FIELDS, getMissingRequiredFields };
