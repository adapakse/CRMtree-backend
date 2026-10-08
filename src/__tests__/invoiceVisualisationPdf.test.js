'use strict';

// The PDF visualisation of a KSeF invoice. No database, no network.
//
// The text of a PDF with an embedded font is stored as glyph ids, so the
// labels are checked on the content model the PDF is drawn from
// (buildVisualisationContent); the PDF itself is checked for being a real,
// complete document. The invoice is the MF sample used by the parser tests.

const fs = require('fs');
const path = require('path');
const { parseInvoiceXml } = require('../services/ksefInvoiceParser');
const {
  buildVisualisationContent, generateInvoiceVisualisationPdf,
} = require('../services/invoiceVisualisationPdfService');

const SELLER_NIP = '8976607794';
const PAGE_OBJECT_RE = /\/Type \/Page\b/g;

// The row ksefSyncService stores for the sample, as far as the PDF reads it.
function sampleInvoice(overrides = {}) {
  const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'ksef-fa3-mf-sample.xml'), 'utf8')
    .replaceAll('#nip#', SELLER_NIP);
  const parsed = parseInvoiceXml(xml);
  return {
    ksef_number: `${SELLER_NIP}-20260215-0200C0A1B2C3-4F`,
    invoice_number: parsed.invoice_number,
    issue_date: parsed.issue_date,
    sale_date: '2025-10-09',
    seller_nip: parsed.seller.nip,
    seller_name: parsed.seller.name,
    seller_address: parsed.seller.address,
    buyer_nip: parsed.buyer.nip,
    buyer_name: parsed.buyer.name,
    buyer_address: parsed.buyer.address,
    net_amount: parsed.net_amount,
    vat_amount: parsed.vat_amount,
    gross_amount: parsed.gross_amount,
    currency: parsed.currency,
    payment_due_date: parsed.payment.due_dates[0],
    bank_account: parsed.payment.bank_accounts[0].number,
    is_paid: parsed.payment.is_paid,
    payment_date: parsed.payment.payment_date,
    amount_due: parsed.amount_due,
    payment: parsed.payment,
    lines: parsed.lines,
    ...overrides,
  };
}

const MINIMAL_INVOICE = {
  ksef_number: `${SELLER_NIP}-20260215-0200C0A1B2C3-4F`,
  invoice_number: null,
  issue_date: '2026-02-15',
  currency: 'PLN',
  payment: null,
  lines: [],
};

const labelsOf = (rows) => rows.map((row) => row.label);
// Polish groups thousands with a no-break space.
const withPlainSpaces = (value) => JSON.parse(JSON.stringify(value).replaceAll(' ', ' '));
const countPages = (pdf) => pdf.toString('latin1').match(PAGE_OBJECT_RE).length;

function expectCompletePdf(pdf) {
  expect(Buffer.isBuffer(pdf)).toBe(true);
  expect(pdf.length).toBeGreaterThan(5000);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdf.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
}

