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

// Picks randomly among a wide, randomly-paged result set (rather than always
// the top match) so re-rolling (see crm-seo.js POST /content/:id/reroll-image)
// draws from a real pool instead of cycling the same handful of photos —
// per_page=8/page=1 alone gives only 8 possible results total, which repeats
// fast under repeated re-rolls.
async function searchHeaderImage(query, excludeUrl = null) {
  if (!config.pexels.apiKey) return null;
  try {
    const page = 1 + Math.floor(Math.random() * 3); // spread across the first 3 pages
    const fetchPage = async (p) => {
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=40&page=${p}&orientation=landscape&locale=pl-PL`;
      const response = await fetch(url, { headers: { Authorization: config.pexels.apiKey } });
      if (!response.ok) {
        logger.warn('Pexels search failed', { query, status: response.status });
        return [];
      }
      const data = await response.json();
      return (data.photos || []).map((photo) => photo.src?.large).filter(Boolean);
    };

    // Niche queries may not have enough results to fill a high page — fall back to page 1.
    let photos = await fetchPage(page);
    if (!photos.length && page !== 1) photos = await fetchPage(1);
    const candidates = excludeUrl ? photos.filter((u) => u !== excludeUrl) : photos;
    const pool = candidates.length ? candidates : photos;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  } catch (err) {
    logger.warn('Pexels search error', { query, error: err.message });
    return null;
  }
}

module.exports = { searchHeaderImage };
