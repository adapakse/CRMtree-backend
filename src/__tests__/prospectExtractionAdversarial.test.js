'use strict';

// Attempts to refute the 2026-11-23 enrichment fixes. Two kinds of tests:
//  - differential: the rewritten linear scans must return what the original
//    (quadratic) regexes returned, on thousands of generated inputs;
//  - adversarial: inputs built to make each fix do the wrong thing.

const cheerio = require('cheerio');
const svc = require('../services/prospectEnrichmentService');

// Deterministic generator — a failing case can be reproduced from its seed.
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomText(random, alphabet, maxLength) {
  const length = Math.floor(random() * maxLength);
  let text = '';
  for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)];
  return text;
}

// The regexes exactly as they were before the fix.
const ORIGINAL_EMAIL_RE = /[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi;
const ORIGINAL_PHONE_LABELLED_RE = /\b(?:tel|telefon|kom|fax|faks)\b\.?\s*:?\s*((?:\+?\d[\s()./-]?){9,15})/gi;
const PHONE_COUNTRY_PREFIX_RE = /(?:\+48|0048)[\s./-]?(?:\d[\s./-]?){9}/g;

function originalEmails(text) {
  return [...new Set([...text.matchAll(ORIGINAL_EMAIL_RE)].map(m => m[0].toLowerCase()))].sort();
}

function originalPhones(text) {
  const trimTail = (s) => s.trim().replace(/[^\d)]+$/, '');
  const phones = new Set();
  for (const m of text.matchAll(PHONE_COUNTRY_PREFIX_RE)) {
    if (m[0].replace(/\D/g, '').length === 11) phones.add(trimTail(m[0]));
  }
  for (const m of text.matchAll(ORIGINAL_PHONE_LABELLED_RE)) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 11) phones.add(trimTail(m[1]));
  }
  return [...phones].sort();
}

describe('extractEmailsFromText — same result as the original regex', () => {
  // Tokens that make addresses, near-addresses and overlapping matches likely.
  const EMAIL_ALPHABET = ['a', 'b', 'Z', '1', '_', '.', '.', '-', '+', '%', '@', '@', ' ', ' ', '\n', ',', ';', '<', '>', 'pl', 'com', 'biuro', 'x'];

  test('on 20000 generated texts', () => {
    const random = createRandom(20261123);
    for (let i = 0; i < 20000; i++) {
      const text = randomText(random, EMAIL_ALPHABET, 60);
      const expected = originalEmails(text);
      const actual = svc.extractEmailsFromText(text).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Mismatch for ${JSON.stringify(text)}\n expected ${JSON.stringify(expected)}\n actual   ${JSON.stringify(actual)}`);
      }
    }
  });

  test.each([
    ['two addresses glued by a second "@"', 'a@b.pl@c.pl'],
    ['address followed directly by another', 'jan@firma.pl,anna@firma.pl'],
    ['dots and dashes around the "@"', '..jan.@-firma-.pl.'],
    ['"@" at the very start and end', '@firma.pl jan@'],
    ['a long but valid address', `${'a'.repeat(60)}@${'b'.repeat(60)}.pl`],
    ['uppercase and plus tag', 'Jan.Kowalski+CRM@Firma.COM.PL'],
    ['top-level domain of one letter is not an address', 'jan@firma.p'],
    ['digits-only domain ending is not an address', 'jan@10.0.0.1'],
    ['address inside markup', '<a href="mailto:biuro@firma.pl">biuro@firma.pl</a>'],
  ])('%s', (_, text) => {
    expect(svc.extractEmailsFromText(text).sort()).toEqual(originalEmails(text));
  });
});

describe('extractPhonesFromText — same result as the original regex', () => {
  const PHONE_ALPHABET = ['tel', 'tel.', 'telefon', 'kom', 'fax', ':', ' ', ' ', '\t', '\n', '+48', '0048', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '.', '/', '(', ')', 'x'];

  test('on 20000 generated texts', () => {
    const random = createRandom(4821);
    for (let i = 0; i < 20000; i++) {
      const text = randomText(random, PHONE_ALPHABET, 40);
      const expected = originalPhones(text);
      const actual = svc.extractPhonesFromText(text).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Mismatch for ${JSON.stringify(text)}\n expected ${JSON.stringify(expected)}\n actual   ${JSON.stringify(actual)}`);
      }
    }
  });
});

