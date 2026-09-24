// Identity fallback (20.09, case Alior Bank): zanim domena trafi do
// needs_review/domain_unconfirmed, sprawdzamy dane prawne firmy poza homepage
// (pełny tekst stopki/podstron, JSON-LD). Cel: więcej poprawnych domen BEZ
// pogorszenia precyzji — fallback zatwierdza wyłącznie mocny dowód (NIP/KRS/
// REGON albo kod pocztowy + ulica) z JEDNEJ strony tej samej domeny.
// Testy są czysto tekstowe (bez sieci): nie hardcodują domen ani firm poza
// danymi wejściowymi konkretnych przypadków.

const cheerio = require('cheerio');
const svc = require('../services/prospectEnrichmentService');

const ALIOR = { company_name: 'Alior Bank S.A.', nip: '1070010731' };
const ALIOR_GUS = { regon: '141387142', postcode: '00-801', street: 'Chmielna' };

const evalFallback = (company, gusData, title, sources) =>
  svc.evaluateIdentityFallback({ company, krsData: null, gusData, title, sources });

describe('extractIdentityText — pełny tekst do weryfikacji tożsamości (nie tekst dla AI)', () => {
  test('widzi NIP w stopce poza <main>, którego extractText() dla AI nie zwraca', () => {
    const html = `<html><body>
      <main>${'Oferta i produkty banku. '.repeat(60)}</main>
      <footer>Alior Bank S.A., ul. Chmielna 100, 00-801 Warszawa, NIP 107-00-10-731, REGON 141387142</footer>
    </body></html>`;
    const forAi = svc.extractText(cheerio.load(html));
    expect(forAi).not.toMatch(/107-00-10-731/);
    expect(svc.extractIdentityText(html)).toMatch(/107-00-10-731/);
  });

  test('nie ucina do 6000 znaków — NIP na końcu długiej strony zostaje', () => {
    const html = `<html><body><p>${'a b '.repeat(9000)}</p><p>NIP 1070010731</p></body></html>`;
    expect(svc.extractIdentityText(html)).toMatch(/NIP 1070010731/);
  });

  test('uwzględnia dane strukturalne JSON-LD (taxID/adres organizacji)', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Organization","name":"Alior Bank S.A.","taxID":"1070010731",
       "address":{"streetAddress":"Chmielna 100","postalCode":"00-801"}}
    </script></head><body><main>krótko</main></body></html>`;
    const text = svc.extractIdentityText(html);
    expect(text).toMatch(/1070010731/);
    expect(text).toMatch(/00-801/);
  });

  test('nie zwraca zawartości <script>/<style> (kod strony nie jest dowodem)', () => {
    const html = '<html><body><script>var nip = "1070010731";</script><style>.x{}</style><p>tekst</p></body></html>';
    expect(svc.extractIdentityText(html)).not.toMatch(/1070010731/);
  });

  test('pusty/brakujący HTML → pusty string', () => {
    expect(svc.extractIdentityText('')).toBe('');
    expect(svc.extractIdentityText(null)).toBe('');
  });
});

describe('sameSiteHost — obce dane po przekierowaniu nie mogą potwierdzać', () => {
  test('www i bez www to ta sama witryna', () => {
    expect(svc.sameSiteHost('https://www.firma.pl/kontakt', 'https://firma.pl')).toBe(true);
    expect(svc.sameSiteHost('http://FIRMA.pl/x', 'https://www.firma.pl')).toBe(true);
  });
  test('inna domena → false', () => {
    expect(svc.sameSiteHost('https://inna-firma.com/kontakt', 'https://www.firma.pl')).toBe(false);
    expect(svc.sameSiteHost('https://firma.pl.evil.com', 'https://firma.pl')).toBe(false);
  });
  test('błędny URL → false', () => {
    expect(svc.sameSiteHost('nie-url', 'https://firma.pl')).toBe(false);
  });
});

describe('pickIdentityFallbackUrls — kilka najbardziej prawdopodobnych stron, nie crawl', () => {
  const base = 'https://www.firma.pl';
  const link = (path, anchor = '') => ({ path, anchor, fullHref: `${base}${path}` });

  test('zawsze uwzględnia /kontakt (standardowa ścieżka), nawet gdy odkryte linki są inne', () => {
    const urls = svc.pickIdentityFallbackUrls([
      link('/centrum-kontaktu.html'), link('/o-banku/kontakt-dla-mediow.html'), link('/regulamin-konta.html'),
    ], base);
    expect(urls).toContain(`${base}/kontakt`);
  });

  test('nigdy nie przekracza 5 stron i nie ma duplikatów', () => {
    const many = ['/kontakt', '/o-nas', '/o-firmie', '/regulamin', '/polityka-prywatnosci', '/dane-spolki', '/privacy', '/about', '/contact']
      .map(p => link(p));
    const urls = svc.pickIdentityFallbackUrls(many, base);
    expect(urls.length).toBeLessThanOrEqual(5);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test('dane prawne (dane-spolki) mają pierwszeństwo przed zwykłym kontaktem', () => {
    const urls = svc.pickIdentityFallbackUrls([link('/kontakt'), link('/dane-spolki')], base);
    expect(urls[0]).toBe(`${base}/dane-spolki`);
  });

  test('pomija linki niezwiązane z danymi firmy oraz stronę główną', () => {
    const urls = svc.pickIdentityFallbackUrls([link('/'), link('/produkty'), link('/oferta/laptopy')], base);
    expect(urls.some(u => /produkty|oferta/.test(u))).toBe(false);
  });

  test('brak odkrytych linków → tylko standardowe ścieżki (w tym /kontakt)', () => {
    const urls = svc.pickIdentityFallbackUrls([], base);
    expect(urls[0]).toBe(`${base}/kontakt`);
    expect(urls.length).toBeLessThanOrEqual(5);
  });

  test('odkryte linki: maksymalnie 3, reszta miejsc to ścieżki standardowe', () => {
    const disc = ['/a-kontakt-1', '/a-kontakt-2', '/a-kontakt-3', '/a-kontakt-4', '/a-kontakt-5'].map(p => link(p));
    const urls = svc.pickIdentityFallbackUrls(disc, base);
    expect(urls.filter(u => /a-kontakt/.test(u)).length).toBe(3);
    expect(urls).toContain(`${base}/kontakt`);
  });
});

describe('evaluateIdentityFallback — przypadki, które MAJĄ przejść', () => {
  test('Alior-like: homepage bez NIP, dowód prawny na podstronie /kontakt → zatwierdzone po NIP', () => {
    const r = evalFallback(ALIOR, ALIOR_GUS, 'Alior Bank', [
      { label: 'homepage', text: 'Konta, kredyty, lokaty. Alior Konto prowadzimy bezpłatnie.' },
      { label: 'https://www.aliorbank.pl/kontakt', text: 'Dane firmy: Alior Bank S.A., ul. Chmielna 100, 00-801 Warszawa, NIP 107-00-10-731, REGON 141387142' },
    ]);
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('nip_match');
    expect(r.decided_by).toBe('nip_match@https://www.aliorbank.pl/kontakt');
  });

  test('sam REGON z etykietą na podstronie wystarcza', () => {
    const r = evalFallback(ALIOR, { regon: '141387142' }, 'x', [
      { label: 'homepage', text: 'brak danych' },
      { label: '/regulamin', text: 'Administrator: Alior Bank S.A. REGON: 141387142' },
    ]);
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('regon_match');
  });

  test('kod pocztowy + ulica JEDNOCZEŚNIE na jednej stronie wystarczają', () => {
    const r = evalFallback({ company_name: 'Firma X sp. z o.o.', nip: '5250000000' }, ALIOR_GUS, 'Inny tytuł', [
      { label: '/kontakt', text: 'Siedziba: ul. Chmielna 100, 00-801 Warszawa' },
    ]);
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('strong_registry_address');
  });

  test('dane w JSON-LD (taxID) też liczą się jako dowód', () => {
    const html = '<html><head><script type="application/ld+json">{"@type":"Organization","taxID":"1070010731"}</script></head><body>x</body></html>';
    const r = evalFallback(ALIOR, ALIOR_GUS, 't', [{ label: 'homepage', text: svc.extractIdentityText(html) }]);
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('nip_match');
  });
});

describe('evaluateIdentityFallback — przypadki, które NADAL MUSZĄ być odrzucone (precyzja)', () => {
  test('Air Liquide → żywa strona biura podróży (obca firma): brak dowodów → odrzucone', () => {
    const company = { company_name: 'Air Liquide Polska sp. z o.o.', nip: '5260000001' };
    const gus = { regon: '012345678', postcode: '02-672', street: 'Domaniewska' };
    const r = evalFallback(company, gus, 'Air.com.pl - Najtańsze oferty LAST MINUTE i podróże marzeń!', [
      { label: 'homepage', text: 'Last minute, wczasy, wycieczki, all inclusive. Regulamin biura podróży, polityka prywatności.' },
      { label: '/kontakt', text: 'Biuro podróży Air. ul. Marszałkowska 10, 00-001 Warszawa. NIP 5272670332' },
    ]);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('insufficient_evidence');
  });

  test('VFS → pod adresem działa inna firma (Ceraco Group): odrzucone', () => {
    const company = { company_name: 'VFS Usługi Finansowe Polska sp. z o.o.', nip: '5252345678' };
    const r = evalFallback(company, { regon: '140000000', postcode: '02-001', street: 'Sienna' }, 'Ceraco Group', [
      { label: 'homepage', text: 'Ceraco Group We are a Danish development group, operating on the commercial properties market in Warsaw.' },
      { label: '/kontakt', text: 'Ceraco Sp. z o.o., Polna Corner, ul. Polna 1, 00-622 Warszawa, NIP 5213000000' },
    ]);
    expect(r.verified).toBe(false);
  });

  test('zaparkowana domena (Horex): brak jakichkolwiek danych firmy → odrzucone', () => {
    const company = { company_name: 'Przedsiębiorstwo Wielobranżowe Horex sp. z o.o.', nip: '9260000527' };
    const r = evalFallback(company, { regon: '150000000' }, 'Strona domeny przedsiebiorstwo.com.pl', [
      { label: 'homepage', text: 'Strona domeny przedsiebiorstwo.com.pl Ta domena jest zarejestrowana. Skontaktuj się z administratorem.' },
    ]);
    expect(r.verified).toBe(false);
  });

  test('obca domena z NIEZGODNYM NIP-em i tą samą nazwą: odrzucone', () => {
    const r = evalFallback(ALIOR, ALIOR_GUS, 'Alior Bank Argentina', [
      { label: 'homepage', text: 'Alior Bank Argentina S.A. Buenos Aires. NIP 5272670332' },
      { label: '/kontakt', text: 'Kontakt: Alior Bank Argentina, Av. Corrientes 1234, Buenos Aires, Argentina' },
    ]);
    expect(r.verified).toBe(false);
  });

  test('PODOBNA NAZWA (tytuł = nazwa firmy) bez żadnego dowodu prawnego NIE wystarcza', () => {
    const r = evalFallback(ALIOR, ALIOR_GUS, 'Alior Bank S.A. — oficjalna strona', [
      { label: 'homepage', text: 'Alior Bank Alior Bank Alior Bank oferta konta i kredyty' },
      { label: '/kontakt', text: 'Zadzwoń do nas. Alior Bank.' },
    ]);
    expect(r.verified).toBe(false);
    expect(r.decided_by).toBe('no_strict_evidence');
  });

  test('SŁABA reguła (nazwa w title + sam kod pocztowy) NIE działa w fallbacku', () => {
    const r = evalFallback(ALIOR, ALIOR_GUS, 'Alior Bank', [
      { label: '/kontakt', text: 'Filia: 00-801 Warszawa, punkt obsługi' },
    ]);
    expect(r.verified).toBe(false);
    expect(r.decided_by).toBe('weak_evidence_not_accepted_in_fallback');
  });

  test('NIP rozbity na końcu jednego i początku drugiego tekstu NIE skleja się w fałszywe trafienie', () => {
    const r = evalFallback(ALIOR, null, 'x', [
      { label: 'homepage', text: 'telefon 22 100 1070' },
      { label: '/kontakt', text: '010731 dział obsługi' },
    ]);
    expect(r.verified).toBe(false);
  });

  test('zagraniczny adres w bloku kontaktowym bez lokalnego adresu → foreign_address_conflict', () => {
    const r = evalFallback({ company_name: 'Mirol sp. z o.o.', nip: '5250000009' }, { postcode: '00-950', street: 'Prosta' }, 'Mirol', [
      { label: '/kontakt', text: 'Kontakt: Mirol S.A., Córdoba, Argentina, Buenos Aires 500' },
    ]);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('foreign_address_conflict');
  });

  test('brak źródeł → odrzucone', () => {
    expect(evalFallback(ALIOR, ALIOR_GUS, 't', []).verified).toBe(false);
    expect(evalFallback(ALIOR, ALIOR_GUS, 't', undefined).verified).toBe(false);
  });
});

describe('evaluateIdentityFallback — diagnostyka: da się odpowiedzieć "dlaczego tak"', () => {
  test('wynik zawiera per-strona: liczbę znaków, trafienia (nip/regon/krs/adres/nazwa) i powód', () => {
    const r = evalFallback(ALIOR, ALIOR_GUS, 'Alior Bank', [
      { label: 'homepage', text: 'Alior Bank oferta' },
      { label: '/kontakt', text: 'Alior Bank S.A. NIP 1070010731 ul. Chmielna 00-801' },
    ]);
    expect(r.sources).toHaveLength(2);
    expect(r.sources[0]).toMatchObject({ source: 'homepage', hits: { nip: false } });
    expect(r.sources[1].hits).toMatchObject({ nip: true, street: true, postcode: true, legal_name: true });
    expect(r.decided_by).toBe('nip_match@/kontakt');
  });

  test('przy odrzuceniu decided_by mówi, czego zabrakło', () => {
    const r = evalFallback(ALIOR, ALIOR_GUS, 't', [{ label: 'homepage', text: 'nic' }]);
    expect(r.decided_by).toBe('no_strict_evidence');
  });
});

describe('runIdentityFallback — bez stanu crawla nie próbuje nic pobierać', () => {
  test('brak crawlState → attempted=false, verified=false', async () => {
    const r = await svc.runIdentityFallback({ company: ALIOR, krsData: null, gusData: ALIOR_GUS, crawlState: null, title: '' });
    expect(r.attempted).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.pages_checked).toEqual([]);
  });
});
