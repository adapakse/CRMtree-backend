'use strict';
// services/invoiceDocumentService.js
//
// Invoices in the Documents module: a document with doc_type 'invoice'.
//
// Field mapping — existing document columns are reused where they fit:
//   signing_date     issue date
//   expiration_date  payment due date (the earliest one), so "expires soon"
//                    keeps working for it
//   entities         [buyer name, seller name] — own company first, the
//                    counterparty second, as on every other document
//   nip              seller tax ID
//   contract_subject not used, always NULL
// Invoice-only columns: invoice_number, net_amount, vat_amount, gross_amount,
// currency, bank_account, payment_status, ksef_invoice_id.
//
// payment_status is a value of the tenant dictionary 'doc_payment_statuses'
// and is set by hand. "Overdue" is also derived on read, without touching the
// stored status: is_payment_overdue = due date passed and status not 'paid'.
//
// An invoice document is entered by hand (normal document creation) or
// registered from a KSeF invoice — at most one live document per KSeF invoice.
// A registered document gets a generated PDF visualisation as its main file,
// the access group the tenant admin chose in the KSeF settings, the status
// 'completed' and no workflow tasks: there is nothing to approve or sign.
//
// Project cost items may point at an invoice document (see
// projectFinanceService); the document shows those links to everyone who can
// read it, whether or not they belong to the project.

const db = require('../config/database');
const logger = require('../utils/logger');
const audit = require('./auditService');
const perms = require('./permissionService');
const storage = require('./storageService');
const projectConfigService = require('./projectConfigService');
const invoiceVisualisationPdfService = require('./invoiceVisualisationPdfService');

const INVOICE_DOC_TYPE         = 'invoice';
const PAYMENT_STATUSES_KEY     = 'doc_payment_statuses';
const DEFAULT_PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid', 'overdue'];
const UNPAID_STATUS            = 'unpaid';
const PARTIALLY_PAID_STATUS    = 'partially_paid';
const PAID_STATUS              = 'paid';
const INVOICE_GROUP_KEY        = 'ksef_invoice_documents_group_id';
const REGISTERED_STATUS        = 'completed';
const DEFAULT_CURRENCY         = 'PLN';
const ISO_CURRENCIES           = new Set(Intl.supportedValuesOf('currency'));
const INVOICE_FIELDS = [
  'invoice_number', 'net_amount', 'vat_amount', 'gross_amount', 'currency', 'bank_account', 'payment_status',
];
const MAX_NAME_LENGTH        = 500;
const MAX_TAX_ID_LENGTH      = 15;
const UNIQUE_VIOLATION       = '23505';
const PDF_MIME_TYPE          = 'application/pdf';
const VISUALISATION_LABEL    = 'KSeF data visualisation';
const UNSAFE_FILE_NAME_CHARS = /[^\w.-]+/g;
const GROUP_NOT_CONFIGURED =
  'No access group for invoice documents is configured; the tenant admin chooses it in the KSeF settings';

// For queries that alias documents as `d`. NUMERIC comes back from pg as text,
// hence the casts.
const INVOICE_RESPONSE_COLUMNS = `
  d.net_amount::float AS net_amount, d.vat_amount::float AS vat_amount, d.gross_amount::float AS gross_amount,
  COALESCE(d.doc_type = '${INVOICE_DOC_TYPE}' AND d.expiration_date < CURRENT_DATE
           AND d.payment_status IS DISTINCT FROM '${PAID_STATUS}', FALSE) AS is_payment_overdue`;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isBlank = (value) => value === null || value === undefined || value === '';

// ── Payment status dictionary ───────────────────────────────────────────

async function listPaymentStatuses(tenantId) {
  const { rows: [setting] } = await db.query(
    'SELECT value FROM app_settings WHERE tenant_id = $1 AND key = $2', [tenantId, PAYMENT_STATUSES_KEY],
  );
  try {
    const statuses = JSON.parse(setting?.value);
    if (Array.isArray(statuses)) return statuses.filter((status) => typeof status === 'string' && status);
  } catch {
    // No row or an unreadable value: the tenant uses the built-in statuses.
  }
  return DEFAULT_PAYMENT_STATUSES;
}

// ── Field rules for creating and updating a document ────────────────────

