'use strict';
// services/onboardingSurveyService.js
//
// Onboarding survey of a tenant (one row per tenant). The form definition —
// sections, labels, which fields are secrets — lives in the frontend; this
// service only stores a flat key → value map, so adding a question never
// needs a backend change. Secret fields arrive in a separate `secrets` map
// and are stored encrypted; plaintext goes back only to super admins.

const db = require('../config/database');
const { encrypt, decrypt } = require('../utils/encrypt');

const FIELD_KEY_PATTERN   = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FIELDS          = 300;
const MAX_TEXT_LENGTH     = 5000;
const MAX_LIST_ITEMS      = 50;
const MAX_LIST_ITEM_LENGTH = 200;
const MAX_SECRET_LENGTH   = 4000;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function assertFieldMap(map, name) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw badRequest(`${name} musi być obiektem klucz → wartość`);
  }
  const keys = Object.keys(map);
  if (keys.length > MAX_FIELDS) throw badRequest(`${name}: zbyt wiele pól`);
  for (const key of keys) {
    if (!FIELD_KEY_PATTERN.test(key)) throw badRequest(`${name}: nieprawidłowy klucz pola "${key}"`);
  }
}

function sanitizeAnswers(answers) {
  assertFieldMap(answers, 'answers');
  const clean = {};
  for (const [key, value] of Object.entries(answers)) {
    if (Array.isArray(value)) {
      const isValidList = value.length <= MAX_LIST_ITEMS
        && value.every(item => typeof item === 'string' && item.length <= MAX_LIST_ITEM_LENGTH);
      if (!isValidList) throw badRequest(`answers: nieprawidłowa lista w polu "${key}"`);
      clean[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > MAX_TEXT_LENGTH) throw badRequest(`answers: zbyt długa wartość w polu "${key}"`);
      clean[key] = value;
    } else {
      throw badRequest(`answers: pole "${key}" musi być tekstem lub listą tekstów`);
    }
  }
  return clean;
}

// A value made only of mask characters can only be a UI placeholder that
// leaked into the body — same rule as isMaskedSecretPlaceholder in
// routes/admin-tenants.js.
function isRealSecretValue(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/^[*•●·]+$/.test(value.trim());
}

// Blank/masked = keep the previously saved secret, so the form never has to
// send a secret back just to preserve it.
function mergeSecrets(existingEncrypted, incoming) {
  if (incoming === undefined || incoming === null) return existingEncrypted;
  assertFieldMap(incoming, 'secrets');
  const merged = { ...existingEncrypted };
  for (const [key, value] of Object.entries(incoming)) {
    if (!isRealSecretValue(value)) continue;
    if (value.length > MAX_SECRET_LENGTH) throw badRequest(`secrets: zbyt długa wartość w polu "${key}"`);
    merged[key] = encrypt(value.trim());
  }
  return merged;
}

function toResponse(row, { revealSecrets }) {
  if (!row) {
    return {
      status: 'not_started', answers: {}, configured_secret_keys: [],
      submitted_at: null, submitted_by_name: null, updated_at: null,
    };
  }
  const response = {
    status: row.status,
    answers: row.answers,
    configured_secret_keys: Object.keys(row.encrypted_secrets),
    submitted_at: row.submitted_at,
    submitted_by_name: row.submitted_by_name,
    updated_at: row.updated_at,
  };
  if (revealSecrets) {
    response.secrets = Object.fromEntries(
      Object.entries(row.encrypted_secrets).map(([key, value]) => [key, decrypt(value)]),
    );
  }
  return response;
}

async function findSurveyRow(tenantId) {
  const { rows } = await db.query(
    `SELECT s.status, s.answers, s.encrypted_secrets, s.submitted_at, s.updated_at,
            u.display_name AS submitted_by_name
     FROM tenant_onboarding_surveys s
     LEFT JOIN users u ON u.id = s.submitted_by
     WHERE s.tenant_id = $1`,
    [tenantId],
  );
  return rows[0] || null;
}

async function getSurvey(tenantId, { revealSecrets = false } = {}) {
  return toResponse(await findSurveyRow(tenantId), { revealSecrets });
}

// submit=false saves a draft without touching status, so a tenant admin
// correcting an already-submitted survey doesn't silently "un-submit" it.
async function saveSurvey(tenantId, { answers, secrets }, userId, { submit = false } = {}) {
  const cleanAnswers = sanitizeAnswers(answers);
  const existing = await findSurveyRow(tenantId);
  const encryptedSecrets = mergeSecrets(existing?.encrypted_secrets ?? {}, secrets);

  await db.query(
    `INSERT INTO tenant_onboarding_surveys
       (tenant_id, status, answers, encrypted_secrets, submitted_at, submitted_by, updated_by)
     VALUES ($1, CASE WHEN $5 THEN 'submitted' ELSE 'draft' END, $2, $3,
             CASE WHEN $5 THEN NOW() END, CASE WHEN $5 THEN $4::uuid END, $4)
     ON CONFLICT (tenant_id) DO UPDATE SET
       answers           = EXCLUDED.answers,
       encrypted_secrets = EXCLUDED.encrypted_secrets,
       status            = CASE WHEN $5 THEN 'submitted' ELSE tenant_onboarding_surveys.status END,
       submitted_at      = CASE WHEN $5 THEN NOW() ELSE tenant_onboarding_surveys.submitted_at END,
       submitted_by      = CASE WHEN $5 THEN $4::uuid ELSE tenant_onboarding_surveys.submitted_by END,
       updated_by        = $4,
       updated_at        = NOW()`,
    [tenantId, JSON.stringify(cleanAnswers), JSON.stringify(encryptedSecrets), userId, submit],
  );

  return getSurvey(tenantId);
}

module.exports = { getSurvey, saveSurvey };
