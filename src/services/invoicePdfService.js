'use strict';
// src/services/invoicePdfService.js
//
// Renders a billing invoice (rozliczenie) to a PDF buffer. Layout is
// intentionally plain — no seller/buyer legal details yet (tenants has no
// NIP/address fields), so this is explicitly NOT a VAT invoice: it carries a
// visible "test/internal document" disclaimer until those legal fields exist
// and this has been reviewed for real accounting use. KSeF integration is
// explicitly deferred (2026-08-03 notes).

const PDFDocument = require('pdfkit');

const CYCLE_LABEL = { monthly: 'Miesięczny', annual: 'Roczny' };

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('pl-PL', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function formatEur(amount) {
  return `${Number(amount).toFixed(2)} EUR`;
}

function generateInvoicePdfBuffer({ invoice, tenant, plan }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#b91c1c')
      .text('DOKUMENT TESTOWY — NIE JEST FAKTURĄ VAT', { align: 'center' });
    doc.fontSize(8).font('Helvetica').fillColor('#b91c1c')
      .text('Wewnętrzne rozliczenie do celów roboczych. Brak danych sprzedawcy i nabywcy wymaganych na fakturze VAT.', { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(1);

    doc.fontSize(18).font('Helvetica-Bold').text('CRMtree', { align: 'left' });
    doc.fontSize(10).font('Helvetica').text('Rozliczenie za korzystanie z platformy', { align: 'left' });
    doc.moveDown(1.5);

    doc.fontSize(14).font('Helvetica-Bold').text(`Rozliczenie ${invoice.invoice_number}`, { align: 'center' });
    doc.moveDown(1);

    doc.fontSize(10).font('Helvetica-Bold').text('Nabywca');
    doc.font('Helvetica').text(tenant.name);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').text('Szczegóły rozliczenia');
    doc.font('Helvetica').moveDown(0.3);
    doc.text(`Plan: ${plan.name}`);
    doc.text(`Cykl rozliczeniowy: ${CYCLE_LABEL[invoice.billing_cycle] || invoice.billing_cycle}`);
    doc.text(`Okres: ${formatDate(invoice.period_start)} — ${formatDate(invoice.period_end)}`);
    doc.text(`Aktywni użytkownicy: ${invoice.active_user_count}`);
    doc.text(`Cena jednostkowa: ${formatEur(invoice.unit_price_eur)} / aktywny użytkownik`);
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica-Bold').text(`Do zapłaty: ${formatEur(invoice.total_amount_eur)}`);
    doc.moveDown(1.5);

    doc.fontSize(9).font('Helvetica').fillColor('#666666')
      .text(`Wygenerowano automatycznie: ${formatDate(new Date(invoice.generated_at).toISOString().slice(0, 10))}`);
    doc.moveDown(0.5);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#b91c1c')
      .text('Dokument testowy — nie stanowi faktury VAT w rozumieniu przepisów o VAT.');

    doc.end();
  });
}

module.exports = { generateInvoicePdfBuffer };