describe('scans stay linear on hostile input', () => {
  const BUDGET_MS = 3000;
  const hostileTexts = {
    'word characters only': 'a'.repeat(600_000),
    'word characters then one "@"': `${'a'.repeat(600_000)}@`,
    '"@" then word characters': `@${'a'.repeat(600_000)}`,
    'alternating "a@"': 'a@'.repeat(300_000),
    'dots and dashes': '.-'.repeat(300_000),
    'label then whitespace': `tel${' '.repeat(600_000)}`,
    'label, colon, whitespace': `tel:${' \t'.repeat(300_000)}x`,
    'many labels with gaps': `tel ${' '.repeat(200)}`.repeat(3000),
    'digits only': '1'.repeat(600_000),
    'digits with separators': '1 '.repeat(300_000),
    'plus signs and digits': '+48'.repeat(200_000),
    'capitalised words without spaces': 'Aa'.repeat(300_000),
    'capitalised words with spaces': 'Aa '.repeat(200_000),
  };

  test.each(Object.entries(hostileTexts))('contact extraction: %s', (_, text) => {
    const html = `<html><body><p>${text}</p></body></html>`;
    const startedAt = Date.now();
    svc.extractContactsFromHtml(html, cheerio.load(html));
    expect(Date.now() - startedAt).toBeLessThan(BUDGET_MS);
  });

  test.each(Object.entries(hostileTexts))('identity check: %s', (_, text) => {
    const startedAt = Date.now();
    svc.checkDomainIdentity({
      nip: '5252436981', text, title: 'Firma',
      company: { company_name: 'Firma Testowa sp. z o.o.', nip: '5252436981' }, krsData: null, gusData: null,
    });
    expect(Date.now() - startedAt).toBeLessThan(BUDGET_MS);
  });

  test.each(Object.entries(hostileTexts))('parking detection: %s', (_, text) => {
    const startedAt = Date.now();
    svc.isDomainParkingPage(text);
    expect(Date.now() - startedAt).toBeLessThan(BUDGET_MS);
  });
});

describe('decodePageBody — hostile and odd declarations', () => {
  const POLISH = 'Zażółć gęślą jaźń';
  const windows1250 = (text) => {
    const map = { 'ą': 0xB9, 'ć': 0xE6, 'ę': 0xEA, 'ł': 0xB3, 'ń': 0xF1, 'ó': 0xF3, 'ś': 0x9C, 'ź': 0x9F, 'ż': 0xBF, 'Ż': 0xAF };
    return Buffer.from([...text].map(ch => map[ch] ?? ch.charCodeAt(0)));
  };

  test('the header wins over a conflicting meta declaration', () => {
    const html = `<meta charset="utf-8"><p>${POLISH}</p>`;
    expect(svc.decodePageBody(windows1250(html), 'text/html; charset=windows-1250')).toContain(POLISH);
  });

  test.each(['UTF-8', 'utf8', '"utf-8"', 'Utf-8'])('accepts the UTF-8 label written as %s', (label) => {
    expect(svc.decodePageBody(Buffer.from(POLISH, 'utf8'), `text/html; charset=${label}`)).toBe(POLISH);
  });

  test('a quoted, upper-case legacy label is understood', () => {
    expect(svc.decodePageBody(windows1250(POLISH), 'text/html; charset="WINDOWS-1250"')).toBe(POLISH);
  });

  test('iso-8859-2 is decoded', () => {
    const iso = Buffer.from([0xB3, 0xF3, 0x64, 0xBC]); // "łódź" in iso-8859-2
    expect(svc.decodePageBody(iso, 'text/html; charset=iso-8859-2')).toBe('łódź');
  });

  test('a declaration found only deep in the page does not switch the charset', () => {
    const html = `${'<p>tekst</p>'.repeat(400)}<pre>charset=windows-1250</pre><p>${POLISH}</p>`;
    expect(svc.decodePageBody(Buffer.from(html, 'utf8'), 'text/html')).toContain(POLISH);
  });

  test.each([
    'text/html; charset=', 'text/html; charset=;', 'text/html; charset=\'); DROP', 'charset=../../etc/passwd',
    'text/html; charset=utf-16le-nonsense', '', null, undefined,
  ])('garbage declaration %j never throws and falls back to UTF-8', (contentType) => {
    expect(svc.decodePageBody(Buffer.from(POLISH, 'utf8'), contentType)).toBe(POLISH);
  });

  test('an empty body is an empty string', () => {
    expect(svc.decodePageBody(Buffer.alloc(0), 'text/html; charset=windows-1250')).toBe('');
  });
});