// Returns the invoice-related columns to write, given the document type the
// request results in. `input` is the request body, `current` the stored
// document (null on create). Documents of other types never carry invoice
// fields; an invoice never carries a contract subject.
async function resolveInvoiceFields({ tenantId, docType, input, current }) {
  const wasInvoice = current?.doc_type === INVOICE_DOC_TYPE;
  if (docType !== INVOICE_DOC_TYPE) {
    if (INVOICE_FIELDS.some((field) => !isBlank(input[field]))) {
      throw httpError(400, 'Invoice fields can be set only on documents of type invoice');
    }
    return wasInvoice ? Object.fromEntries(INVOICE_FIELDS.map((field) => [field, null])) : {};
  }

  const fields = {};
  for (const field of INVOICE_FIELDS) {
    if (input[field] !== undefined) fields[field] = isBlank(input[field]) ? null : input[field];
  }
  if (fields.currency && !ISO_CURRENCIES.has(fields.currency)) throw httpError(400, 'Unknown currency code');
  const paymentStatuses = await listPaymentStatuses(tenantId);
  if (fields.payment_status && !paymentStatuses.includes(fields.payment_status)) {
    throw httpError(400, 'Unknown payment status');
  }

  if (!wasInvoice) {
    if (isBlank(fields.currency)) fields.currency = DEFAULT_CURRENCY;
    if (isBlank(fields.payment_status)) {
      fields.payment_status = paymentStatuses.includes(UNPAID_STATUS) ? UNPAID_STATUS : null;
    }
  }
  if (!wasInvoice || input.contract_subject !== undefined) fields.contract_subject = null;
  return fields;
}

async function hasCostLinks(documentId) {
  const { rows } = await db.query('SELECT 1 FROM project_cost_items WHERE document_id = $1 LIMIT 1', [documentId]);
  return rows.length > 0;
}

// An invoice that came from KSeF or is used by project costs must stay an invoice.
async function assertTypeChangeAllowed(document, nextDocType) {
  if (document.doc_type !== INVOICE_DOC_TYPE || nextDocType === INVOICE_DOC_TYPE) return;
  if (document.ksef_invoice_id || await hasCostLinks(document.id)) {
    throw httpError(409, 'An invoice registered from KSeF or linked to project costs cannot change its type');
  }
}

// A deleted document is no longer the invoice of any cost item.
async function detachFromCostItems(documentId) {
  await db.query(
    `UPDATE project_cost_items
     SET document_id = NULL, document_linked_by = NULL, document_linked_at = NULL, updated_at = now()
     WHERE document_id = $1`,
    [documentId],
  );
}

// ── Access group for documents registered from KSeF ─────────────────────

// null while the admin has not chosen a group, or the chosen one is gone or inactive.
async function getInvoiceGroup(tenantId) {
  const { rows: [group] } = await db.query(
    `SELECT gp.id, gp.name, gp.display_name
     FROM app_settings s
     JOIN group_profiles gp ON gp.id::text = s.value AND gp.tenant_id = s.tenant_id AND gp.is_active
     WHERE s.tenant_id = $1 AND s.key = $2`,
    [tenantId, INVOICE_GROUP_KEY],
  );
  return group || null;
}

