'use strict';

const { pool } = require('../config/database');

let _cache = null;
let _cacheAt = 0;
const TTL = 5_000; // 5 s — krótki cache, żeby zmiana ustawienia była widoczna natychmiast

async function isTrainingMode() {
  const now = Date.now();
  if (_cache !== null && now - _cacheAt < TTL) return _cache;
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'crm_training_mode' LIMIT 1",
    );
    _cache = rows.length > 0 && rows[0].value === 'true';
    _cacheAt = now;
  } catch {
    // nie czyść cache przy błędzie DB — zostaw poprzednią wartość
  }
  return _cache ?? false;
}

function clearTrainingModeCache() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { isTrainingMode, clearTrainingModeCache };