describe('content', () => {
  test('Polish: the notice, every label and the invoice data', () => {
    const content = withPlainSpaces(buildVisualisationContent(sampleInvoice(), 'pl'));

    expect(content.notice.title).toBe('Wizualizacja faktury z KSeF — to nie jest oryginalny dokument');
    expect(content.notice.body).toContain('wizualizacją danych faktury pobranych z Krajowego Systemu e-Faktur (KSeF)');
    expect(content.notice.body).toContain('Nie jest oryginalnym dokumentem');
    expect(content.title).toBe('Faktura FV2026/02/150');
    expect(content.details).toEqual([
      { label: 'Numer KSeF', value: `${SELLER_NIP}-20260215-0200C0A1B2C3-4F` },
      { label: 'Data wystawienia', value: '10.10.2025' },
      { label: 'Data sprzedaży', value: '09.10.2025' },
    ]);
    expect(content.seller).toEqual({
      heading: 'Sprzedawca',
      name: 'Elektrownia S.A.',
      rows: [
        { label: 'NIP', value: SELLER_NIP },
        { label: 'Adres', value: 'ul. Kwiatowa 1 m. 2, 00-001 Warszawa' },
      ],
    });
    expect(content.buyer).toMatchObject({ heading: 'Nabywca', name: 'Szkoła Testowa' });
    expect(content.lines.headers).toEqual([
      'Lp.', 'Nazwa towaru lub usługi', 'Ilość', 'J.m.', 'Cena jedn. netto', 'Wartość netto', 'Stawka VAT',
    ]);
    expect(content.lines.rows).toHaveLength(3);
    expect(content.lines.rows[0]).toEqual(['1', 'lodówka Zimnotech mk1', '10', 'szt.', '1626,01', '16 260,10', '23%']);
    expect(content.totals).toEqual([
      { label: 'Razem netto', value: '52 260,10 PLN' },
      { label: 'Razem VAT', value: '12 019,82 PLN' },
      { label: 'Razem brutto', value: '64 279,92 PLN' },
    ]);
    expect(content.payment.heading).toBe('Płatność');
    expect(content.payment.rows).toEqual([
      { label: 'Termin płatności', value: '15.03.2026' },
      { label: 'Forma płatności', value: 'przelew' },
      { label: 'Rachunek bankowy', value: '73111111111111111111111111' },
      { label: 'Do zapłaty', value: '63 279,92 PLN' },
    ]);
    expect(content.footer).toMatch(/^Wygenerowano w CRMtree \d{2}\.\d{2}\.\d{4} na podstawie danych pobranych z KSeF\.$/);
  });

  test('English: the same structure with English labels and formats', () => {
    const content = buildVisualisationContent(sampleInvoice(), 'en');

    expect(content.notice.title).toBe('Visualisation of a KSeF invoice — this is not the original document');
    expect(content.notice.body).toContain('It is not the original document');
    expect(content.title).toBe('Invoice FV2026/02/150');
    expect(labelsOf(content.details)).toEqual(['KSeF number', 'Issue date', 'Sale date']);
    expect(content.details[1].value).toBe('10/10/2025');
    expect(content.seller.heading).toBe('Seller');
    expect(labelsOf(content.seller.rows)).toEqual(['Tax ID (NIP)', 'Address']);
    expect(content.buyer.heading).toBe('Buyer');
    expect(content.lines.headers).toEqual([
      'No.', 'Name of goods or service', 'Quantity', 'Unit', 'Unit net price', 'Net amount', 'VAT rate',
    ]);
    expect(content.totals).toEqual([
      { label: 'Total net', value: '52,260.10 PLN' },
      { label: 'Total VAT', value: '12,019.82 PLN' },
      { label: 'Total gross', value: '64,279.92 PLN' },
    ]);
    expect(content.payment.heading).toBe('Payment');
    expect(content.payment.rows).toEqual([
      { label: 'Payment due date', value: '15/03/2026' },
      { label: 'Payment method', value: 'bank transfer' },
      { label: 'Bank account', value: '73111111111111111111111111' },
      { label: 'Amount due', value: '63,279.92 PLN' },
    ]);
  });

  test('the paid flag and the payment date appear only when the invoice carries them', () => {
    const paid = buildVisualisationContent(sampleInvoice({ is_paid: true, payment_date: '2026-03-01' }), 'pl');
    expect(paid.payment.rows).toEqual(expect.arrayContaining([
      { label: 'Zapłacono', value: 'tak' },
      { label: 'Data zapłaty', value: '01.03.2026' },
    ]));

    const invoice = sampleInvoice();
    const partiallyPaid = buildVisualisationContent(
      { ...invoice, payment: { ...invoice.payment, is_partially_paid: true } }, 'en',
    );
    expect(partiallyPaid.payment.rows).toContainEqual({ label: 'Paid', value: 'partially' });

    expect(labelsOf(buildVisualisationContent(invoice, 'pl').payment.rows)).not.toContain('Zapłacono');
  });

  test('every due date is listed; an unknown payment form and a non-numeric VAT rate are shown as they are', () => {
    const invoice = sampleInvoice();
    const content = buildVisualisationContent({
      ...invoice,
      payment: { ...invoice.payment, due_dates: ['2026-03-15', '2026-04-15'], form: '99' },
      lines: [{ ...invoice.lines[0], vat_rate: 'zw' }],
    }, 'pl');

    expect(content.payment.rows[0]).toEqual({ label: 'Termin płatności', value: '15.03.2026, 15.04.2026' });
    expect(content.payment.rows[1]).toEqual({ label: 'Forma płatności', value: '99' });
    expect(content.lines.rows[0].at(-1)).toBe('zw');
  });

  test('an invoice with almost no data: dashes, no payment section, a note instead of line items', () => {
    const content = buildVisualisationContent(MINIMAL_INVOICE, 'pl');

    expect(content.title).toBe('Faktura —');
    expect(content.details[2]).toEqual({ label: 'Data sprzedaży', value: '—' });
    expect(content.seller).toMatchObject({ name: '—', rows: [{ value: '—' }, { value: '—' }] });
    expect(content.totals.map((total) => total.value)).toEqual(['—', '—', '—']);
    expect(content.lines.rows).toEqual([]);
    expect(content.lines.emptyText).toBe('Dane faktury nie zawierają pozycji.');
    expect(content.payment).toBeNull();
  });

  test('a language that is not supported, or not translated yet, falls back to Polish', () => {
    for (const locale of ['xx', null, undefined]) {
      expect(buildVisualisationContent(sampleInvoice(), locale).seller.heading).toBe('Sprzedawca');
    }
  });
});

describe('PDF', () => {
  test.each(['pl', 'en'])('%s: a complete one-page PDF', async (locale) => {
    const pdf = await generateInvoiceVisualisationPdf(sampleInvoice(), locale);

    expectCompletePdf(pdf);
    expect(countPages(pdf)).toBe(1);
  });

  test('an invoice with almost no data still renders', async () => {
    expectCompletePdf(await generateInvoiceVisualisationPdf(MINIMAL_INVOICE, 'pl'));
  });

  test('many line items continue on further pages', async () => {
    const invoice = sampleInvoice();
    const lines = Array.from({ length: 120 }, (unused, index) => ({
      ...invoice.lines[0], number: index + 1, name: `Pozycja ${index + 1} — usługa z dłuższą nazwą, która się zawija`,
    }));

    const pdf = await generateInvoiceVisualisationPdf({ ...invoice, lines }, 'pl');

    expectCompletePdf(pdf);
    expect(countPages(pdf)).toBeGreaterThan(2);
  });
});
