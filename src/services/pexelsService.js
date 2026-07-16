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

// Picks randomly among the top results (rather than always the #1 match) so
// re-rolling (see crm-seo.js POST /content/:id/reroll-image) has a real
// chance of returning something different from excludeUrl.
async function searchHeaderImage(query, excludeUrl = null) {
  if (!config.pexels.apiKey) return null;
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape&locale=pl-PL`;
    const response = await fetch(url, { headers: { Authorization: config.pexels.apiKey } });
    if (!response.ok) {
      logger.warn('Pexels search failed', { query, status: response.status });
      return null;
    }
    const data = await response.json();
    const photos = (data.photos || []).map((p) => p.src?.large).filter(Boolean);
    const candidates = excludeUrl ? photos.filter((u) => u !== excludeUrl) : photos;
    const pool = candidates.length ? candidates : photos;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  } catch (err) {
    logger.warn('Pexels search error', { query, error: err.message });
    return null;
  }
}

module.exports = { searchHeaderImage };
