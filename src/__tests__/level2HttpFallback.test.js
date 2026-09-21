'use strict';

// Level 2 hardened HTTP fallback (21.09, po audycie próbki 50 firm — 16/50
// zablokowanych przez 403/429/timeout mimo istniejącego retry Level 1).
// fetchPageForCrawl() (Level 1) zostaje bez zmian — te testy sprawdzają tylko
// nowe elementy: kwalifikację do eskalacji (qualifiesForLevel2, czysta funkcja)
// oraz orkiestrację (fetchPageResilient, z zamockowanym axios — bez sieci).

jest.mock('axios');
const axios = require('axios');
const svc = require('../services/prospectEnrichmentService');

describe('qualifiesForLevel2 — kiedy w ogóle próbować Level 2', () => {
  test('403 -> kwalifikuje się', () => {
    expect(svc.qualifiesForLevel2({ status: 403, html: '' })).toBe(true);
  });

  test('429 -> kwalifikuje się', () => {
    expect(svc.qualifiesForLevel2({ status: 429, html: '' })).toBe(true);
  });

  test('404 -> NIGDY nie kwalifikuje się (strona faktycznie nie istnieje)', () => {
    expect(svc.qualifiesForLevel2({ status: 404, html: '' })).toBe(false);
  });

  test('brak html + błąd sieciowy nie-deterministyczny (np. timeout) -> kwalifikuje się', () => {
    expect(svc.qualifiesForLevel2({ status: null, html: '', error: 'timeout of 10000ms exceeded' })).toBe(true);
  });

  test('brak html + deterministyczny błąd TLS/DNS -> NIE kwalifikuje się (inne nagłówki tego nie naprawią)', () => {
    expect(svc.qualifiesForLevel2({ status: null, html: '', error: 'certificate has expired' })).toBe(false);
    expect(svc.qualifiesForLevel2({ status: null, html: '', error: 'getaddrinfo ENOTFOUND example.pl' })).toBe(false);
  });

  test('HTTP 200 z normalną treścią -> NIE kwalifikuje się (Level 1 wystarczył)', () => {
    expect(svc.qualifiesForLevel2({ status: 200, html: 'x'.repeat(5000) })).toBe(false);
  });

  test('HTTP 200, ale podejrzanie mało treści -> kwalifikuje się', () => {
    expect(svc.qualifiesForLevel2({ status: 200, html: 'x'.repeat(200) })).toBe(true);
  });

  test('brak wyniku (null/undefined) -> nie kwalifikuje się, nie rzuca', () => {
    expect(svc.qualifiesForLevel2(null)).toBe(false);
    expect(svc.qualifiesForLevel2(undefined)).toBe(false);
  });
});

describe('fetchPageResilient — eskalacja do Level 2 tylko po kwalifikującym niepowodzeniu Level 1', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Level 1 sukces (200, realna treść) -> Level 2 NIE jest wołany', async () => {
    axios.get.mockResolvedValueOnce({
      status: 200, data: 'x'.repeat(5000), headers: { 'content-type': 'text/html' },
      request: { res: { responseUrl: 'https://firma.pl' } },
    });
    const result = await svc.fetchPageResilient('https://firma.pl');
    expect(result.html.length).toBe(5000);
    expect(axios.get).toHaveBeenCalledTimes(1); // tylko Level 1
  });

  test('Level 1 404 -> Level 2 NIE jest wołany (strona faktycznie nie istnieje)', async () => {
    axios.get.mockResolvedValue({
      status: 404, data: '', headers: { 'content-type': 'text/html' },
      request: { res: { responseUrl: 'https://firma.pl/brak-strony' } },
    });
    const result = await svc.fetchPageResilient('https://firma.pl/brak-strony');
    expect(result.status).toBe(404);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('Level 1 403 (po wyczerpaniu własnego retry) -> Level 2 wołany i zwraca treść', async () => {
    // Level 1 (fetchPageForCrawl) ma maxRetries=2 domyślnie -> 3 próby, wszystkie 403.
    axios.get
      .mockResolvedValueOnce({ status: 403, data: '', headers: {}, request: { res: { responseUrl: 'https://firma.pl' } } })
      .mockResolvedValueOnce({ status: 403, data: '', headers: {}, request: { res: { responseUrl: 'https://firma.pl' } } })
      .mockResolvedValueOnce({ status: 403, data: '', headers: {}, request: { res: { responseUrl: 'https://firma.pl' } } })
      // Level 2, pierwsza próba — sukces z bardziej "przeglądarkowymi" nagłówkami
      .mockResolvedValueOnce({
        status: 200, data: 'x'.repeat(3000), headers: { 'content-type': 'text/html' },
        request: { res: { responseUrl: 'https://firma.pl' } },
      });
    const result = await svc.fetchPageResilient('https://firma.pl');
    expect(result.html.length).toBe(3000);
    expect(result.level).toBe(2);
    expect(axios.get.mock.calls.length).toBeGreaterThan(3); // Level 1 (3 próby) + co najmniej 1 z Level 2
  }, 20000);

  test('Level 2 też zawiedzie -> zwraca oryginalny wynik Level 1 (ten sam kształt)', async () => {
    axios.get.mockResolvedValue({ status: 403, data: '', headers: {}, request: { res: { responseUrl: 'https://firma.pl' } } });
    const result = await svc.fetchPageResilient('https://firma.pl');
    expect(result.html).toBe('');
    expect(result.status).toBe(403);
  }, 25000);

  test('Level 2 wysyła nagłówki Sec-Fetch-*/sec-ch-ua i osobny keep-alive agent', async () => {
    axios.get
      .mockResolvedValueOnce({ status: 429, data: '', headers: {}, request: { res: { responseUrl: 'https://firma.pl' } } })
      .mockResolvedValueOnce({ status: 429, data: '', headers: {}, request: { res: { responseUrl: 'https://firma.pl' } } })
      .mockResolvedValueOnce({ status: 429, data: '', headers: {}, request: { res: { responseUrl: 'https://firma.pl' } } })
      .mockResolvedValueOnce({
        status: 200, data: 'x'.repeat(3000), headers: { 'content-type': 'text/html' },
        request: { res: { responseUrl: 'https://firma.pl' } },
      });
    await svc.fetchPageResilient('https://firma.pl');
    const level2Call = axios.get.mock.calls.find(([, opts]) => opts?.headers?.['Sec-Fetch-Mode']);
    expect(level2Call).toBeDefined();
    expect(level2Call[1].headers).toHaveProperty('sec-ch-ua');
    expect(level2Call[1].httpsAgent).toBeDefined();
  }, 20000);
});
