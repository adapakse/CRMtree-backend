'use strict';
// services/ksefSyncService.js
//
// Copies purchase invoices from KSeF into ksef_invoices, company by company.
//
// How a run works:
//   - The export filter is the KSeF permanent-storage date (not the issue
//     date), so invoices that reach KSeF late are still picked up.
//   - ksef_companies.sync_from is the cursor. A window is at most 90 days; the
//     last one is open-ended and ends at KSeF's high-water mark. The cursor is
//     stored after every window and only ever moves forward.
//   - Neighbouring windows overlap at the edge and runs may repeat, so rows are
//     inserted with ON CONFLICT DO NOTHING.
//   - One sync per company at a time, across processes: a Postgres advisory
//     lock held on a dedicated connection for the whole run.
//   - Correction invoices are skipped in this version.
//
// Company status after a run: active; invalid when KSeF rejected the token (no
// more periodic runs until the admin replaces it); error for anything else
// (retried by the next run). One failing company never stops the others.

const db = require('../config/database');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/encrypt');
const ksefApiClient = require('./ksefApiClient');
const { openExportPackage } = require('./ksefPackage');
const { parseInvoiceXml } = require('./ksefInvoiceParser');
const projectConfigService = require('./projectConfigService');

const DAY_MS = 86_400_000;
// KSeF allows 100 days per export.
const MAX_WINDOW_DAYS = 90;
// KSeF allows 20 exports per hour per NIP; the job runs every 30 minutes.
const MAX_EXPORTS_PER_RUN = 6;
// An export (polling plus downloads) must fit into what is left of the access token.
const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000;
const BASE_CURRENCY = 'PLN';
const CORRECTION_TYPE_RE = /^kor/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ERROR_LENGTH = 500;

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function toAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? roundMoney(value) : null;
}

function toValidDate(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date : null;
}

// ── Windows and cursor ──────────────────────────────────────────────────

// `to` null = open-ended (up to KSeF's high-water mark).
function planWindow(from, now) {
  const isLongerThanOneWindow = now.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS;
  return { from, to: isLongerThanOneWindow ? new Date(from.getTime() + MAX_WINDOW_DAYS * DAY_MS) : null };
}

function hasContent(exportPackage) {
  return Boolean(exportPackage && Array.isArray(exportPackage.parts) && exportPackage.parts.length);
}

// Where the next export starts and whether this run is finished.
//   nothing in the window        → the window's end (or stay put when open-ended)
//   truncated                    → the last invoice KSeF managed to include
//   bounded, complete            → the window's end
//   open-ended, complete         → KSeF's high-water mark; the run is finished
function resolveNextCursor({ window, exportPackage }) {
  const isOpenEnded = window.to === null;
  if (!hasContent(exportPackage)) {
    return { cursor: window.to || window.from, isFinished: isOpenEnded };
  }
  if (exportPackage.isTruncated) {
    const lastStored = toValidDate(exportPackage.lastPermanentStorageDate);
    // Without a usable position the same export would repeat forever.
    return { cursor: lastStored || window.from, isFinished: !lastStored || lastStored <= window.from };
  }
  if (!isOpenEnded) return { cursor: window.to, isFinished: false };
  return { cursor: toValidDate(exportPackage.permanentStorageHwmDate) || window.from, isFinished: true };
}

// ── From a KSeF invoice to a row ────────────────────────────────────────

// The export metadata is the primary source; the XML adds what it lacks.
// Returns null when the invoice cannot be stored (no number or no issue date).
function buildInvoiceRow(metadata, xml) {
  const parsed = (xml && parseInvoiceXml(xml)) || null;
  const ksefNumber = metadata?.ksefNumber;
  const issueDate = DATE_RE.test(metadata?.issueDate || '') ? metadata.issueDate : parsed?.issue_date;
  if (!ksefNumber || !issueDate) return null;

  const currency = metadata.currency || parsed?.currency || BASE_CURRENCY;
  const netAmount = toAmount(metadata.netAmount) ?? parsed?.net_amount ?? null;
  const grossAmount = toAmount(metadata.grossAmount) ?? parsed?.gross_amount ?? null;
  // KSeF reports the VAT of a foreign-currency invoice in PLN while net and
  // gross stay in the invoice currency.
  const vatAmount = currency !== BASE_CURRENCY && netAmount !== null && grossAmount !== null
    ? roundMoney(grossAmount - netAmount)
    : toAmount(metadata.vatAmount) ?? parsed?.vat_amount ?? null;
  const payment = parsed?.payment || null;

  return {
    ksef_number: ksefNumber,
    invoice_number: metadata.invoiceNumber || parsed?.invoice_number || null,
    invoice_type: metadata.invoiceType || parsed?.invoice_type || null,
    issue_date: issueDate,
    sale_date: parsed?.sale_date || null,
    seller_nip: metadata.seller?.nip || parsed?.seller.nip || null,
    seller_name: metadata.seller?.name || parsed?.seller.name || null,
    seller_address: parsed?.seller.address || null,
    buyer_nip: metadata.buyer?.identifier?.value || parsed?.buyer.nip || null,
    buyer_name: metadata.buyer?.name || parsed?.buyer.name || null,
    buyer_address: parsed?.buyer.address || null,
    net_amount: netAmount,
    vat_amount: vatAmount,
    gross_amount: grossAmount,
    currency,
    payment_due_date: payment?.due_dates[0] || null,
    bank_account: payment?.bank_accounts[0]?.number || null,
    is_paid: payment?.is_paid ?? null,
    payment_date: payment?.payment_date || null,
    amount_due: parsed?.amount_due ?? null,
    payment: payment
      ? {
        due_dates: payment.due_dates,
        form: payment.form,
        bank_accounts: payment.bank_accounts,
        is_partially_paid: payment.is_partially_paid,
      }
      : null,
    lines: parsed?.lines || [],
    permanent_storage_date: toValidDate(metadata.permanentStorageDate),
    metadata,
    raw_xml: xml || null,
  };
}

