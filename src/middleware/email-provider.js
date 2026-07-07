'use strict';
// src/middleware/email-provider.js
//
// Enforces "one active email provider per tenant, chosen by the super admin,
// never by the CRM user" at the API layer — independent of what the frontend
// shows or hides. Blocks connect/send/sync actions when the calling tenant's
// active_email_provider does not match the provider that owns the route.
//
// Demo tenants (crm_training_mode) bypass this entirely: training mode never
// touches a real provider, so it must not require tenant email configuration.

const db = require('../config/database');
const { isTrainingMode } = require('../utils/trainingMode');

/**
 * Resolves whether `providerKey` is usable for `tenantId` right now.
 * Returns { ok, active, training } — reusable by both the Express middleware
 * below and the OAuth callback routes (which run before requireAuth sets
 * req.tenantId, so they resolve tenantId themselves and call this directly).
 */
async function resolveProviderGate(tenantId, providerKey) {
  if (await isTrainingMode(tenantId)) {
    return { ok: true, active: null, training: true };
  }
  if (!tenantId) {
    return { ok: false, active: null, training: false };
  }
  const { rows } = await db.query(
    'SELECT active_email_provider FROM tenants WHERE id = $1',
    [tenantId],
  );
  const active = rows[0]?.active_email_provider || null;
  return { ok: active === providerKey, active, training: false };
}

/**
 * Express middleware factory. Must run after requireAuth (needs req.tenantId).
 */
function requireActiveEmailProvider(providerKey) {
  return async (req, res, next) => {
    try {
      const gate = await resolveProviderGate(req.tenantId, providerKey);
      if (gate.ok) return next();

      return res.status(gate.active ? 403 : 400).json({
        error: gate.active
          ? `Ta organizacja korzysta z innego dostawcy poczty (${gate.active}).`
          : 'Poczta nie jest skonfigurowana dla tej organizacji. Skontaktuj się z administratorem.',
        code: 'PROVIDER_NOT_ACTIVE',
        active_email_provider: gate.active,
      });
    } catch (err) { next(err); }
  };
}

module.exports = { requireActiveEmailProvider, resolveProviderGate };
