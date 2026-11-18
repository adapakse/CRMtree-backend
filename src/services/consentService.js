'use strict';
// services/consentService.js
// Consent types per tenant (app_settings 'crm.consent_types', JSON [{key, label, description}]).
// Shared by company consents, person consents and e-mail campaigns.

const db = require('../config/database');

async function loadConsentTypes(tenantId) {
  const { rows } = await db.query(
    `SELECT value FROM app_settings WHERE key = 'crm.consent_types' AND tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) return [];
  try {
    const types = JSON.parse(rows[0].value);
    return Array.isArray(types) ? types : [];
  } catch {
    return [];
  }
}

module.exports = { loadConsentTypes };