describe('extractInternalLinks — a relative link must never leave the site', () => {
  const links = (html) => svc.extractInternalLinks(cheerio.load(html), 'firma.pl', 'https:');

  test.each([
    ['protocol-relative to another host', '<a href="//evil.example/kontakt">x</a>'],
    ['backslashes read as slashes', '<a href="\\\\evil.example\\kontakt">x</a>'],
    ['absolute to another host', '<a href="https://evil.example/kontakt">x</a>'],
    ['userinfo trick', '<a href="https://firma.pl@evil.example/kontakt">x</a>'],
    ['javascript scheme', '<a href="javascript:alert(1)">x</a>'],
    ['upper-case javascript scheme with spaces', '<a href="  JAVASCRIPT:alert(1)">x</a>'],
    ['data scheme', '<a href="data:text/html,<p>x</p>">x</a>'],
    ['file scheme', '<a href="file:///etc/passwd">x</a>'],
    ['upper-case mailto', '<a href="MAILTO:biuro@firma.pl">x</a>'],
    ['other app scheme', '<a href="whatsapp://send?phone=48123456789">x</a>'],
    ['empty href', '<a href="">x</a>'],
  ])('%s is dropped', (_, html) => {
    expect(links(html)).toEqual([]);
  });

  test('every returned link stays on the company host', () => {
    const html = ['kontakt.html', './oferta', '../o-nas', 'a/b/c.php', '?id=5', 'kontakt.html#mapa', '/x/../kontakt', '%2e%2e/kontakt']
      .map(href => `<a href="${href}">link</a>`).join('');
    const found = links(html);
    expect(found.length).toBeGreaterThan(0);
    for (const link of found) {
      expect(new URL(link.fullHref).hostname).toBe('firma.pl');
      expect(link.path.startsWith('/')).toBe(true);
    }
  });

  test('"../" cannot climb above the site root', () => {
    expect(links('<a href="../../../../etc/passwd">x</a>').map(l => l.path)).toEqual(['/etc/passwd']);
  });

  test('file downloads are still skipped when written as relative links', () => {
    expect(links('<a href="cennik.pdf">x</a><a href="./foto.JPG">y</a>')).toEqual([]);
  });

  test('admin and login areas are still skipped when written as relative links', () => {
    expect(links('<a href="wp-admin/index.php">x</a><a href="./login">y</a>')).toEqual([]);
  });
});

describe('isDomainParkingPage — must not turn a working company into "no website"', () => {
  test.each([
    'Części aftermarket do samochodów ciężarowych – hurtownia B2B',
    'Automotive aftermarket solutions for workshops',
    'Kontakt: biuro@jordan.com.pl, współpracujemy z jordan.com',
    'Napisz do nas: sprzedaz@meridan.com',
    'Rejestracja domen i hosting – oferta dla firm',
    'Sprzedajemy domy i mieszkania w Gdańsku',
    'Nasza domena to jakość i terminowość',
    'Kup teraz – domeny internetowe od 9 zł',
    'Oferta domeny – sprawdź nasz cennik hostingu',
  ])('real company text: %s', (text) => {
    expect(svc.isDomainParkingPage(`<html><head><title>Firma</title></head><body>${text}</body></html>`)).toBe(false);
  });

  test.each([
    '<title>Oferta domeny uniagro.pl</title>',
    '<title>Sprzedam domenę www.expol.pl</title>',
    '<p>Domena jest na sprzedaż</p>',
    '<a href="https://www.aftermarket.pl/domena/x.pl">kup</a>',
    '<script src="https://dan.com/parking.js"></script>',
    '<a href="https://www.afternic.com/forsale/x.com">buy</a>',
  ])('for-sale page: %s', (html) => {
    expect(svc.isDomainParkingPage(html)).toBe(true);
  });
});