const INVOICE_COLUMNS = [
  'ksef_number', 'invoice_number', 'invoice_type', 'issue_date', 'sale_date', 'seller_nip', 'seller_name',
  'seller_address', 'buyer_nip', 'buyer_name', 'buyer_address', 'net_amount', 'vat_amount', 'gross_amount',
  'currency', 'payment_due_date', 'bank_account', 'is_paid', 'payment_date', 'amount_due', 'payment',
  'lines', 'permanent_storage_date', 'metadata', 'raw_xml',
];
const JSON_COLUMNS = new Set(['payment', 'lines', 'metadata']);

async function insertInvoice(company, row) {
  const values = INVOICE_COLUMNS.map((column) => (
    JSON_COLUMNS.has(column) && row[column] !== null ? JSON.stringify(row[column]) : row[column]
  ));
  const placeholders = INVOICE_COLUMNS.map((column, index) => `$${index + 3}`);
  const { rowCount } = await db.query(
    `INSERT INTO ksef_invoices (tenant_id, company_id, ${INVOICE_COLUMNS.join(', ')})
     VALUES ($1, $2, ${placeholders.join(', ')})
     ON CONFLICT (tenant_id, ksef_number) DO NOTHING`,
    [company.tenant_id, company.id, ...values],
  );
  return rowCount;
}

async function storePackage(company, { invoices, xmlByKsefNumber }) {
  const counts = { inserted: 0, skippedCorrections: 0 };
  for (const metadata of invoices) {
    const xml = xmlByKsefNumber.get(metadata?.ksefNumber) || null;
    const row = buildInvoiceRow(metadata, xml);
    if (!row) {
      logger.warn('[ksef-sync] Invoice without a KSeF number or issue date skipped', { companyId: company.id });
      continue;
    }
    // "Kor" in the metadata, "KOR", "KOR_ZAL", "KOR_ROZ" in the XML.
    if (CORRECTION_TYPE_RE.test(row.invoice_type || '')) {
      counts.skippedCorrections += 1;
      continue;
    }
    counts.inserted += await insertInvoice(company, row);
  }
  return counts;
}

// ── One company ─────────────────────────────────────────────────────────

// Hands out an access token that will outlive the next export: reuses the
// current one, refreshes it when it is about to expire, and logs in again
// when the refresh is refused.
async function freshAccessToken(state, company) {
  const session = state.session;
  const timeLeft = session ? Date.parse(session.accessTokenValidUntil) - Date.now() : 0;
  if (session && timeLeft > ACCESS_TOKEN_MARGIN_MS) return session.accessToken;

  if (session?.refreshToken) {
    try {
      state.session = await ksefApiClient.refreshAccessToken(session.refreshToken);
      return state.session.accessToken;
    } catch (err) {
      logger.warn('[ksef-sync] Token refresh failed, authenticating again', { companyId: company.id, error: err.message });
    }
  }
  state.session = await ksefApiClient.authenticate(company.nip, state.ksefToken);
  return state.session.accessToken;
}

async function exportWindow(accessToken, window) {
  const started = await ksefApiClient.startPurchaseInvoiceExport(accessToken, window);
  const exportPackage = await ksefApiClient.waitForExport(accessToken, started.referenceNumber);
  if (!hasContent(exportPackage)) return { exportPackage, content: null };
  const content = await openExportPackage({
    exportPackage,
    key: started.key,
    initializationVector: started.initializationVector,
    downloadPart: ksefApiClient.downloadExportPart,
  });
  return { exportPackage, content };
}

async function moveCursor(companyId, cursor) {
  await db.query(
    'UPDATE ksef_companies SET sync_from = GREATEST(sync_from, $2) WHERE id = $1', [companyId, cursor],
  );
}

