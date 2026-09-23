'use strict';

// Targeted test etapu 4 (23.09) — przekierowania wykonywane po stronie klienta.
//
// Etap był pierwotnie zaplanowany jako "ekstrakcja danych z SPA bez headless".
// Pomiar na trzech realnych "cienkich" stronach z audytu 47 firm pokazał, że
// ŻADNA z nich nie jest SPA — zero __NEXT_DATA__, __NUXT__, JSON-LD i
// <div id="root">. Realna przyczyna to przekierowanie w dokumencie:
//   futrex.com.pl  → <META HTTP-EQUIV="Refresh" CONTENT="0;URL=http://poczta.futrex.com.pl">
//   mieszko.com    → <script>window.onload=function(){window.location.href="/lander"}</script>
// (trzeci przypadek, habitatinvest.pl, to interstitial antybotowy wymagający
// wykonania JS — poza zasięgiem bez headless, patrz raport etapu 4.)
//
// Stary kod widział "HTTP 200, za mało treści" i ponawiał TEN SAM adres,
// dostając za każdym razem ten sam kilkudziesięciobajtowy dokument.

const svc = require('../services/prospectEnrichmentService');
const { extractClientSideRedirect } = svc;

const BASE = 'http://futrex.com.pl/';

describe('etap 4 — extractClientSideRedirect: realne przypadki', () => {
  test('meta refresh (Futrex) — bezwzględny URL na innej subdomenie', () => {
    const html = '<META HTTP-EQUIV="Refresh" CONTENT="0;URL=http://poczta.futrex.com.pl">';
    expect(extractClientSideRedirect(html, BASE)).toBe('http://poczta.futrex.com.pl/');
  });

  test('window.location.href (Mieszko) — ścieżka względna rozwijana wobec base', () => {
    const html = '<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>';
    expect(extractClientSideRedirect(html, 'http://mieszko.com/')).toBe('http://mieszko.com/lander');
  });

  test.each([
    ['meta refresh z odstępami i wielkimi literami', '<meta http-equiv="REFRESH" content="0; URL=https://nowa.pl/start">', 'https://nowa.pl/start'],
    ['location bez window.', '<script>location.href = "https://nowa.pl/x";</script>', 'https://nowa.pl/x'],
    ['location bez .href', '<script>window.location="https://nowa.pl/y"</script>', 'https://nowa.pl/y'],
  ])('%s', (_l, html, expected) => {
    expect(extractClientSideRedirect(html, BASE)).toBe(expected);
  });
});

describe('etap 4 — granice (żeby nie gonić normalnej nawigacji)', () => {
  // KLUCZOWE ograniczenie zakresu: na dużej, normalnej stronie window.location
  // w kodzie to zwykła nawigacja (menu, przycisk), a nie przekierowanie
  // całego dokumentu. Śledzenie tego wyprowadzałoby crawler w losowe miejsca.
  test('REGRESJA: długi dokument NIE jest traktowany jak przekierowanie', () => {
    const html = `${'<p>realna treść firmy</p>'.repeat(200)}<script>window.location.href="/promocja"</script>`;
    expect(html.length).toBeGreaterThan(1000);
    expect(extractClientSideRedirect(html, BASE)).toBeNull();
  });

  test.each([
    ['javascript:', '<script>window.location.href="javascript:void(0)"</script>'],
    ['mailto:', '<meta http-equiv="refresh" content="0;URL=mailto:biuro@firma.pl">'],
  ])('nie śledzi protokołu innego niż http(s): %s', (_l, html) => {
    expect(extractClientSideRedirect(html, BASE)).toBeNull();
  });

  test('nie śledzi skoku na samego siebie (inaczej pętla)', () => {
    expect(extractClientSideRedirect(`<script>location.href="${BASE}"</script>`, BASE)).toBeNull();
  });

  test('krótki dokument bez przekierowania → null (zachowanie sprzed etapu 4)', () => {
    expect(extractClientSideRedirect('<html><body>Wkrótce.</body></html>', BASE)).toBeNull();
  });

  test('nie-string (np. bufor/JSON) → null, bez rzucania', () => {
    expect(extractClientSideRedirect(null, BASE)).toBeNull();
    expect(extractClientSideRedirect({ a: 1 }, BASE)).toBeNull();
  });
});

describe('etap 4 — KLASYFIKACJA, nie sledzenie', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'prospectEnrichmentService.js'), 'utf8');

  // Pierwsza wersja etapu 4 skakala pod adres docelowy. Pomiar na 17 firmach:
  // cel to lander parkingu (/lander) albo webmail (poczta.*), crawler
  // przyjmowal go za effectiveBase i zgadywal tam /kontakt, /o-nas, dostajac
  // 403 z retry Level 2 — Futrex urosl z ~11 s do 68 s, zwrocil 62 znaki
  // smieci, i ani jeden rekord nie zyskal `done`. Zmiana zostala cofnieta.
  test('REGRESJA: pętla fetch NIE podąża za przekierowaniem', () => {
    expect(SRC).not.toMatch(/currentUrl = redirectTarget/);
    expect(SRC).not.toMatch(/MAX_CLIENT_REDIRECT_HOPS/);
  });

  test('krótki dokument z przekierowaniem nie zużywa retry na ten sam adres', () => {
    const loop = SRC.slice(SRC.indexOf('const redirectTarget = extractClientSideRedirect'));
    const head = loop.slice(0, 400);
    expect(head).toMatch(/if \(redirectTarget\) \{/);
    expect(head).toMatch(/clientSideRedirectTo: redirectTarget/);
  });

  test('strona wejściowa złożona z samego przekierowania kończy jako deterministyczna porażka', () => {
    expect(SRC).toMatch(/deterministicFailure: \{ type: 'client_side_redirect_only'/);
    expect(SRC).toMatch(/reason: 'client_side_redirect_only'/);
  });

  // Dokument bedacy samym przekierowaniem ma <1000 znakow, wiec lapie sie na
  // regule kwalifikujacej do Level 2. Bez tych dwoch strazy Level 2 zwracal
  // ten sam stub JUZ BEZ klasyfikacji i rekord wracal do needs_review.
  test('REGRESJA: Level 2 nie gubi klasyfikacji przekierowania', () => {
    const fn = SRC.slice(SRC.indexOf('async function fetchPageResilient('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/if \(level1\.clientSideRedirectTo\) return level1;/);
    expect(body).toMatch(/redirectTarget \? \{ \.\.\.level2, clientSideRedirectTo: redirectTarget \}/);
  });

  // Dzieki temu rekord trafia do fallbacku domenowego z etapu 2 i konczy jako
  // `no_website` zamiast wisiec w needs_review z zerem znakow i bez powodu.
  test('client_side_redirect_only liczy się jako potwierdzona martwa domena', () => {
    const fn = SRC.slice(SRC.indexOf('function isConfirmedDeadDomain('));
    expect(fn.slice(0, 900)).toMatch(/type === 'client_side_redirect_only'\) return true;/);
  });
});