async function setInvoiceGroup(tenantId, groupId, userId) {
  if (!groupId) {
    await db.query('DELETE FROM app_settings WHERE tenant_id = $1 AND key = $2', [tenantId, INVOICE_GROUP_KEY]);
    return;
  }
  const { rows } = await db.query(
    'SELECT 1 FROM group_profiles WHERE id = $1 AND tenant_id = $2 AND is_active', [groupId, tenantId],
  );
  if (!rows.length) throw httpError(400, 'Unknown or inactive group');
  await db.query(
    `INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category, updated_by, updated_at)
     VALUES ($1, $2, $3, 'KSeF: grupa dokumentów faktur',
             'Grupa dostępu, do której trafiają dokumenty faktur rejestrowane z KSeF', 'string', 'projects', $4, now())
     ON CONFLICT (tenant_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, INVOICE_GROUP_KEY, groupId, userId || null],
  );
}

// ── Registering a KSeF invoice as a document ────────────────────────────

async function findRegisteredDocument(tenantId, ksefInvoiceId) {
  const { rows: [document] } = await db.query(
    `SELECT d.id, d.doc_number, d.name, d.invoice_number, d.group_id, d.owner_id
     FROM documents d
     WHERE d.tenant_id = $1 AND d.ksef_invoice_id = $2 AND d.deleted_at IS NULL`,
    [tenantId, ksefInvoiceId],
  );
  return document || null;
}

async function loadKsefInvoice(tenantId, invoiceId) {
  const { rows: [invoice] } = await db.query(
    `SELECT i.id, i.ksef_number, i.invoice_number, i.issue_date, i.sale_date,
            i.seller_nip, i.seller_name, i.seller_address, i.buyer_nip, i.buyer_name, i.buyer_address,
            i.net_amount::float AS net_amount, i.vat_amount::float AS vat_amount,
            i.gross_amount::float AS gross_amount, i.currency, i.payment_due_date, i.bank_account,
            i.is_paid, i.payment_date, i.amount_due::float AS amount_due, i.payment, i.lines,
            t.default_locale AS tenant_default_locale
     FROM ksef_invoices i
     JOIN tenants t ON t.id = i.tenant_id
     WHERE i.id = $1 AND i.tenant_id = $2`,
    [invoiceId, tenantId],
  );
  return invoice || null;
}

function initialPaymentStatus(invoice) {
  if (invoice.is_paid) return PAID_STATUS;
  return invoice.payment?.is_partially_paid ? PARTIALLY_PAID_STATUS : UNPAID_STATUS;
}

function documentNameOf(invoice) {
  const name = [invoice.invoice_number || invoice.ksef_number, invoice.seller_name].filter(Boolean).join(' — ');
  return name.slice(0, MAX_NAME_LENGTH);
}

async function createRegisteredDocument({ tenantId, user, invoice, group, pdf, auditContext }) {
  return db.transaction(async (client) => {
    const { rows: [document] } = await client.query(
      `INSERT INTO documents
         (tenant_id, name, doc_type, gdpr_type, status, group_id, owner_id, created_by, entities, nip,
          signing_date, expiration_date, invoice_number, net_amount, vat_amount, gross_amount, currency,
          bank_account, payment_status, ksef_invoice_id)
       VALUES ($1, $2, $3, 'no_gdpr', $4::doc_status, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id, doc_number, name, invoice_number, group_id, owner_id`,
      [tenantId, documentNameOf(invoice), INVOICE_DOC_TYPE, REGISTERED_STATUS, group.id, user.id,
       [invoice.buyer_name, invoice.seller_name].filter(Boolean),
       invoice.seller_nip?.slice(0, MAX_TAX_ID_LENGTH) || null,
       invoice.issue_date, invoice.payment_due_date, invoice.invoice_number,
       invoice.net_amount, invoice.vat_amount, invoice.gross_amount, invoice.currency,
       invoice.bank_account, initialPaymentStatus(invoice), invoice.id],
    );

    const fileName = `${(invoice.invoice_number || invoice.ksef_number).replace(UNSAFE_FILE_NAME_CHARS, '_')}.pdf`;
    const blob = await storage.uploadDocument(pdf, fileName, PDF_MIME_TYPE, document.id, 1);
    await client.query(
      'UPDATE documents SET blob_path = $1, blob_name = $2, blob_size_bytes = $3, mime_type = $4 WHERE id = $5',
      [blob.blobPath, blob.blobName, blob.blobSizeBytes, PDF_MIME_TYPE, document.id],
    );
    await client.query(
      `INSERT INTO document_versions
         (document_id, version_number, label, blob_path, blob_name, blob_size_bytes, mime_type, created_by, tenant_id)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
      [document.id, VISUALISATION_LABEL, blob.blobPath, blob.blobName, blob.blobSizeBytes, PDF_MIME_TYPE,
       user.id, tenantId],
    );
    // Cost items linked to the invoice before it had a document now point at it.
    await client.query(
      `UPDATE project_cost_items
       SET document_id = $1, document_linked_by = ksef_linked_by, document_linked_at = ksef_linked_at
       WHERE ksef_invoice_id = $2 AND tenant_id = $3 AND document_id IS NULL`,
      [document.id, invoice.id, tenantId],
    );
    await audit.log({
      user,
      document,
      action: 'document_created',
      afterState: { name: document.name, doc_type: INVOICE_DOC_TYPE, group_id: group.id, owner_id: user.id },
      metadata: { source: 'ksef', ksef_invoice_id: invoice.id },
      ipAddress: auditContext?.ipAddress,
      userAgent: auditContext?.userAgent,
      client,
    });
    return document;
  });
}

// Returns { document, isNew }, or null while the tenant has no access group for
// invoice documents. Registering an invoice again returns its existing document.
async function registerKsefInvoice({ tenantId, user, invoiceId, auditContext }) {
  const invoice = await loadKsefInvoice(tenantId, invoiceId);
  if (!invoice) throw httpError(404, 'Invoice not found');
  const existing = await findRegisteredDocument(tenantId, invoiceId);
  if (existing) return { document: existing, isNew: false };
  const group = await getInvoiceGroup(tenantId);
  if (!group) return null;

  const pdf = await invoiceVisualisationPdfService.generateInvoiceVisualisationPdf(
    invoice, invoice.tenant_default_locale,
  );
  try {
    const document = await createRegisteredDocument({ tenantId, user, invoice, group, pdf, auditContext });
    return { document, isNew: true };
  } catch (err) {
    // Two registrations of the same invoice at once: the other one won.
    if (err.code !== UNIQUE_VIOLATION) throw err;
    return { document: await findRegisteredDocument(tenantId, invoiceId), isNew: false };
  }
}

// Registration as a side effect of linking the invoice to a cost item. The
// link must succeed whatever happens here, so the answer is the document id or
// null (no group chosen yet, or the document could not be created).
async function registerKsefInvoiceOnLink({ tenantId, user, invoiceId }) {
  try {
    const registration = await registerKsefInvoice({ tenantId, user, invoiceId });
    return registration?.document.id || null;
  } catch (err) {
    logger.error('[invoice-documents] Automatic registration of a KSeF invoice failed', {
      tenantId, invoiceId, error: err.message,
    });
    return null;
  }
}

