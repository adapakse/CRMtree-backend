'use strict';
// services/invoiceVisualisationPdfService.js
//
// A PDF that shows the data of a KSeF purchase invoice (a ksef_invoices row).
// It is a visualisation, not the invoice — the original is the structured XML
// in KSeF — and says so in a notice at the top of the first page.
//
// Two steps, so the texts can be checked without reading a PDF:
//   buildVisualisationContent — every label and value, in one language;
//   generateInvoiceVisualisationPdf — draws that content.
// Every invoice field is optional (see ksefInvoiceParser): a missing value is
// shown as a dash and a section without data is left out.

const { createPdfDocument } = require('../utils/pdfDocument');
const { translate, formatDateOnly, formatNumber, formatAmount } = require('../utils/i18n');

const MISSING = '—';
// FormaPlatnosci of the FA(3) schema.
const PAYMENT_FORM_KEYS = {
  1: 'cash', 2: 'card', 3: 'voucher', 4: 'cheque', 5: 'credit', 6: 'transfer', 7: 'mobile',
};
const NUMERIC_VAT_RATE_RE = /^\d+([.,]\d+)?$/;
const MAX_QUANTITY_DECIMALS = 6;

const COLOR = {
  text: '#111827',
  muted: '#4b5563',
  border: '#9ca3af',
  barBackground: '#e5e7eb',
  noticeBackground: '#fef3c7',
  noticeBorder: '#b45309',
  noticeText: '#92400e',
};

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function buildVisualisationContent(invoice, locale) {
  const t = (key, params) => translate(locale, `invoicePdf.${key}`, params);
  const text = (value) => (hasValue(value) ? String(value) : MISSING);
  const date = (value) => (hasValue(value) ? formatDateOnly(locale, value) : MISSING);
  const amount = (value) => (hasValue(value) ? formatAmount(locale, value) : MISSING);
  const money = (value) => (hasValue(value) ? `${formatAmount(locale, value)} ${invoice.currency || ''}`.trim() : MISSING);
  const quantity = (value) => (
    hasValue(value) ? formatNumber(locale, value, { maximumFractionDigits: MAX_QUANTITY_DECIMALS }) : MISSING
  );
  const vatRate = (value) => {
    if (!hasValue(value)) return MISSING;
    return NUMERIC_VAT_RATE_RE.test(value) ? `${value}%` : String(value);
  };
  const party = (heading, name, taxId, address) => ({
    heading,
    name: text(name),
    rows: [
      { label: t('taxId'), value: text(taxId) },
      { label: t('address'), value: text(address) },
    ],
  });

  const payment = invoice.payment || {};
  const dueDates = payment.due_dates?.length ? payment.due_dates : [invoice.payment_due_date].filter(Boolean);
  const paymentFormKey = PAYMENT_FORM_KEYS[payment.form];
  let paidText = null;
  if (invoice.is_paid) paidText = t('payment.paidYes');
  else if (payment.is_partially_paid) paidText = t('payment.paidPartially');

  const paymentRows = [
    dueDates.length && { label: t('payment.dueDate'), value: dueDates.map(date).join(', ') },
    hasValue(payment.form) && {
      label: t('payment.form'),
      value: paymentFormKey ? t(`paymentForm.${paymentFormKey}`) : String(payment.form),
    },
    hasValue(invoice.bank_account) && { label: t('payment.bankAccount'), value: invoice.bank_account },
    paidText && { label: t('payment.paid'), value: paidText },
    hasValue(invoice.payment_date) && { label: t('payment.paymentDate'), value: date(invoice.payment_date) },
    hasValue(invoice.amount_due) && { label: t('payment.amountDue'), value: money(invoice.amount_due) },
  ].filter(Boolean);

  return {
    notice: { title: t('notice.title'), body: t('notice.body') },
    title: t('title', { invoiceNumber: text(invoice.invoice_number) }),
    details: [
      { label: t('ksefNumber'), value: text(invoice.ksef_number) },
      { label: t('issueDate'), value: date(invoice.issue_date) },
      { label: t('saleDate'), value: date(invoice.sale_date) },
    ],
    seller: party(t('seller'), invoice.seller_name, invoice.seller_nip, invoice.seller_address),
    buyer: party(t('buyer'), invoice.buyer_name, invoice.buyer_nip, invoice.buyer_address),
    lines: {
      headers: [
        t('lines.number'), t('lines.name'), t('lines.quantity'), t('lines.unit'),
        t('lines.unitNetPrice'), t('lines.netAmount'), t('lines.vatRate'),
      ],
      rows: (invoice.lines || []).map((line, index) => [
        String(line.number ?? index + 1), text(line.name), quantity(line.quantity), text(line.unit),
        amount(line.unit_net_price), amount(line.net_amount), vatRate(line.vat_rate),
      ]),
      emptyText: t('lines.empty'),
    },
    totals: [
      { label: t('totals.net'), value: money(invoice.net_amount) },
      { label: t('totals.vat'), value: money(invoice.vat_amount) },
      { label: t('totals.gross'), value: money(invoice.gross_amount) },
    ],
    payment: paymentRows.length ? { heading: t('payment.title'), rows: paymentRows } : null,
    footer: t('footer', { date: formatDateOnly(locale, new Date()) }),
  };
}

