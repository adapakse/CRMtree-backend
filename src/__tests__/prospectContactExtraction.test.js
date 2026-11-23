'use strict';

// Contact extraction runs on the request thread: a slow scan of one page freezes
// the whole backend (every tenant, every request) for as long as it lasts. A page
// with ~800 KB of inline script text did exactly that — the e-mail regex was
// quadratic on a long run of word characters without "@".

const cheerio = require('cheerio');
const {
  extractEmailsFromText, extractPhonesFromText, extractContactsFromHtml,
} = require('../services/prospectEnrichmentService');

const SCAN_BUDGET_MS = 2000;

function elapsedMs(run) {
  const startedAt = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

describe('extractEmailsFromText', () => {
  test('finds addresses in plain text', () => {
    const text = 'Kontakt: biuro@firma.pl, Jan.Kowalski+oferty@dzial.firma.com.pl oraz sprzedaz@firma.pl.';
    expect(extractEmailsFromText(text).sort()).toEqual([
      'biuro@firma.pl', 'jan.kowalski+oferty@dzial.firma.com.pl', 'sprzedaz@firma.pl',
    ]);
  });

  test('ignores an "@" that is not part of an address', () => {
    expect(extractEmailsFromText('cena @ 10 zł, @media screen, user@localhost')).toEqual([]);
  });

  test('returns nothing for empty input', () => {
    expect(extractEmailsFromText('')).toEqual([]);
    expect(extractEmailsFromText(null)).toEqual([]);
  });

  test('scans a long run of word characters without "@" in linear time', () => {
    const minifiedScript = 'a'.repeat(800_000);
    let found;
    const ms = elapsedMs(() => { found = extractEmailsFromText(`${minifiedScript} biuro@firma.pl`); });
    expect(found).toEqual(['biuro@firma.pl']);
    expect(ms).toBeLessThan(SCAN_BUDGET_MS);
  });

  test('scans text with very many "@" characters in linear time', () => {
    const ms = elapsedMs(() => extractEmailsFromText('@'.repeat(400_000)));
    expect(ms).toBeLessThan(SCAN_BUDGET_MS);
  });
});

describe('extractPhonesFromText', () => {
  test('scans a long run of digits and whitespace in linear time', () => {
    const text = `tel${' '.repeat(200_000)}x ${'1'.repeat(200_000)} +48 22 123 45 67`;
    let found;
    const ms = elapsedMs(() => { found = extractPhonesFromText(text); });
    expect(found).toContain('+48 22 123 45 67');
    expect(ms).toBeLessThan(SCAN_BUDGET_MS);
  });
});

describe('extractContactsFromHtml', () => {
  test('handles a page with a huge inline script without blocking', () => {
    const html = `<html><body><p>Napisz: biuro@firma.pl, tel. 22 123 45 67</p>
      <script>var bundle="${'x'.repeat(800_000)}";</script></body></html>`;
    let contacts;
    const ms = elapsedMs(() => { contacts = extractContactsFromHtml(html, cheerio.load(html)); });
    expect(contacts.emails).toContain('biuro@firma.pl');
    expect(contacts.phones).toContain('22 123 45 67');
    expect(ms).toBeLessThan(SCAN_BUDGET_MS);
  });
});
