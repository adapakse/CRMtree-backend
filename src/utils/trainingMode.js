'use strict';

const { pool } = require('../config/database');

// Per-tenant cache: Map<tenantId, { value: boolean, at: number }>
const _cache = new Map();
const TTL = 5_000; // 5 s — krótki cache, żeby zmiana ustawienia była widoczna natychmiast

async function isTrainingMode(tenantId) {
  // No tenant context (e.g. a super-admin token used without impersonating a
  // tenant) means there is no per-tenant crm_training_mode row to check —
  // training mode can't be "actually enabled" for a tenant that isn't there,
  // so this must resolve to false rather than assume a demo state.
  if (!tenantId) {
    return false;
  }
  const now    = Date.now();
  const cached = _cache.get(tenantId);
  if (cached && now - cached.at < TTL) return cached.value;
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'crm_training_mode' AND tenant_id = $1",
      [tenantId],
    );
    const value = rows.length > 0 && rows[0].value === 'true';
    _cache.set(tenantId, { value, at: now });
    return value;
  } catch {
    // DB error and no cached value yet: fail safe into training mode rather
    // than risking a real send/signature for a tenant we couldn't actually
    // confirm is out of demo mode.
    return cached?.value ?? true;
  }
}

function clearTrainingModeCache(tenantId) {
  if (tenantId) {
    _cache.delete(tenantId);
  } else {
    _cache.clear();
  }
}

module.exports = { isTrainingMode, clearTrainingModeCache };
