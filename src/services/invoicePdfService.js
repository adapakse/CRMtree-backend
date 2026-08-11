'use strict';
// src/services/invoicePdfService.js
//
// Renders a billing invoice (rozliczenie) to a PDF buffer. Layout is modeled
// on a compact Polish e-invoice template (KSeF-style: gray Sprzedawca/Nabywca
// bars, dense bordered items table with a VAT breakdown, a "Podsumowanie"
// pivot table, amount spelled out in words, blank signature lines) — small,
// dense typography instead of a spaced-out "poster" layout.
//
// Seller (CRMtree) and buyer (tenant) legal data — company name, NIP,
// address, seller bank account, due date — come from billing_seller_config /
// tenant_billing_details, frozen onto the invoice row at generation time
// (see jobs/billing-run.js). Neither is guaranteed complete: an admin may
// not have filled everything in yet, which is a valid state, not an error —
// missing fields render as a clear "brak danych" placeholder, and
// isInvoiceComplete() below keeps the draft banner up until all of them are
// present. VAT is a real 23% (standard Polish rate — confirmed 2026-08-07),
// frozen onto the invoice row at generation time in billingService.js /
// billing-run.js, never recomputed here. KSeF integration itself is
// explicitly deferred (2026-08-03 notes) — only the visual style of this
// template is borrowed, not actual KSeF submission.
//
// Polish diacritics: PDFKit's 14 standard fonts (Helvetica etc.) only cover
// WinAnsiEncoding (~CP1252, Western European) — Polish letters (ą ć ę ł ń ó
// ś ź ż) live in Latin-2/CP1250 territory and have no glyph in those fonts,
// so PDFKit silently drops or mis-renders them. Fix: embed a real Unicode
// TrueType font (DejaVu Sans, via the `dejavu-fonts-ttf` package — bundled
// font files, no other deps, permissive license) instead of a standard-14
// font name.

const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD    = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
const LOGO_PATH    = path.join(__dirname, '..', 'assets', 'crmtree-logo-reverse.png');

const CYCLE_LABEL  = { monthly: 'Miesięczny', annual: 'Roczny' };
const STATUS_LABEL = { issued: 'Wystawiona', void: 'Anulowana' };

const PLACEHOLDER = '— brak danych w systemie —';

const COLOR = {
  text:    '#111827',
  muted:   '#4b5563',
  border:  '#9ca3af',
  barBg:   '#c7c7c7', // gray section-header bars, matches the reference template
  danger:  '#b91c1c',
};

// An invoice only stops looking like a draft once every field a real Polish
// business invoice needs is actually present — checked against the frozen
// snapshot on the invoice row (not live config), so an invoice's appearance
// never changes after it was issued even if config changes later.
function isInvoiceComplete(invoice) {
  return !!(
    invoice.seller_name && invoice.seller_nip && invoice.seller_address && invoice.seller_bank_account &&
    invoice.buyer_name && invoice.buyer_nip &&
    invoice.buyer_street && invoice.buyer_postal_code && invoice.buyer_city && invoice.buyer_country &&
    invoice.buyer_invoice_email
  );
}

// Buyer address is stored as structured parts (street / postal+city /
// country) — degrades gracefully if only some parts are filled in, instead
// of repeating the full placeholder phrase once per missing part.
function formatStructuredAddress(street, postalCode, city, country) {
  if (!street && !postalCode && !city && !country) return PLACEHOLDER;
  const cityLine = [postalCode, city].filter(Boolean).join(' ');
  return [street, cityLine, country].filter(Boolean).join(', ');
}

function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

function formatAmount(amount) {
  return Number(amount).toFixed(2);
}

function legalField(value) {
  return value || PLACEHOLDER;
}

// ── Polish integer-to-words ("słownie") ──────────────────────────────────
const ONES = ['', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];
const TEENS = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście',
  'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
const TENS = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt',
  'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt'];
const HUNDREDS = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset',
  'sześćset', 'siedemset', 'osiemset', 'dziewięćset'];
const SCALES = [null, ['tysiąc', 'tysiące', 'tysięcy'], ['milion', 'miliony', 'milionów'], ['miliard', 'miliardy', 'miliardów']];

function threeDigitsToWords(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10]);
  } else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) parts.push(TENS[t]);
    if (o) parts.push(ONES[o]);
  }
  return parts.join(' ');
}

// forms = [singular, few (2-4), many (0, 5+, 12-14 exception)]
function pluralForm(n, forms) {
  if (n === 1) return forms[0];
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return forms[1];
  return forms[2];
}

