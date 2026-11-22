'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/public-app-config.js — unauthenticated config the mobile app reads
// on every start, before login (ADR 001, backend change 10). Old app builds
// stay installed for weeks; when a breaking API change can't be versioned,
// raising the minimum version makes older builds show "Zaktualizuj aplikację"
// instead of failing in confusing ways.
//
// `api` and `features` are the other half of the handshake: the app learns
// which contract version and build it talks to and which optional functions
// this host actually offers, so it can hide a button instead of getting a 404.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const config = require('../config');
const { spec } = require('./openapi');

// Set by the deploy workflows (image tag + commit). Missing locally.
const BUILD_VERSION = process.env.BUILD_VERSION || 'local';

// A feature is listed only when the host is configured for it; the list grows,
// a name is never reused with another meaning (old apps read it literally).
function enabledFeatures() {
  return {
    sso_google: Boolean(config.saml?.idpCert),
    push: Boolean(config.push?.firebaseServiceAccountJson),
  };
}

// ── GET /api/public/app-config ─────────────────────────────────────
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    min_supported_version: {
      android: config.mobile.minVersionAndroid,
      ios: config.mobile.minVersionIos,
    },
    api: {
      version: spec.info.version,
      build: BUILD_VERSION,
    },
    features: enabledFeatures(),
  });
});

module.exports = router;