const LINE_COLUMNS = [
  { width: 24, align: 'left' },
  { width: 187, align: 'left' },
  { width: 50, align: 'right' },
  { width: 38, align: 'left' },
  { width: 74, align: 'right' },
  { width: 78, align: 'right' },
  // The last column takes whatever width is left.
  { width: null, align: 'right' },
];

function drawContent(doc, content) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const contentWidth = right - left;
  let y = doc.page.margins.top;

  const measure = (font, size, text, width) => {
    doc.font(font).fontSize(size);
    return doc.heightOfString(text, { width });
  };
  const write = (font, size, color, text, x, top, options) => {
    doc.font(font).fontSize(size).fillColor(color).text(text, x, top, options);
  };
  // Positions are absolute, so a block that would cross the bottom margin
  // has to start a new page itself.
  const ensureSpace = (height) => {
    if (y + height <= bottom) return false;
    doc.addPage();
    y = doc.page.margins.top;
    return true;
  };

  // ── Notice ────────────────────────────────────────────────────────────
  const noticePadding = 8;
  const noticeTextWidth = contentWidth - 2 * noticePadding;
  const noticeTitleHeight = measure('Bold', 10, content.notice.title, noticeTextWidth);
  const noticeBodyHeight = measure('Regular', 8.5, content.notice.body, noticeTextWidth);
  const noticeHeight = noticeTitleHeight + noticeBodyHeight + 2 * noticePadding + 4;
  doc.rect(left, y, contentWidth, noticeHeight)
    .lineWidth(1).fillAndStroke(COLOR.noticeBackground, COLOR.noticeBorder);
  write('Bold', 10, COLOR.noticeText, content.notice.title, left + noticePadding, y + noticePadding, { width: noticeTextWidth });
  write('Regular', 8.5, COLOR.noticeText, content.notice.body,
    left + noticePadding, y + noticePadding + noticeTitleHeight + 4, { width: noticeTextWidth });
  y += noticeHeight + 18;

  // ── Title and invoice details ─────────────────────────────────────────
  write('Bold', 15, COLOR.text, content.title, left, y, { width: contentWidth });
  y += measure('Bold', 15, content.title, contentWidth) + 8;

  const labelWidth = 130;
  const drawLabelledRows = (rows, x, width, top) => {
    let rowTop = top;
    for (const row of rows) {
      const valueWidth = width - labelWidth;
      const rowHeight = Math.max(
        measure('Regular', 8.5, row.label, labelWidth - 6), measure('Regular', 8.5, row.value, valueWidth),
      );
      write('Regular', 8.5, COLOR.muted, row.label, x, rowTop, { width: labelWidth - 6 });
      write('Regular', 8.5, COLOR.text, row.value, x + labelWidth, rowTop, { width: valueWidth });
      rowTop += rowHeight + 3;
    }
    return rowTop;
  };
  y = drawLabelledRows(content.details, left, contentWidth, y) + 14;

  // ── Seller and buyer ──────────────────────────────────────────────────
  const columnGap = 16;
  const columnWidth = (contentWidth - columnGap) / 2;
  const barHeight = 15;
  const drawParty = (party, x) => {
    doc.rect(x, y, columnWidth, barHeight).fill(COLOR.barBackground);
    write('Bold', 8, COLOR.text, party.heading.toUpperCase(), x + 6, y + 4, { width: columnWidth - 12 });
    let top = y + barHeight + 6;
    write('Bold', 9, COLOR.text, party.name, x, top, { width: columnWidth });
    top += measure('Bold', 9, party.name, columnWidth) + 3;
    for (const row of party.rows) {
      const line = `${row.label}: ${row.value}`;
      write('Regular', 8.5, COLOR.text, line, x, top, { width: columnWidth });
      top += measure('Regular', 8.5, line, columnWidth) + 2;
    }
    return top;
  };
  y = Math.max(drawParty(content.seller, left), drawParty(content.buyer, left + columnWidth + columnGap)) + 16;

  // ── Line items ────────────────────────────────────────────────────────
  const fixedWidth = LINE_COLUMNS.reduce((total, column) => total + (column.width || 0), 0);
  let columnLeft = left;
  const columns = LINE_COLUMNS.map((column) => {
    const width = column.width ?? contentWidth - fixedWidth;
    const placed = { x: columnLeft, width, align: column.align };
    columnLeft += width;
    return placed;
  });
  const cellPadding = 4;
  const rowPadding = 7;
  const rowHeightOf = (cells, font, size) => Math.max(
    ...cells.map((cell, index) => measure(font, size, cell, columns[index].width - 2 * cellPadding)),
  ) + rowPadding;
  const drawCells = (cells, font, size) => {
    cells.forEach((cell, index) => {
      const column = columns[index];
      write(font, size, COLOR.text, cell, column.x + cellPadding, y + rowPadding / 2,
        { width: column.width - 2 * cellPadding, align: column.align });
    });
  };
  const drawRule = () => {
    doc.moveTo(left, y).lineTo(right, y).strokeColor(COLOR.border).lineWidth(0.5).stroke();
  };
  const drawHeaderRow = () => {
    const height = rowHeightOf(content.lines.headers, 'Bold', 7.5);
    doc.rect(left, y, contentWidth, height).fill(COLOR.barBackground);
    drawCells(content.lines.headers, 'Bold', 7.5);
    y += height;
    drawRule();
  };

  drawHeaderRow();
  for (const row of content.lines.rows) {
    const height = rowHeightOf(row, 'Regular', 7.5);
    if (ensureSpace(height)) drawHeaderRow();
    drawCells(row, 'Regular', 7.5);
    y += height;
    drawRule();
  }
  if (!content.lines.rows.length) {
    write('Regular', 8, COLOR.muted, content.lines.emptyText, left + cellPadding, y + 6, { width: contentWidth });
    y += 22;
    drawRule();
  }
  y += 14;

  // ── Totals ────────────────────────────────────────────────────────────
  const totalsWidth = 250;
  const totalsLeft = right - totalsWidth;
  const totalRowHeight = 16;
  ensureSpace(content.totals.length * totalRowHeight + 10);
  content.totals.forEach((total, index) => {
    const isLast = index === content.totals.length - 1;
    const font = isLast ? 'Bold' : 'Regular';
    if (isLast) doc.rect(totalsLeft, y, totalsWidth, totalRowHeight).fill(COLOR.barBackground);
    write(font, 9, COLOR.text, total.label, totalsLeft + 6, y + 4, { width: totalsWidth / 2 - 6 });
    write(font, 9, COLOR.text, total.value, totalsLeft + totalsWidth / 2, y + 4,
      { width: totalsWidth / 2 - 6, align: 'right' });
    y += totalRowHeight;
  });
  y += 16;

  // ── Payment ───────────────────────────────────────────────────────────
  if (content.payment) {
    ensureSpace(barHeight + 6 + content.payment.rows.length * 14);
    doc.rect(left, y, contentWidth, barHeight).fill(COLOR.barBackground);
    write('Bold', 8, COLOR.text, content.payment.heading.toUpperCase(), left + 6, y + 4, { width: contentWidth - 12 });
    y = drawLabelledRows(content.payment.rows, left, contentWidth, y + barHeight + 6) + 12;
  }

  // ── Footer ────────────────────────────────────────────────────────────
  ensureSpace(24);
  drawRule();
  write('Regular', 7, COLOR.muted, content.footer, left, y + 6, { width: contentWidth, align: 'center' });
}

// `invoice` is a ksef_invoices row with numeric amounts; `locale` is the
// tenant's default language. Resolves to the PDF as a Buffer.
async function generateInvoiceVisualisationPdf(invoice, locale) {
  const { doc, finished } = createPdfDocument({ margin: 40, size: 'A4' });
  drawContent(doc, buildVisualisationContent(invoice, locale));
  doc.end();
  return finished;
}

module.exports = { buildVisualisationContent, generateInvoiceVisualisationPdf };