// ── Invoice documents seen from project finance ─────────────────────────

// The invoice document a cost item may be linked to; null when the id is not
// a live invoice document of the tenant.
async function findInvoiceDocument({ tenantId, documentId }) {
  const { rows: [document] } = await db.query(
    `SELECT d.id, d.doc_number, d.name, d.invoice_number, d.group_id, d.owner_id, d.ksef_invoice_id,
            d.signing_date, d.net_amount::float AS net_amount, d.currency, d.entities
     FROM documents d
     WHERE d.id = $1 AND d.tenant_id = $2 AND d.doc_type = $3 AND d.deleted_at IS NULL`,
    [documentId, tenantId, INVOICE_DOC_TYPE],
  );
  return document || null;
}

// Which of the documents the user may open in the Documents module.
async function findReadableDocumentIds(user, documentIds) {
  if (!documentIds.length) return new Set();
  const visibility = await perms.buildVisibilityFilter(user.id, 3);
  const { rows } = await db.query(
    `SELECT d.id FROM documents d
     WHERE d.id = ANY($1::uuid[]) AND d.tenant_id = $2 AND d.deleted_at IS NULL AND ${visibility.sql}`,
    [documentIds, user.tenant_id, ...visibility.params],
  );
  return new Set(rows.map((row) => row.id));
}

async function canOpenDocument(user, documentId) {
  return (await findReadableDocumentIds(user, [documentId])).has(documentId);
}

// Map of document id → { id, doc_number, name, invoice_number, can_open }.
async function loadDocumentSummaries({ user, documentIds }) {
  if (!documentIds.length) return new Map();
  const [{ rows }, readableIds] = await Promise.all([
    db.query(
      `SELECT d.id, d.doc_number, d.name, d.invoice_number
       FROM documents d
       WHERE d.id = ANY($1::uuid[]) AND d.tenant_id = $2 AND d.deleted_at IS NULL`,
      [documentIds, user.tenant_id],
    ),
    findReadableDocumentIds(user, documentIds),
  ]);
  return new Map(rows.map((document) => [document.id, { ...document, can_open: readableIds.has(document.id) }]));
}

// ── Project links shown on the document ─────────────────────────────────

// Every cost item linked to the document. Names and amounts are shown to
// whoever reads the document; can_open says whether this viewer may enter the
// project. Empty for other document types and while project finance is off.
async function listProjectLinks({ tenantId, user, document }) {
  if (document.doc_type !== INVOICE_DOC_TYPE) return [];
  if (!await projectConfigService.isFinanceEnabled(tenantId)) return [];
  const { rows } = await db.query(
    `SELECT c.id AS cost_item_id, c.project_id, p.key AS project_key, p.name AS project_name,
            c.task_id, t.task_number, t.name AS task_name,
            c.amount::float AS amount, COALESCE(f.currency, $2) AS currency, c.status,
            COALESCE(c.document_linked_by, c.ksef_linked_by) AS linked_by, linker.display_name AS linked_by_name,
            COALESCE(c.document_linked_at, c.ksef_linked_at) AS linked_at,
            ($3::boolean OR member.user_id IS NOT NULL) AS can_open
     FROM project_cost_items c
     JOIN projects p ON p.id = c.project_id
     LEFT JOIN project_finance f ON f.project_id = c.project_id
     LEFT JOIN project_tasks t ON t.id = c.task_id
     LEFT JOIN users linker ON linker.id = COALESCE(c.document_linked_by, c.ksef_linked_by)
     LEFT JOIN project_members member ON member.project_id = c.project_id AND member.user_id = $4
     WHERE c.document_id = $1 AND c.tenant_id = $5
     ORDER BY COALESCE(c.document_linked_at, c.ksef_linked_at), c.created_at`,
    [document.id, DEFAULT_CURRENCY, Boolean(user.is_admin), user.id, tenantId],
  );
  return rows;
}

module.exports = {
  GROUP_NOT_CONFIGURED,
  INVOICE_DOC_TYPE,
  INVOICE_FIELDS,
  INVOICE_RESPONSE_COLUMNS,
  PAYMENT_STATUSES_KEY,
  DEFAULT_PAYMENT_STATUSES,
  listPaymentStatuses,
  resolveInvoiceFields,
  assertTypeChangeAllowed,
  detachFromCostItems,
  getInvoiceGroup,
  setInvoiceGroup,
  registerKsefInvoice,
  registerKsefInvoiceOnLink,
  findInvoiceDocument,
  canOpenDocument,
  loadDocumentSummaries,
  listProjectLinks,
};
