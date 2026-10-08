'use strict';
// services/ksefCompanyService.js
//
// KSeF configuration of a tenant, managed by the tenant admin: the companies
// (the tenant's own NIPs, each with a KSeF token) whose purchase invoices are
// synced, and how many days the first sync goes back.
//
// A token is checked by authenticating against KSeF before it is stored. It is
// kept encrypted (utils/encrypt.js, the same mechanism as the WhatsApp and
// mailbox secrets) and never leaves this module and ksefSyncService — the API
// shows only its last four characters.

const db = require('../config/database');
const { encrypt } = require('../utils/encrypt');
const ksefApiClient = require('./ksefApiClient');
const invoiceDocumentService = require('./invoiceDocumentService');

const INITIAL_SYNC_DAYS_KEY     = 'ksef_initial_sync_days';
const DEFAULT_INITIAL_SYNC_DAYS = 30;
const MIN_INITIAL_SYNC_DAYS     = 1;
const MAX_INITIAL_SYNC_DAYS     = 365;
const TOKEN_HINT_LENGTH         = 4;
const NIP_WEIGHTS               = [6, 5, 7, 2, 3, 4, 5, 6, 7];
const DAY_MS                    = 86_400_000;

const COMPANY_COLUMNS = `
  id, nip, name, token_hint, status, last_error, sync_from, last_attempt_at, last_synced_at,
  created_at, updated_at`;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Returns the 10 digits of a valid Polish NIP, or null.
function normalizeNip(rawNip) {
  if (typeof rawNip !== 'string') return null;
  const nip = rawNip.toUpperCase().replace(/[\s.-]/g, '').replace(/^PL/, '');
  if (!/^\d{10}$/.test(nip)) return null;
  const checksum = NIP_WEIGHTS.reduce((sum, weight, index) => sum + weight * Number(nip[index]), 0) % 11;
  return checksum !== 10 && checksum === Number(nip[9]) ? nip : null;
}

async function getInitialSyncDays(tenantId) {
  const { rows: [setting] } = await db.query(
    'SELECT value FROM app_settings WHERE tenant_id = $1 AND key = $2', [tenantId, INITIAL_SYNC_DAYS_KEY],
  );
  const days = Number.parseInt(setting?.value, 10);
  const isUsable = Number.isInteger(days) && days >= MIN_INITIAL_SYNC_DAYS && days <= MAX_INITIAL_SYNC_DAYS;
  return isUsable ? days : DEFAULT_INITIAL_SYNC_DAYS;
}

async function setInitialSyncDays(tenantId, days, userId) {
  await db.query(
    `INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category, updated_by, updated_at)
     VALUES ($1, $2, $3, 'KSeF: zakres pierwszej synchronizacji (dni)',
             'Ile dni wstecz sięga pierwsza synchronizacja faktur z KSeF', 'number', 'projects', $4, now())
     ON CONFLICT (tenant_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, INITIAL_SYNC_DAYS_KEY, String(days), userId || null],
  );
}

async function listCompanies(tenantId) {
  const { rows } = await db.query(
    `SELECT ${COMPANY_COLUMNS} FROM ksef_companies WHERE tenant_id = $1 ORDER BY created_at, nip`,
    [tenantId],
  );
  return rows;
}

async function getConfig(tenantId) {
  return {
    is_configured: ksefApiClient.isConfigured(),
    environment: ksefApiClient.getEnvironment(),
    initial_sync_days: await getInitialSyncDays(tenantId),
    invoice_documents_group: await invoiceDocumentService.getInvoiceGroup(tenantId),
    companies: await listCompanies(tenantId),
  };
}

function cleanToken(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) throw httpError(400, 'The KSeF token is required');
  return token;
}

// Proves the token works for the NIP by logging in to KSeF with it.
async function assertTokenAccepted(nip, token) {
  if (!ksefApiClient.isConfigured()) throw httpError(400, 'KSeF integration is not configured');
  try {
    await ksefApiClient.authenticate(nip, token);
  } catch (err) {
    if (err instanceof ksefApiClient.KsefTokenRejectedError) {
      throw httpError(400, 'KSeF rejected the token for this NIP');
    }
    if (err instanceof ksefApiClient.KsefApiError) {
      throw httpError(502, 'KSeF could not be reached to verify the token; try again later');
    }
    throw err;
  }
}

async function addCompany({ tenantId, userId, nip: rawNip, token: rawToken, name }) {
  const nip = normalizeNip(rawNip);
  if (!nip) throw httpError(400, 'Invalid NIP');
  const token = cleanToken(rawToken);

  const { rows: existing } = await db.query(
    'SELECT 1 FROM ksef_companies WHERE tenant_id = $1 AND nip = $2', [tenantId, nip],
  );
  if (existing.length) throw httpError(409, 'A company with this NIP is already configured');

  await assertTokenAccepted(nip, token);
  const initialSyncDays = await getInitialSyncDays(tenantId);
  try {
    const { rows: [company] } = await db.query(
      `INSERT INTO ksef_companies (tenant_id, nip, name, token_encrypted, token_hint, sync_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COMPANY_COLUMNS}`,
      [tenantId, nip, name?.trim() || null, encrypt(token), token.slice(-TOKEN_HINT_LENGTH),
       new Date(Date.now() - initialSyncDays * DAY_MS), userId],
    );
    return company;
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'A company with this NIP is already configured');
    throw err;
  }
}

// `changes`: token and / or name. A new token is verified first and puts the
// company back into the periodic sync; the cursor is kept.
async function updateCompany({ tenantId, companyId, changes }) {
  const { rows: [company] } = await db.query(
    'SELECT id, nip, name FROM ksef_companies WHERE id = $1 AND tenant_id = $2', [companyId, tenantId],
  );
  if (!company) throw httpError(404, 'Company not found');

  if (changes.name !== undefined) {
    await db.query(
      'UPDATE ksef_companies SET name = $1, updated_at = now() WHERE id = $2',
      [changes.name?.trim() || null, companyId],
    );
  }
  if (changes.token !== undefined) {
    const token = cleanToken(changes.token);
    await assertTokenAccepted(company.nip, token);
    await db.query(
      `UPDATE ksef_companies
       SET token_encrypted = $1, token_hint = $2, status = 'active', last_error = NULL, updated_at = now()
       WHERE id = $3`,
      [encrypt(token), token.slice(-TOKEN_HINT_LENGTH), companyId],
    );
  }
  const { rows: [updated] } = await db.query(
    `SELECT ${COMPANY_COLUMNS} FROM ksef_companies WHERE id = $1`, [companyId],
  );
  return updated;
}

// Invoices already synced for the company stay (their company_id is nulled).
async function removeCompany({ tenantId, companyId }) {
  const { rows: [removed] } = await db.query(
    'DELETE FROM ksef_companies WHERE id = $1 AND tenant_id = $2 RETURNING id, nip, name',
    [companyId, tenantId],
  );
  if (!removed) throw httpError(404, 'Company not found');
  return removed;
}

module.exports = {
  MIN_INITIAL_SYNC_DAYS,
  MAX_INITIAL_SYNC_DAYS,
  normalizeNip,
  getInitialSyncDays,
  setInitialSyncDays,
  getConfig,
  listCompanies,
  addCompany,
  updateCompany,
  removeCompany,
};
