'use strict';
// utils/pdfDocument.js
//
// The PDFKit document every generated PDF starts from: an embedded Unicode
// font and ligatures switched off.
//
// PDFKit's 14 standard fonts (Helvetica etc.) only cover WinAnsiEncoding, so
// Polish letters (ą ć ę ł ń ó ś ź ż) and most other non-Western characters have
// no glyph in them and are silently dropped. DejaVu Sans (the `dejavu-fonts-ttf`
// package) is embedded instead, registered as 'Regular' and 'Bold'.

const PDFDocument = require('pdfkit');

const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD    = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

// DejaVu Sans replaces "fi" / "fl" / "ffi" with one ligature glyph by default.
// PDFKit emits no correct ToUnicode mapping for that glyph, so the text layer
// loses the second letter ("konfigurowana" → "konfgurowana") — invisible on
// screen, but it breaks copy/paste, search and text extraction. Only the
// `{ tag: false }` object form switches a default-on feature off.
const NO_LIGATURES = { liga: false, clig: false, calt: false };

function withNoLigatures(options) {
  return { ...options, features: { ...NO_LIGATURES, ...(options && options.features) } };
}

// Returns the document and a promise of the finished PDF buffer (resolved
// after doc.end()). text() and heightOfString() are wrapped so that every call
// gets the ligature fix without per-call discipline.
function createPdfDocument(options) {
  const doc = new PDFDocument(options);
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('Regular', FONT_REGULAR);
  doc.registerFont('Bold', FONT_BOLD);
  doc.font('Regular');

  const rawText = doc.text.bind(doc);
  doc.text = (text, x, y, textOptions) => {
    if (typeof x === 'object' && x !== null) return rawText(text, withNoLigatures(x));
    return rawText(text, x, y, withNoLigatures(textOptions));
  };
  const rawHeightOfString = doc.heightOfString.bind(doc);
  doc.heightOfString = (text, textOptions) => rawHeightOfString(text, withNoLigatures(textOptions));

  return { doc, finished };
}

module.exports = { createPdfDocument };
