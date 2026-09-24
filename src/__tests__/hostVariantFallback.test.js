'use strict';

// Targeted test etapu 3 (23.09) — fallback wariantu hosta www ↔ apex przy
// awarii na poziomie POŁĄCZENIA.
//
// Przypadek z audytu 47 firm bez `done` — [1473] Micel sp. z o.o.:
//   www.addevmaterials.pl  → "socket hang up"  (0 znaków, needs_review)
//   addevmaterials.pl      → HTTP 200, 486 kB, redirect na addevmaterials.com/pl/
// Ścieżka podmiany hosta ISTNIAŁA, ale odpalała się wyłącznie dla ENOTFOUND,
// więc awaria połączenia kończyła enrichment bez ani jednego znaku treści.
//
// Test pilnuje granic: podmiana hosta NIE może się odpalać dla błędów
// deterministycznych (TLS/DNS mają własne, wcześniejsze fallbacki) ani
// produkować bezsensownych hostów.

const svc = require('../services/prospectEnrichmentService');
const { swapWwwHost, CONNECTION_LEVEL_ERROR } = svc;

describe('etap 3 — swapWwwHost', () => {
  test.each([
    ['http://www.addevmaterials.pl', 'addevmaterials.pl', 'http://addevmaterials.pl'],
    ['https://www.firma.com.pl/kontakt', 'firma.com.pl', 'https://firma.com.pl/kontakt'],
  ])('www → apex: %s', (url, expectedHost, expectedUrl) => {
    const res = swapWwwHost(url);
    expect(res.altHost).toBe(expectedHost);
    expect(res.altUrl).toBe(expectedUrl);
  });

  test('apex → www (kierunek odwrotny też musi działać)', () => {
    const res = swapWwwHost('https://firma.pl');
    expect(res.altHost).toBe('www.firma.pl');
    expect(res.altUrl).toBe('https://www.firma.pl');
  });

  test.each([
    ['adres IP', 'http://192.168.0.1'],
    ['host bez kropki', 'http://localhost'],
    ['niepoprawny URL', 'nie-jest-urlem'],
  ])('nie generuje wariantu dla: %s', (_label, url) => {
    expect(swapWwwHost(url)).toBeNull();
  });

  // Bez tego "www.pl" dałoby apex "pl" — host, który nie jest domeną.
  test('REGRESJA: nie obcina www z hosta, po którym nie zostaje realna domena', () => {
    expect(swapWwwHost('http://www.pl')).toBeNull();
  });
});

describe('etap 3 — kwalifikacja błędu', () => {
  test.each([
    'socket hang up',
    'read ECONNRESET',
    'connect ECONNREFUSED 10.0.0.1:443',
    'timeout of 2601ms exceeded',
  ])('awaria połączenia kwalifikuje się: "%s"', (msg) => {
    expect(CONNECTION_LEVEL_ERROR.test(msg)).toBe(true);
  });

  // Te mają WŁASNE, wcześniejsze fallbacki (apex po ENOTFOUND, TLS insecure,
  // https→http). Podmiana hosta niczego by tu nie naprawiła, a kosztowałaby
  // dodatkowy request na każdej martwej domenie.
  test.each([
    'getaddrinfo ENOTFOUND firma.pl',
    'getaddrinfo EAI_AGAIN firma.pl',
    "Hostname/IP does not match certificate's altnames: Host: marsp.pl.",
    'CERT_HAS_EXPIRED',
  ])('błąd deterministyczny NIE kwalifikuje się: "%s"', (msg) => {
    expect(CONNECTION_LEVEL_ERROR.test(msg)).toBe(false);
  });
});

describe('etap 3 — kontrakt w fetchPageForCrawl', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'prospectEnrichmentService.js'), 'utf8');

  test('podmiana hosta odpala się dopiero po wyczerpaniu retry (attempt >= maxRetries)', () => {
    const branch = SRC.slice(SRC.indexOf('if (attempt >= maxRetries) {'));
    const head = branch.slice(0, branch.indexOf('if (TLS_CERT_ERROR.test(err.message)) {'));
    expect(head).toMatch(/CONNECTION_LEVEL_ERROR\.test\(err\.message\)/);
    // `currentUrl`, nie `url` — etap 4 dołożył śledzenie przekierowań
    // client-side, więc podmiana hosta musi dotyczyć adresu FAKTYCZNIE
    // pobieranego w tej iteracji, a nie oryginalnego adresu z importu.
    expect(head).toMatch(/fetchHostVariant\(currentUrl, swap\.altUrl, deadline, err\.message\)/);
  });

  test('wariant jest użyty TYLKO gdy faktycznie zwrócił treść', () => {
    const branch = SRC.slice(SRC.indexOf('CONNECTION_LEVEL_ERROR.test(err.message)'));
    expect(branch.slice(0, 700)).toMatch(/if \(variant\.html\)/);
  });

  test('wariant mieści się we wspólnym deadline — bez nowego stałego timeoutu', () => {
    const fn = SRC.slice(SRC.indexOf('async function fetchHostVariant('));
    const head = fn.slice(0, fn.indexOf('\n}\n'));
    expect(head).toMatch(/const remaining = deadline - Date\.now\(\);/);
    expect(head).toMatch(/timeout: remaining/);
  });

  test('ścieżka ENOTFOUND (sprzed etapu 3) zostaje nietknięta', () => {
    expect(SRC).toMatch(/ENOTFOUND on www\. host — tried apex without www instead of retrying/);
  });
});
