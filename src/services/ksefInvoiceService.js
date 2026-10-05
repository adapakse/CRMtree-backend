'use strict';
// services/ksefInvoiceService.js
//
// Reading the local copy of KSeF purchase invoices, and what is known about
// the links between invoices and project cost items.
//
// A cost item is linked to an invoice through ksef_invoice_id (a KSeF invoice)
// and / or document_id (an invoice document — the one registered from the KSeF
// invoice, or one entered by hand). One invoice may be linked any number of
// times — to several tasks and projects, even twice to the same one — and
// linking is never blocked. Instead every answer says where else the invoice
// is used (other_links: every other cost item sharing the KSeF invoice or the
// document) and, for a KSeF invoice, whether the links add up to more than it:
//
//   linked_total      — the sum of all links in the INVOICE currency. A link in
//                       a project of the same currency counts with its amount.
//                       A link in another currency counts with its
//                       original_amount when that was entered in the invoice
//                       currency, otherwise its amount is converted with the
//                       NBP rate for the invoice issue date (the rate the
//                       default link amount is calculated with). null when a
//                       needed rate is not available.
//   is_over_allocated — linked_total exceeds the invoice net amount (null when
//                       either is unknown). Planned and incurred links both count.

const db = require('../config/database');
const exchangeRateService = require('./exchangeRateService');
const invoiceDocumentService = require('./invoiceDocumentService');
const { roundMoney } = require('./projectFinanceCalculations');

const DEFAULT_PERIOD_DAYS = 30;
const DEFAULT_PAGE_SIZE   = 50;
const PROJECT_DEFAULT_CURRENCY = 'PLN';
// Sums of two-decimal amounts carry float noise well below one grosz.
const MONEY_EPSILON = 0.005;

const SUMMARY_COLUMNS = `
  i.id, i.invoice_number, i.ksef_number, i.issue_date, i.seller_name, i.seller_nip, i.buyer_nip,
  i.net_amount::float AS net_amount, i.vat_amount::float AS vat_amount,
  i.gross_amount::float AS gross_amount, i.currency, i.payment_due_date,
  (SELECT d.id FROM documents d
    WHERE d.ksef_invoice_id = i.id AND d.tenant_id = i.tenant_id AND d.deleted_at IS NULL) AS document_id`;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// ── List and detail ─────────────────────────────────────────────────────

