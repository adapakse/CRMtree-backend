'use strict';

// Reading a company's site correctly: page encoding, relative links and the name
// token used by the identity check. Each case below sent a correct website to
// "needs_review" (found on the comparme import, 2026-11-23).

const cheerio = require('cheerio');
const {
  decodePageBody, extractInternalLinks, nameTokensMatch, buildLinkAudit,
} = require('../services/prospectEnrichmentService');

const POLISH_TEXT = 'Spółka z ograniczoną odpowiedzialnością, ul. Żółkiewskiego 5, Łódź';

function encodeWindows1250(text) {
  const map = { 'ą': 0xB9, 'ć': 0xE6, 'ę': 0xEA, 'ł': 0xB3, 'ń': 0xF1, 'ó': 0xF3, 'ś': 0x9C, 'ź': 0x9F, 'ż': 0xBF,
    'Ą': 0xA5, 'Ć': 0xC6, 'Ę': 0xCA, 'Ł': 0xA3, 'Ń': 0xD1, 'Ó': 0xD3, 'Ś': 0x8C, 'Ź': 0x8F, 'Ż': 0xAF };
  return Buffer.from([...text].map(ch => map[ch] ?? ch.charCodeAt(0)));
}

describe('decodePageBody', () => {
  test('reads UTF-8 when nothing else is declared', () => {
    expect(decodePageBody(Buffer.from(POLISH_TEXT, 'utf8'), 'text/html')).toBe(POLISH_TEXT);
    expect(decodePageBody(Buffer.from(POLISH_TEXT, 'utf8'), undefined)).toBe(POLISH_TEXT);
  });

  test('uses the charset from the Content-Type header', () => {
    const body = encodeWindows1250(POLISH_TEXT);
    expect(decodePageBody(body, 'text/html; charset=windows-1250')).toBe(POLISH_TEXT);
  });

  test('uses the charset from the meta declaration when the header has none', () => {
    const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1250"></head><body>${POLISH_TEXT}</body></html>`;
    expect(decodePageBody(encodeWindows1250(html), 'text/html')).toContain(POLISH_TEXT);
  });

  test('falls back to UTF-8 for an unknown charset label', () => {
    expect(decodePageBody(Buffer.from(POLISH_TEXT, 'utf8'), 'text/html; charset=no-such-charset')).toBe(POLISH_TEXT);
  });
});

describe('extractInternalLinks', () => {
  test('keeps relative links without a leading slash', () => {
    const $ = cheerio.load('<a href="kontakt.html">Kontakt</a><a href="./o-firmie">O firmie</a><a href="/oferta">Oferta</a>');
    const paths = extractInternalLinks($, 'firma.pl', 'http:').map(link => link.path);
    expect(paths).toEqual(['/kontakt.html', '/o-firmie', '/oferta']);
  });

  test('still drops non-page links', () => {
    const $ = cheerio.load('<a href="mailto:biuro@firma.pl">mail</a><a href="tel:221234567">tel</a><a href="#top">top</a><a href="skype:firma">skype</a>');
    expect(extractInternalLinks($, 'firma.pl')).toEqual([]);
  });
});

describe('nameTokensMatch', () => {
  test('matches the brand given in quotes, not the description before it', () => {
    expect(nameTokensMatch(
      "Niepubliczny Zakład Opieki Zdrowotnej 'czwórka' sp. z o.o.",
      'Przychodnia Czwórka Mysłowice'
    )).toBe(true);
  });

  test('skips words describing the kind of facility', () => {
    expect(nameTokensMatch(
      'Niepubliczny Zakład Opieki Zdrowotnej Przychodnia Eskulap sp. z o.o.',
      'Przychodnia Eskulap Aktualności'
    )).toBe(true);
  });

  test('does not match an unrelated site', () => {
    expect(nameTokensMatch(
      "Niepubliczny Zakład Opieki Zdrowotnej 'czwórka' sp. z o.o.",
      'Rynek medyczny – portal branżowy'
    )).toBe(false);
  });
});

describe('buildLinkAudit', () => {
  test('audits a few thousand links without scanning the list for each of them', () => {
    const linkCount = 20_000;
    const allLinks = new Map();
    const diagnostics = [];
    for (let i = 0; i < linkCount; i++) {
      allLinks.set(`/produkt-${i}`, { path: `/produkt-${i}`, score: 1, anchor: '' });
      diagnostics.push({ path: `/produkt-${i}`, reason: 'fetch_error' });
    }
    const state = {
      allLinks, level2Links: new Map(), level1SelectedPaths: new Set(), level2SelectedPaths: new Set(),
      fetchedPages: [], diagnostics,
    };
    const startedAt = Date.now();
    const audit = buildLinkAudit(state, new Map());
    expect(audit).toHaveLength(linkCount);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
