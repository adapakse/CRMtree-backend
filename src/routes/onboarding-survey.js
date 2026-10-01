'use strict';
// routes/onboarding-survey.js
//
// Tenant-admin side of the onboarding survey — always scoped to the caller's
// own tenant (req.tenantId). Super admins read any tenant's survey, secrets
// included, through GET /api/admin/tenants/:id/onboarding-survey instead.
//
// GET  /api/admin/onboarding-survey         — own survey (secrets never returned)
// PUT  /api/admin/onboarding-survey         — save a draft
// POST /api/admin/onboarding-survey/submit  — save and mark as submitted

const router = require('express').Router();
const { body } = require('express-validator');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');
const onboardingSurveyService = require('../services/onboardingSurveyService');

router.use(requireAuth, requireAdmin);

const surveyBodyRules = [
  body('answers').isObject(),
  body('secrets').optional({ nullable: true }).isObject(),
];

function saveHandler({ submit }) {
  return async (req, res, next) => {
    try {
      const survey = await onboardingSurveyService.saveSurvey(
        req.tenantId,
        { answers: req.body.answers, secrets: req.body.secrets },
        req.user.id,
        { submit },
      );
      if (submit) {
        logger.info('Tenant admin submitted onboarding survey', { tenantId: req.tenantId, by: req.user.email });
      }
      res.json(survey);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await onboardingSurveyService.getSurvey(req.tenantId));
  } catch (err) { next(err); }
});

router.put('/', surveyBodyRules, validate, saveHandler({ submit: false }));

router.post('/submit', surveyBodyRules, validate, saveHandler({ submit: true }));

module.exports = router;
