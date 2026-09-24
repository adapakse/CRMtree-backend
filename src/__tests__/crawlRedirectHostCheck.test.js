'use strict';

// H1 (audyt Enrichment V2, 23.09) — regresja: link odkryty jako wewnętrzny w
// momencie discovery (extractInternalLinks/isRelatedHost na surowym href) mógł
// po 301/302 wylądować na zupełnie obcym hoście, a jego treść i tak trafiała
// do fetchedPages/websiteText -> promptu AI, bo finalUrl (dostępny z
// fetchPageResilient) nigdy nie był sprawdzany w fetchLevel1Candidate/
// fetchLevel2Candidate — w przeciwieństwie do runIdentityFallback, który
// zawsze sprawdzał sameSiteHost(finalUrl, base).
//
// Test jednostkowy (mock axios, zero sieci) przez scrapeWebsiteFast() — realną
// ścieżkę crawla, nie duplikat logiki poza produkcyjnym kodem.

jest.mock('axios');
const axios = require('axios');
const svc = require('../services/prospectEnrichmentService');

const BASE = 'https://good-company.pl';
const FOREIGN_MARKER  = 'TRESC OBCEJ FIRMY PO PRZEJECIU DOMENY';
const RELATED_MARKER  = 'Zespol dobrej firmy — dane kontaktowe pracownikow';
const ONAS_MARKER     = 'O nas — historia dobrej firmy sp z o o';

// Zroznicowany tekst wypelniajacy — cleanText() w extractText() kolapsuje
// ciagi 6+ powtorzonych znakow do jednego, wiec padding z jednego znaku
// (np. "aaaa...") nie licza sie jako realna tresc >100 znakow.
const FILLER_SENTENCES = [
  'Zapraszamy do kontaktu z naszym zespolem sprzedazy w dowolnej sprawie.',
  'Dzialamy na rynku polskim od wielu lat i znamy potrzeby naszych klientow.',
  'Nasza oferta obejmuje szeroki zakres uslug dopasowanych do wymagan biznesu.',
  'Skontaktuj sie z nami telefonicznie lub mailowo, chetnie odpowiemy na pytania.',
].join(' ');

// Padding surowego HTML (poza <body>, wiec nie wplywa na extractText()) >
// SUSPICIOUSLY_SHORT_HTML (500 bajtow) — bez tego fetchPageForCrawl uznaje
// odpowiedz za podejrzanie krotka i retry'uje az do wyczerpania prob
// (niepotrzebnie spowalniajac test o sekundy sleepJittered).
const RAW_HTML_PADDING = '<!-- '.padEnd(600, 'x') + ' -->';

function htmlPage(bodyText) {
  return `<html><head><title>Test</title>${RAW_HTML_PADDING}</head><body><p>${bodyText}</p><p>${FILLER_SENTENCES}</p></body></html>`;
}

function resp({ url, finalUrl, body }) {
  return Promise.resolve({
    status: 200,
    data: htmlPage(body),
    headers: { 'content-type': 'text/html; charset=utf-8' },
    request: { res: { responseUrl: finalUrl || url } },
  });
}

function mockAxios() {
  axios.get.mockImplementation((url) => {
    if (url === BASE || url === `${BASE}/`) {
      return resp({
        url,
        body: `Strona glowna dobrej firmy. <a href="/kontakt">Kontakt</a> <a href="/zespol">Zespol</a> <a href="/o-nas">O nas</a>`,
      });
    }
    if (url === `${BASE}/kontakt`) {
      // Redirect na kompletnie obcy, niepowiazany host (np. wygasla podstrona
      // przejeta przez inny podmiot) — MUSI zostac odrzucone.
      return resp({ url, finalUrl: 'https://totally-unrelated-domain.example/kontakt', body: FOREIGN_MARKER });
    }
    if (url === `${BASE}/zespol`) {
      // Redirect w ramach tej samej domeny rejestrowalnej (www.) — dozwolony
      // related host, tresc MUSI zostac zaakceptowana.
      return resp({ url, finalUrl: 'https://www.good-company.pl/zespol', body: RELATED_MARKER });
    }
    if (url === `${BASE}/o-nas`) {
      // Bez redirectu w ogole — kontrolny "normalny" kandydat.
      return resp({ url, body: ONAS_MARKER });
    }
    return Promise.reject(new Error(`Unexpected axios.get in test: ${url}`));
  });
}

describe('_crawlWebsite (przez scrapeWebsiteFast) — host po redirectcie (H1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxios();
  });

  test('podstrona przekierowana na obcy host jest odrzucona i nie trafia do finalnego tekstu', async () => {
    const result = await svc.scrapeWebsiteFast(BASE);

    expect(result.text).not.toContain(FOREIGN_MARKER);

    const diag = result.diagnostics.find(d => d.url === `${BASE}/kontakt`);
    expect(diag).toBeDefined();
    expect(diag.reason).toBe('other_host');
    expect(diag.included).toBe(false);
  }, 20000);

  test('podstrona przekierowana w ramach related hosta (www.) nadal akceptowana', async () => {
    const result = await svc.scrapeWebsiteFast(BASE);

    expect(result.text).toContain(RELATED_MARKER);
  }, 20000);

  test('podstrona bez redirectu (kontrolna) nadal akceptowana jak dotychczas', async () => {
    const result = await svc.scrapeWebsiteFast(BASE);

    expect(result.text).toContain(ONAS_MARKER);
  }, 20000);
});