function integerToWordsPL(n) {
  if (n === 0) return 'zero';
  const groups = [];
  let rem = n;
  while (rem > 0) {
    groups.push(rem % 1000);
    rem = Math.floor(rem / 1000);
  }
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    if (i === 0) {
      parts.push(threeDigitsToWords(g));
    } else if (i === 1 && g === 1) {
      parts.push(SCALES[i][0]); // "tysiąc", not "jeden tysiąc"
    } else {
      parts.push(threeDigitsToWords(g), pluralForm(g, SCALES[i]));
    }
  }
  return parts.join(' ');
}

// "pięćset EUR 00/100" — mirrors the reference template's convention of
// spelling out the whole-unit amount and appending the currency code and
// subunits as digits, not spelling out "euro"/grosze.
function amountInWords(amount, currency) {
  const [intPart, fracPart] = formatAmount(amount).split('.');
  return `${integerToWordsPL(parseInt(intPart, 10))} ${currency} ${fracPart}/100`;
}

function generateInvoicePdfBuffer({ invoice, plan }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Regular', FONT_REGULAR);
    doc.registerFont('Bold', FONT_BOLD);
    doc.font('Regular');

    // DejaVu Sans substitutes "fi"/"fl"/"ffi" runs with a single ligature
    // glyph by default. Visually fine, but PDFKit doesn't emit a correct
    // ToUnicode mapping for that glyph, so the embedded text layer silently
    // drops the second letter ("konfigurowana" → "konfgurowana") — invisible
    // on screen, but breaks copy/paste, search and text extraction. Only the
    // `{ tag: false }` object form actually disables a default-on feature —
    // an array like `['-liga']` just adds a literal, meaningless tag.
    // Wrapped once here so every .text()/.heightOfString() call gets it
    // automatically, instead of relying on per-call discipline.
    const NO_LIGATURES = { liga: false, clig: false, calt: false };
    function withNoLigatures(options) {
      return { ...options, features: { ...NO_LIGATURES, ...(options && options.features) } };
    }
    const rawText = doc.text.bind(doc);
    doc.text = (text, x, y, options) => {
      if (typeof x === 'object' && x !== null) return rawText(text, withNoLigatures(x));
      return rawText(text, x, y, withNoLigatures(options));
    };
    const rawHeightOfString = doc.heightOfString.bind(doc);
    doc.heightOfString = (text, options) => rawHeightOfString(text, withNoLigatures(options));

    const left         = doc.page.margins.left;
    const right        = doc.page.width - doc.page.margins.right;
    const contentWidth = right - left;
    let y = doc.y;

    // Measures text height under a given font/size without drawing it —
    // used everywhere below to size boxes/rows from real content instead of
    // a guessed line count, so wrapped text can never get cut off or
    // overlap the next element.
    function measure(font, size, text, width) {
      doc.font(font).fontSize(size);
      return doc.heightOfString(text, { width });
    }

    const issueDate  = new Date(invoice.generated_at);
    const saleDate    = invoice.period_end; // billing period closed = the "sale" of that period
    const dueDate     = invoice.due_date; // frozen at generation time — see billing-run.js
    const cycleLabel  = CYCLE_LABEL[invoice.billing_cycle] || invoice.billing_cycle;
    const complete    = isInvoiceComplete(invoice);

    // ── Header: logo (left) + dates (right) ──────────────────────────────
    const logoWidth = 80;
    doc.image(LOGO_PATH, left, y, { width: logoWidth });

    const dateColWidth = 200;
    const dateColX     = right - dateColWidth;
    const dateLabelW   = 95;
    const dateValueW   = dateColWidth - dateLabelW;
    let dy = y;
    function dateRow(label, value) {
      doc.font('Regular').fontSize(8).fillColor(COLOR.muted).text(label, dateColX, dy, { width: dateLabelW });
      doc.font('Regular').fontSize(8).fillColor(COLOR.text)
        .text(value, dateColX + dateLabelW, dy, { width: dateValueW, align: 'right' });
      dy += 12;
    }
    dateRow('Data wystawienia:', formatShortDate(issueDate));
    dateRow('Data sprzedaży:', formatShortDate(saleDate));
    dateRow('Termin płatności:', formatShortDate(dueDate));

    y = Math.max(y + 46, dy) + 14; // 46 ≈ logo height at this width (1063x624 source ratio)

    // ── Title ─────────────────────────────────────────────────────────────
    doc.font('Bold').fontSize(15).fillColor(COLOR.text).text(`FAKTURA ${invoice.invoice_number}`, left, y);
    y += 24;

    // ── Sprzedawca / Nabywca (gray bar header, plain text below) ─────────
    const colGap   = 16;
    const colWidth = (contentWidth - colGap) / 2;
    const sellerX  = left;
    const buyerX   = left + colWidth + colGap;
    const barHeight = 15;

    // extraLines renders label/value pairs after the address line — used for
    // the seller's bank account and the buyer's invoice-delivery email.
    // Empty array (default) renders nothing extra, instead of a meaningless
    // "brak danych" line for a field that column doesn't have at all.
    function legalColumn(x, title, name, nip, addressText, extraLines = []) {
      doc.rect(x, y, colWidth, barHeight).fill(COLOR.barBg);
      doc.font('Bold').fontSize(8).fillColor(COLOR.text).text(title, x + 6, y + 4, { width: colWidth - 12 });
      let cy = y + barHeight + 6;
      doc.font('Regular').fontSize(8.5).fillColor(COLOR.text);
      doc.text(legalField(name), x, cy, { width: colWidth });
      cy += measure('Regular', 8.5, legalField(name), colWidth) + 2;
      const nipLine = `NIP: ${legalField(nip)}`;
      doc.text(nipLine, x, cy, { width: colWidth });
      cy += measure('Regular', 8.5, nipLine, colWidth) + 2;
      const addressLine = `Adres: ${legalField(addressText)}`;
      doc.text(addressLine, x, cy, { width: colWidth });
      cy += measure('Regular', 8.5, addressLine, colWidth);
      for (const { label, value } of extraLines) {
        cy += 2;
        const line = `${label}: ${legalField(value)}`;
        doc.text(line, x, cy, { width: colWidth });
        cy += measure('Regular', 8.5, line, colWidth);
      }
      return cy;
    }

    const bottomA = legalColumn(
      sellerX, 'SPRZEDAWCA', invoice.seller_name, invoice.seller_nip, invoice.seller_address,
      [{ label: 'Nr rachunku bankowego', value: invoice.seller_bank_account }],
    );
    const buyerAddress = formatStructuredAddress(invoice.buyer_street, invoice.buyer_postal_code, invoice.buyer_city, invoice.buyer_country);
    const bottomB = legalColumn(
      buyerX, 'NABYWCA', invoice.buyer_name, invoice.buyer_nip, buyerAddress,
      [{ label: 'E-mail do faktur', value: invoice.buyer_invoice_email }],
    );
    y = Math.max(bottomA, bottomB) + 18;

    // ── Items table ──────────────────────────────────────────────────────
    const cols = {
      lp:      { x: left,       w: 20 },
      name:    { x: left + 20,  w: 170 },
      jm:      { x: left + 190, w: 30 },
      qty:     { x: left + 220, w: 40 },
      price:   { x: left + 260, w: 55 },
      vatRate: { x: left + 315, w: 42 },
      netto:   { x: left + 357, w: 55 },
      vatVal:  { x: left + 412, w: 52 },
      brutto:  { x: left + 464, w: contentWidth - 464 },
    };
    const cellPadX = 4;
    const rowPadY  = 8;

    function measureRow(cells, font, size) {
      return Math.max(...cells.map(c => measure(font, size, c.text, c.w - cellPadX))) + rowPadY;
    }
    function drawRow(cells, font, size, color, top) {
      doc.font(font).fontSize(size).fillColor(color);
      for (const c of cells) doc.text(c.text, c.x + cellPadX, top + rowPadY / 2, { width: c.w - cellPadX, align: c.align || 'left' });
      doc.fillColor(COLOR.text);
    }

    // VAT rate/amount are frozen on the invoice row at generation time (see
    // billing-run.js) — never recomputed here, so a future rate change can
    // never retroactively alter an already-issued invoice's PDF.
    const netto    = Number(invoice.total_amount_eur);
    const vatVal   = Number(invoice.vat_amount_eur);
    const vatRateStr = `${Number(invoice.vat_rate)}%`;
    const brutto   = netto + vatVal;
    const periodStr = `${formatShortDate(invoice.period_start)} – ${formatShortDate(invoice.period_end)}`;
    // Professional (custom pricing) bills one flat quote regardless of user
    // count — showing Ilość=active_user_count next to that flat amount as
    // "Cena jedn." would make unit price × qty visibly NOT equal the total.
    // Show qty=1 instead and fold the user count into the item name as
    // informational text (it's still recorded on active_user_count).
    const itemName = plan.is_custom_pricing
      ? `Dostęp do platformy CRMtree — plan ${plan.name} (${cycleLabel}, ${periodStr}) — ${invoice.active_user_count} aktywnych użytkowników`
      : `Dostęp do platformy CRMtree — plan ${plan.name} (${cycleLabel}, ${periodStr})`;
    const itemQty      = plan.is_custom_pricing ? 1 : invoice.active_user_count;
    const itemUnit     = plan.is_custom_pricing ? 'usł.' : 'szt.';
    const itemUnitPrice = plan.is_custom_pricing ? netto : Number(invoice.unit_price_eur);

    const headerCells = [
      { text: 'Lp',              x: cols.lp.x,      w: cols.lp.w },
      { text: 'Nazwa usługi',    x: cols.name.x,    w: cols.name.w },
      { text: 'J.m.',            x: cols.jm.x,      w: cols.jm.w },
      { text: 'Ilość',           x: cols.qty.x,     w: cols.qty.w,     align: 'right' },
      { text: 'Cena jedn.',      x: cols.price.x,   w: cols.price.w,   align: 'right' },
      { text: 'Stawka VAT',      x: cols.vatRate.x, w: cols.vatRate.w, align: 'right' },
      { text: 'Wartość netto',   x: cols.netto.x,   w: cols.netto.w,   align: 'right' },
      { text: 'Wartość VAT',     x: cols.vatVal.x,  w: cols.vatVal.w,  align: 'right' },
      { text: 'Wartość brutto',  x: cols.brutto.x,  w: cols.brutto.w,  align: 'right' },
    ];
    const dataCells = [
      { text: '1',                                x: cols.lp.x,      w: cols.lp.w },
      { text: itemName,                            x: cols.name.x,    w: cols.name.w },
      { text: itemUnit,                            x: cols.jm.x,      w: cols.jm.w },
      { text: String(itemQty),                     x: cols.qty.x,     w: cols.qty.w,     align: 'right' },
      { text: formatAmount(itemUnitPrice),          x: cols.price.x,  w: cols.price.w,   align: 'right' },
      { text: vatRateStr,                          x: cols.vatRate.x, w: cols.vatRate.w, align: 'right' },
      { text: formatAmount(netto),                 x: cols.netto.x,   w: cols.netto.w,   align: 'right' },
      { text: formatAmount(vatVal),                x: cols.vatVal.x,  w: cols.vatVal.w,  align: 'right' },
      { text: formatAmount(brutto),                x: cols.brutto.x,  w: cols.brutto.w,  align: 'right' },
    ];

    const tableTop     = y;
    const headerHeight = measureRow(headerCells, 'Bold', 7.5);
    doc.rect(left, y, contentWidth, headerHeight).fill(COLOR.barBg);
    drawRow(headerCells, 'Bold', 7.5, COLOR.text, y);
    y += headerHeight;

    const dataHeight = measureRow(dataCells, 'Regular', 7.5);
    drawRow(dataCells, 'Regular', 7.5, COLOR.text, y);
    y += dataHeight;

    doc.rect(left, tableTop, contentWidth, headerHeight + dataHeight).strokeColor(COLOR.border).lineWidth(0.75).stroke();
    doc.moveTo(left, tableTop + headerHeight).lineTo(right, tableTop + headerHeight)
      .strokeColor(COLOR.border).lineWidth(0.75).stroke();
    y += 16;

    // ── "Podsumowanie {currency}" VAT breakdown pivot table ──────────────
    const summaryWidth = 260;
    const summaryX     = right - summaryWidth;
    const sCols = {
      rate:   { w: summaryWidth * 0.18 },
      netto:  { w: summaryWidth * 0.28 },
      vat:    { w: summaryWidth * 0.27 },
      brutto: { w: summaryWidth * 0.27 },
    };
    sCols.rate.x   = summaryX;
    sCols.netto.x  = sCols.rate.x + sCols.rate.w;
    sCols.vat.x    = sCols.netto.x + sCols.netto.w;
    sCols.brutto.x = sCols.vat.x + sCols.vat.w;

    doc.font('Regular').fontSize(8).fillColor(COLOR.text)
      .text(`Podsumowanie ${invoice.currency}`, left, y);
    y += 12;

    function summaryRow(cells, font, size, fill, top) {
      const h = Math.max(...Object.keys(sCols).map(k =>
        measure(font, size, cells[k], sCols[k].w - 6))) + 6;
      if (fill) doc.rect(summaryX, top, summaryWidth, h).fill(fill);
      doc.font(font).fontSize(size).fillColor(COLOR.text);
      for (const k of Object.keys(sCols)) {
        doc.text(cells[k], sCols[k].x + 3, top + 3, { width: sCols[k].w - 6, align: 'right' });
      }
      return h;
    }

    const summaryTop = y;
    const sHeaderH = summaryRow(
      { rate: 'Stawka VAT', netto: 'Wartość netto', vat: 'Wartość VAT', brutto: 'Wartość brutto' },
      'Bold', 7, COLOR.barBg, y,
    );
    y += sHeaderH;
    const sDataH = summaryRow(
      { rate: vatRateStr, netto: formatAmount(netto), vat: formatAmount(vatVal), brutto: formatAmount(brutto) },
      'Regular', 7.5, null, y,
    );
    y += sDataH;
    const sTotalH = summaryRow(
      { rate: 'Razem', netto: formatAmount(netto), vat: formatAmount(vatVal), brutto: formatAmount(brutto) },
      'Bold', 7.5, COLOR.barBg, y,
    );
    y += sTotalH;
    doc.rect(summaryX, summaryTop, summaryWidth, sHeaderH + sDataH + sTotalH)
      .strokeColor(COLOR.border).lineWidth(0.75).stroke();

    const summaryBottom = y;

    // ── Left block: Razem / słownie / Do zapłaty / status ────────────────
    let ly = summaryTop + 4;
    const leftColWidth = summaryX - left - 20;
    function leftLine(label, value, opts = {}) {
      const font = opts.bold ? 'Bold' : 'Regular';
      const size = opts.size || 8.5;
      doc.font('Regular').fontSize(8).fillColor(COLOR.muted).text(label, left, ly, { width: leftColWidth });
      const labelH = measure('Regular', 8, label, leftColWidth);
      doc.font(font).fontSize(size).fillColor(COLOR.text).text(value, left, ly + labelH + 1, { width: leftColWidth });
      ly += labelH + measure(font, size, value, leftColWidth) + 8;
    }
    leftLine('Razem:', `${formatAmount(brutto)} ${invoice.currency}`);
    leftLine('Słownie:', amountInWords(brutto, invoice.currency));
    leftLine('Do zapłaty:', `${formatAmount(brutto)} ${invoice.currency}`, { bold: true, size: 11 });
    leftLine('Status:', STATUS_LABEL[invoice.status] || invoice.status);

    y = Math.max(summaryBottom, ly) + 26;

    // ── Signature lines ──────────────────────────────────────────────────
    const sigWidth = (contentWidth - 40) / 2;
    doc.moveTo(left, y).lineTo(left + sigWidth, y).strokeColor(COLOR.border).lineWidth(0.75).stroke();
    doc.moveTo(right - sigWidth, y).lineTo(right, y).strokeColor(COLOR.border).lineWidth(0.75).stroke();
    y += 4;
    doc.font('Regular').fontSize(7.5).fillColor(COLOR.muted);
    doc.text('Osoba upoważniona do wystawienia', left, y, { width: sigWidth, align: 'center' });
    doc.text('Osoba upoważniona do odbioru', right - sigWidth, y, { width: sigWidth, align: 'center' });
    y += 30;

    // ── Footer: draft banner only while seller/buyer data is incomplete ──
    doc.moveTo(left, y).lineTo(right, y).strokeColor(COLOR.border).lineWidth(0.75).stroke();
    y += 10;
    if (!complete) {
      const draftNotice = 'DOKUMENT ROBOCZY — uzupełnij dane rozliczeniowe sprzedawcy/nabywcy w Panelu admina, aby uzyskać fakturę końcową';
      doc.font('Bold').fontSize(9).fillColor(COLOR.danger)
        .text(draftNotice, left, y, { width: contentWidth, align: 'center' });
      y += measure('Bold', 9, draftNotice, contentWidth) + 4;
    }
    doc.font('Regular').fontSize(7).fillColor(COLOR.muted)
      .text(`Wygenerowano automatycznie z systemu CRMtree: ${formatShortDate(issueDate)}.`, left, y, { width: contentWidth, align: 'center' });

    doc.end();
  });
}

module.exports = { generateInvoicePdfBuffer, isInvoiceComplete };