describe('name matching alone never confirms a domain', () => {
  const company = { company_name: "Niepubliczny Zakład Opieki Zdrowotnej 'czwórka' sp. z o.o.", nip: '2220742302' };

  test('brand in the title, nothing from the registry in the text → not verified', () => {
    const result = svc.checkDomainIdentity({
      nip: company.nip, text: 'Przychodnia Czwórka zaprasza pacjentów. Rejestracja telefoniczna.',
      title: 'Przychodnia Czwórka Mysłowice', company, krsData: null, gusData: null,
    });
    expect(result.verified).toBe(false);
  });

  test('another site that merely uses the same word → not verified', () => {
    const result = svc.checkDomainIdentity({
      nip: company.nip, text: 'Czwórka dzieci i pies – blog rodzinny o podróżach.',
      title: 'Czwórka – blog rodzinny', company, krsData: null, gusData: null,
    });
    expect(result.verified).toBe(false);
  });

  test('a different NIP on the page is still not ours', () => {
    const result = svc.checkDomainIdentity({
      nip: company.nip, text: 'Przychodnia Czwórka sp. z o.o. NIP 634-012-34-56',
      title: 'Przychodnia Czwórka', company, krsData: null, gusData: null,
    });
    expect(result.verified).toBe(false);
  });

  test.each([
    ['plain', '2220742302'], ['hyphens', '222-074-23-02'], ['spaces', '222 074 23 02'],
    ['en dashes', '222–074–23–02'], ['spaced dashes', '222 - 074 - 23 - 02'], ['PL prefix', 'PL2220742302'],
  ])('our NIP written with %s is recognised', (_, written) => {
    const result = svc.checkDomainIdentity({
      nip: company.nip, text: `Dane rejestrowe: NIP ${written}`, title: 'Strona', company, krsData: null, gusData: null,
    });
    expect(result).toMatchObject({ verified: true, reason: 'nip_match' });
  });

  test.each([
    ['digits spread across a sentence', 'tel. 222 074, faks 23 02'],
    ['a longer number containing ours', 'Konto: 1222207423020000'],
    ['our digits followed by more digits', 'Nr 22207423021'],
    ['our digits split by letters', '2220a742302'],
  ])('NIP is not "found" in %s', (_, text) => {
    const result = svc.checkDomainIdentity({ nip: company.nip, text, title: 'Strona', company, krsData: null, gusData: null });
    expect(result.reason).not.toBe('nip_match');
  });

  test.each([
    ['generic words only', 'Przedsiębiorstwo Produkcyjno-Handlowe sp. z o.o.', 'Przedsiębiorstwo produkcyjno-handlowe'],
    ['a two-letter quoted brand', "Zakład Usługowy 'ab' sp. z o.o.", 'AB – usługi'],
    ['empty title', "Zakład 'czwórka'", ''],
    ['title that only shares a generic word', "Zakład Usługowy 'czwórka' sp. z o.o.", 'Zakład usługowy – oferta'],
  ])('nameTokensMatch stays false for %s', (_, name, title) => {
    expect(svc.nameTokensMatch(name, title)).toBe(false);
  });
});

describe('extractText — cookie and popup stripping', () => {
  const longContent = 'Producent maszyn rolniczych z wieloletnim doświadczeniem. '.repeat(80);

  test('a page wrapper that only carries a cookie/modal class keeps its content', () => {
    const html = `<html><body><div class="site has-cookie-bar modal-open"><p>${longContent}</p></div></body></html>`;
    expect(svc.extractText(cheerio.load(html))).toContain('Producent maszyn rolniczych');
  });

  test('a real cookie banner is still removed', () => {
    const html = `<html><body><main><p>${longContent}</p></main><div id="cookie-notice">Ta strona używa plików cookies. Akceptuję</div></body></html>`;
    expect(svc.extractText(cheerio.load(html))).not.toContain('Akceptuję');
  });
});

describe('buildLinkAudit — same audit as before for duplicated paths', () => {
  test('a path listed twice is audited once, using its first diagnostic', () => {
    const state = {
      allLinks: new Map([['/kontakt', { path: '/kontakt', score: 10, anchor: 'Kontakt' }]]),
      level2Links: new Map([['/kontakt', { path: '/kontakt', score: 10, anchor: 'Kontakt' }], ['/oferta', { path: '/oferta', score: 5, anchor: '' }]]),
      level1SelectedPaths: new Set(['/kontakt']), level2SelectedPaths: new Set(),
      fetchedPages: [],
      diagnostics: [{ path: '/kontakt', reason: 'not_found' }, { path: '/kontakt', reason: 'fetch_error' }],
    };
    const audit = svc.buildLinkAudit(state, new Map());
    expect(audit.map(a => a.path)).toEqual(['/kontakt', '/oferta']);
    expect(audit[0]).toMatchObject({ stage: 'FETCH_FAILED', reason: 'not_found' });
  });
});
