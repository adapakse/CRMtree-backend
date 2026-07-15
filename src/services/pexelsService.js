'use strict';
// ─────────────────────────────────────────────────────────────────
// services/pexelsService.js — header image lookup via the Pexels API
// (free tier; Pexels license does not require attribution).
//
// The image is a nice-to-have, not a hard requirement for publishing an
// article — any failure here (missing key, no results, network error)
// degrades to no image rather than failing article generation.
// ─────────────────────────────────────────────────────────────────

const config = require('../config');
const logger = require('../utils/logger');

async function searchHeaderImage(query) {
  if (!config.pexels.apiKey) return null;
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&locale=pl-PL`;
    const response = await fetch(url, { headers: { Authorization: config.pexels.apiKey } });
    if (!response.ok) {
      logger.warn('Pexels search failed', { query, status: response.status });
      return null;
    }
    const data = await response.json();
    return data.photos?.[0]?.src?.large ?? null;
  } catch (err) {
    logger.warn('Pexels search error', { query, error: err.message });
    return null;
  }
}

module.exports = { searchHeaderImage };
