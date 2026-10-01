'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/openapi.js — publishes the mobile API contract
// (src/openapi/mobile-v1.yaml, ADR 001 §5). The Dart client in
// crmtree-mobile is generated from this document; __tests__/openapiContract
// checks real responses against it so the two can't drift apart.
// ─────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const router = require('express').Router();

const SPEC_PATH = path.join(__dirname, '..', 'openapi', 'mobile-v1.yaml');
const spec = YAML.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

// ── GET /api/openapi.json ──────────────────────────────────────────
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(spec);
});

module.exports = router;
module.exports.spec = spec;