// `filters`: date_from, date_to (issue date, inclusive), seller (name or NIP),
// invoice_number, buyer_nip, net_min, net_max, gross_min, gross_max, page, page_size.
async function listInvoices({ tenantId, filters }) {
  const today = new Date();
  const dateTo = filters.date_to || isoDate(today);
  const dateFrom = filters.date_from
    || isoDate(new Date(Date.parse(`${dateTo}T00:00:00Z`) - DEFAULT_PERIOD_DAYS * 86_400_000));
  const page = filters.page || 1;
  const pageSize = filters.page_size || DEFAULT_PAGE_SIZE;

  const params = [tenantId, dateFrom, dateTo];
  const conditions = ['i.tenant_id = $1', 'i.issue_date >= $2', 'i.issue_date <= $3'];
  const addCondition = (value, buildSql) => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    conditions.push(buildSql(`$${params.length}`));
  };
  addCondition(filters.seller && `%${escapeLike(filters.seller)}%`,
    (placeholder) => `(i.seller_name ILIKE ${placeholder} OR i.seller_nip ILIKE ${placeholder})`);
  addCondition(filters.invoice_number && `%${escapeLike(filters.invoice_number)}%`,
    (placeholder) => `i.invoice_number ILIKE ${placeholder}`);
  addCondition(filters.buyer_nip, (placeholder) => `i.buyer_nip = ${placeholder}`);
  addCondition(filters.net_min, (placeholder) => `i.net_amount >= ${placeholder}`);
  addCondition(filters.net_max, (placeholder) => `i.net_amount <= ${placeholder}`);
  addCondition(filters.gross_min, (placeholder) => `i.gross_amount >= ${placeholder}`);
  addCondition(filters.gross_max, (placeholder) => `i.gross_amount <= ${placeholder}`);
  const where = conditions.join(' AND ');

  const { rows: [count] } = await db.query(
    `SELECT COUNT(*)::int AS total FROM ksef_invoices i WHERE ${where}`, params,
  );
  const { rows: items } = await db.query(
    `SELECT ${SUMMARY_COLUMNS},
            (SELECT COUNT(*)::int FROM project_cost_items c WHERE c.ksef_invoice_id = i.id) AS links_count
     FROM ksef_invoices i
     WHERE ${where}
     ORDER BY i.issue_date DESC, i.created_at DESC, i.id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    items,
    total: count.total,
    page,
    page_size: pageSize,
    date_from: dateFrom,
    date_to: dateTo,
    is_document_group_configured: Boolean(await invoiceDocumentService.getInvoiceGroup(tenantId)),
  };
}

// The few invoice fields needed to create a cost item from it; null when the
// invoice does not belong to the tenant.
async function findInvoiceSummary({ tenantId, invoiceId }) {
  const { rows: [invoice] } = await db.query(
    `SELECT ${SUMMARY_COLUMNS} FROM ksef_invoices i WHERE i.id = $1 AND i.tenant_id = $2`,
    [invoiceId, tenantId],
  );
  return invoice || null;
}

// ── Links ───────────────────────────────────────────────────────────────

// Every cost item linked to one of the KSeF invoices or one of the invoice documents.
async function loadLinks({ invoiceIds, documentIds = [] }) {
  if (!invoiceIds.length && !documentIds.length) return [];
  const { rows } = await db.query(
    `SELECT c.id AS cost_item_id, c.ksef_invoice_id, c.document_id,
            c.project_id, p.key AS project_key, p.name AS project_name,
            c.task_id, t.task_number, t.name AS task_name,
            c.amount::float AS amount, COALESCE(f.currency, $3) AS currency, c.status,
            c.original_amount::float AS original_amount, c.original_currency,
            COALESCE(c.ksef_linked_by, c.document_linked_by) AS linked_by, linker.display_name AS linked_by_name,
            COALESCE(c.ksef_linked_at, c.document_linked_at) AS linked_at
     FROM project_cost_items c
     JOIN projects p ON p.id = c.project_id
     LEFT JOIN project_finance f ON f.project_id = c.project_id
     LEFT JOIN project_tasks t ON t.id = c.task_id
     LEFT JOIN users linker ON linker.id = COALESCE(c.ksef_linked_by, c.document_linked_by)
     WHERE c.ksef_invoice_id = ANY($1::uuid[]) OR c.document_id = ANY($2::uuid[])
     ORDER BY COALESCE(c.ksef_linked_at, c.document_linked_at), c.created_at`,
    [invoiceIds, documentIds, PROJECT_DEFAULT_CURRENCY],
  );
  return rows;
}

// A link's amount expressed in the invoice currency (see the file header), or
// null when the NBP rate it needs is not available.
async function linkAmountInInvoiceCurrency(link, invoice, rateCache) {
  if (link.currency === invoice.currency) return link.amount;
  if (link.original_currency === invoice.currency && link.original_amount !== null) return link.original_amount;
  if (!rateCache.has(link.currency)) {
    rateCache.set(link.currency, exchangeRateService
      .getCrossRate(link.currency, invoice.currency, invoice.issue_date)
      .then(({ rate }) => rate)
      .catch(() => null));
  }
  const rate = await rateCache.get(link.currency);
  return rate === null ? null : link.amount * rate;
}

async function summarizeAllocation(invoice, links) {
  const rateCache = new Map();
  let linkedTotal = 0;
  for (const link of links) {
    const amount = await linkAmountInInvoiceCurrency(link, invoice, rateCache);
    if (amount === null) return { linked_total: null, is_over_allocated: null };
    linkedTotal += amount;
  }
  linkedTotal = roundMoney(linkedTotal);
  return {
    linked_total: linkedTotal,
    is_over_allocated: invoice.net_amount === null ? null : linkedTotal > invoice.net_amount + MONEY_EPSILON,
  };
}

function toPublicLink(link) {
  return {
    cost_item_id: link.cost_item_id,
    project_id: link.project_id,
    project_key: link.project_key,
    project_name: link.project_name,
    task_id: link.task_id,
    task_number: link.task_number,
    task_name: link.task_name,
    amount: link.amount,
    currency: link.currency,
    status: link.status,
    linked_by: link.linked_by,
    linked_by_name: link.linked_by_name,
    linked_at: link.linked_at,
  };
}

// Everything parsed from the invoice plus its links; null when not found.
async function getInvoice({ tenantId, invoiceId }) {
  const { rows: [invoice] } = await db.query(
    `SELECT ${SUMMARY_COLUMNS}, i.company_id, i.invoice_type, i.sale_date, i.seller_address,
            i.buyer_name, i.buyer_address, i.bank_account, i.is_paid, i.payment_date,
            i.amount_due::float AS amount_due, i.payment, i.lines, i.permanent_storage_date,
            i.created_at, (i.raw_xml IS NOT NULL) AS has_xml
     FROM ksef_invoices i WHERE i.id = $1 AND i.tenant_id = $2`,
    [invoiceId, tenantId],
  );
  if (!invoice) return null;
  const links = await loadLinks({ invoiceIds: [invoice.id] });
  return {
    ...invoice,
    is_document_group_configured: Boolean(await invoiceDocumentService.getInvoiceGroup(tenantId)),
    links_count: links.length,
    ...await summarizeAllocation(invoice, links),
    links: links.map(toPublicLink),
  };
}

// Adds to cost items: `ksef_invoice` (summary with links_count, linked_total
// and is_over_allocated), `document` (the linked invoice document; can_open
// says whether `user` may open it in Documents) and `other_links` (every
// OTHER cost item linked to the same KSeF invoice or the same document, each
// once). With `canSeeInvoices` false the caller gets none of them — used for
// a participant who only sees own cost items.
async function attachInvoiceInfo(costItems, { canSeeInvoices, user }) {
  const distinctIds = (field) => (
    canSeeInvoices ? [...new Set(costItems.map((item) => item[field]).filter(Boolean))] : []
  );
  const invoiceIds = distinctIds('ksef_invoice_id');
  const documentIds = distinctIds('document_id');
  if (!invoiceIds.length && !documentIds.length) {
    return costItems.map((item) => ({ ...item, ksef_invoice: null, document: null, other_links: [] }));
  }

  const [{ rows: invoices }, links, documentById] = await Promise.all([
    db.query(`SELECT ${SUMMARY_COLUMNS} FROM ksef_invoices i WHERE i.id = ANY($1::uuid[])`, [invoiceIds]),
    loadLinks({ invoiceIds, documentIds }),
    invoiceDocumentService.loadDocumentSummaries({ user, documentIds }),
  ]);
  const invoiceById = new Map();
  for (const invoice of invoices) {
    const invoiceLinks = links.filter((link) => link.ksef_invoice_id === invoice.id);
    invoiceById.set(invoice.id, {
      ...invoice, links_count: invoiceLinks.length, ...await summarizeAllocation(invoice, invoiceLinks),
    });
  }

  const sharesInvoiceWith = (item) => (link) => link.cost_item_id !== item.id && Boolean(
    (item.ksef_invoice_id && link.ksef_invoice_id === item.ksef_invoice_id)
    || (item.document_id && link.document_id === item.document_id),
  );
  return costItems.map((item) => ({
    ...item,
    ksef_invoice: invoiceById.get(item.ksef_invoice_id) || null,
    document: documentById.get(item.document_id) || null,
    other_links: links.filter(sharesInvoiceWith(item)).map(toPublicLink),
  }));
}

module.exports = {
  listInvoices,
  findInvoiceSummary,
  getInvoice,
  attachInvoiceInfo,
};
