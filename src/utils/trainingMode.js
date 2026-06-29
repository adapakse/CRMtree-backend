'use strict';

const { pool } = require('../config/database');

// Per-tenant cache: Map<tenantId, { value: boolean, at: number }>
const _cache = new Map();
const TTL = 5_000; // 5 s — krótki cache, żeby zmiana ustawienia była widoczna natychmiast

async function isTrainingMode(tenantId) {
  if (!tenantId) {
    console.warn('[TrainingMode] tenantId missing — defaulting to training mode (safe)');
    return true;
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
    // nie czyść cache przy błędzie DB — zostaw poprzednią wartość
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