async function runWindows(company) {
  const ksefToken = decrypt(company.token_encrypted);
  if (!ksefToken) throw new Error('The stored KSeF token cannot be decrypted');
  const state = { session: null, ksefToken };
  const totals = { inserted: 0, skippedCorrections: 0, exports: 0 };

  let cursor = new Date(company.sync_from);
  for (let exportIndex = 0; exportIndex < MAX_EXPORTS_PER_RUN; exportIndex += 1) {
    const accessToken = await freshAccessToken(state, company);
    const window = planWindow(cursor, new Date());
    const { exportPackage, content } = await exportWindow(accessToken, window);
    totals.exports += 1;
    if (content) {
      const counts = await storePackage(company, content);
      totals.inserted += counts.inserted;
      totals.skippedCorrections += counts.skippedCorrections;
    }
    const next = resolveNextCursor({ window, exportPackage });
    if (next.cursor > cursor) {
      cursor = next.cursor;
      await moveCursor(company.id, cursor);
    }
    if (next.isFinished) break;
  }
  return totals;
}

async function recordOutcome(companyId, { status, lastError, isSynced }) {
  await db.query(
    `UPDATE ksef_companies
     SET status = $2, last_error = $3, last_attempt_at = now(),
         last_synced_at = CASE WHEN $4 THEN now() ELSE last_synced_at END, updated_at = now()
     WHERE id = $1`,
    [companyId, status, lastError, isSynced],
  );
}

async function syncLockedCompany(companyId) {
  // Read after the lock is taken: the cursor may have been moved by the run
  // that held the lock a moment ago.
  const { rows: [company] } = await db.query(
    'SELECT id, tenant_id, nip, token_encrypted, status, sync_from FROM ksef_companies WHERE id = $1',
    [companyId],
  );
  if (!company) return { status: 'not_found' };
  if (company.status === 'invalid') return { status: 'invalid' };

  try {
    const totals = await runWindows(company);
    await recordOutcome(companyId, { status: 'active', lastError: null, isSynced: true });
    return {
      status: 'synced',
      inserted: totals.inserted,
      skipped_corrections: totals.skippedCorrections,
      exports: totals.exports,
    };
  } catch (err) {
    const isTokenRejected = err instanceof ksefApiClient.KsefTokenRejectedError;
    const status = isTokenRejected ? 'invalid' : 'error';
    const lastError = String(err.message || err).slice(0, MAX_ERROR_LENGTH);
    await recordOutcome(companyId, { status, lastError, isSynced: false });
    logger.warn('[ksef-sync] Company sync failed', { companyId, status, error: lastError });
    return { status, error: lastError };
  }
}

// Syncs one company. Resolves with { status } — synced | already_running |
// invalid | error | not_found | not_configured — and never throws for a KSeF
// failure.
async function syncCompany(companyId) {
  if (!ksefApiClient.isConfigured()) return { status: 'not_configured' };
  const lockKey = `ksef-sync:${companyId}`;
  // A session-level advisory lock belongs to its connection, so the same
  // client must take and release it.
  const lockClient = await db.getClient();
  try {
    const { rows: [lock] } = await lockClient.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS is_acquired', [lockKey],
    );
    if (!lock.is_acquired) return { status: 'already_running' };
    try {
      return await syncLockedCompany(companyId);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
    }
  } finally {
    lockClient.release();
  }
}

async function syncCompanies(companyIds) {
  const results = [];
  for (const companyId of companyIds) {
    try {
      results.push({ company_id: companyId, ...await syncCompany(companyId) });
    } catch (err) {
      logger.error('[ksef-sync] Unexpected sync failure', { companyId, error: err.message });
      results.push({ company_id: companyId, status: 'error', error: err.message });
    }
  }
  return results;
}

// Syncs every company with a usable token, of tenants that still have the
// Projects module and project finance switched on. The periodic job calls it
// without arguments; "sync now" narrows it to one tenant or one company.
async function syncCompaniesOf({ tenantId = null, companyId = null } = {}) {
  if (!ksefApiClient.isConfigured()) return [];
  const { rows } = await db.query(
    `SELECT c.id
     FROM ksef_companies c
     JOIN tenants t ON t.id = c.tenant_id AND t.is_active AND t.deleted_at IS NULL
     JOIN app_settings s ON s.tenant_id = c.tenant_id AND s.key = $1 AND s.value = 'true'
     WHERE c.status <> 'invalid'
       AND ($2::uuid IS NULL OR c.tenant_id = $2)
       AND ($3::uuid IS NULL OR c.id = $3)
       AND NOT EXISTS (SELECT 1 FROM tenant_features f
                       WHERE f.tenant_id = c.tenant_id AND f.feature = 'projects' AND f.is_enabled = FALSE)
     ORDER BY c.last_attempt_at NULLS FIRST, c.created_at`,
    [projectConfigService.FINANCE_SETTING_KEY, tenantId, companyId],
  );
  return syncCompanies(rows.map((row) => row.id));
}

module.exports = {
  planWindow,
  resolveNextCursor,
  syncCompany,
  syncCompaniesOf,
};
