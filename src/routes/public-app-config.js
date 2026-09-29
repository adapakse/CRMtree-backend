'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/public-app-config.js — unauthenticated config the mobile app reads
// on every start, before login (ADR 001, backend change 10). Old app builds
// stay installed for weeks; when a breaking API change can't be versioned,
// raising the minimum version makes older builds show "Zaktualizuj aplikację"
// instead of failing in confusing ways.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const config = require('../config');

// ── GET /api/public/app-config ─────────────────────────────────────
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    min_supported_version: {
      android: config.mobile.minVersionAndroid,
      ios: config.mobile.minVersionIos,
    },
  });
});

module.exports = router;
