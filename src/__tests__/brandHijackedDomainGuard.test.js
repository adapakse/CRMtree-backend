'use strict';

// Straż klasy "przejęta / wygasła domena" (23.09) w brand fallbacku V3.
//
// KLASA PROBLEMU, nie pojedynczy przypadek: brand fallback przyznaje do 10 pkt
// przy progu 7, ale wszystkie cztery składniki (domainStrong 2, titleMatch 3,
// pagesWithBrand 3, onasKontaktHit 2) wywodzą się z JEDNEGO faktu — obecności
// tokenu marki. Gdy domena nazywa się tak jak firma, token siedzi w domenie
// i w szablonie <title>, a szablon powtarza się na każdej podstronie, więc
// `pagesWithBrand` liczy ten sam dowód wielokrotnie. Skutek: każda żywa strona
// pod domeną zgodną z nazwą firmy przechodzi identity — a to dokładnie profil
// wygasłej domeny przejętej pod SEO (squatter zachowuje nazwę, bo jest
// w domenie).
//
// Straż: token marki musi wystąpić w TREŚCI po ekstrakcji (bez nawigacji,
// nagłówka i stopki), nie tylko w szablonie tytułu. Zero wyjątków dla
// konkretnych domen.
//
// Zmierzone na całym batchu workend_ola_9001-10000 (251 done z potwierdzonym
// identity, 10 przez brand fallback): blokuje 3 rekordy = 1,2% wszystkich done,
// KAŻDY z icp_score = 0. Zachowuje wszystkie wartościowe (70/80/95).

const svc = require('../services/prospectEnrichmentService');
const { evaluateBrandIdentityFallback } = svc;

const COMPANY = { company_name: 'Rafapol sp. z o.o.', nip: '6760120279' };

// Dwie podstrony, na obu marka w boilerplate — tak wygląda przejęta domena:
// nazwa jest w szablonie każdej strony, bo jest w domenie.
const BOILERPLATE_SOURCES = [
  { label: 'homepage', text: `Rafapol ${'tresc o kasynach online '.repeat(120)}` },
  { label: '/o-nas', text: `Rafapol ${'poradnik bonusy i darmowe spiny '.repeat(120)}` },
];

const baseArgs = (contentText) => ({
  company: COMPANY, krsData: null, gusData: null,
  candidateUrl: 'https://www.rafapol.pl',
  candidateSource: 'csv_import',
  homepageTitle: 'Prawdziwe kasyno online | Rafapol – Kasyna Online, Bonusy',
  sources: BOILERPLATE_SOURCES,
  contentText,
});

describe('straż przejętych domen — blokuje markę obecną tylko w szablonie', () => {
  test('REGRESJA: treść bez marki nie przechodzi, mimo 10 pkt scoringu', () => {
    const r = evaluateBrandIdentityFallback(baseArgs('kasyno online bonusy darmowe spiny ruletka '.repeat(60)));
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('insufficient_evidence');
    expect(r.cap_reason).toMatch(/brand_only_in_template/);
    // scoring NADAL liczy 10 pkt — blokuje dopiero straż, nie zmiana progu
    expect(r.points).toBeGreaterThanOrEqual(r.threshold);
  });

  test('jedno wystąpienie marki w treści to za mało (próg: 2)', () => {
    const r = evaluateBrandIdentityFallback(baseArgs(`Rafapol ${'tresc bez nazwy firmy '.repeat(60)}`));
    expect(r.verified).toBe(false);
    expect(r.cap_reason).toMatch(/brand_only_in_template/);
  });
});

describe('straż przejętych domen — nie rusza normalnych stron', () => {
  test('marka w realnej treści przechodzi bez zmian', () => {
    const r = evaluateBrandIdentityFallback(
      baseArgs('Rafapol produkuje opakowania od 1990 roku. Firma Rafapol dostarcza rozwiazania dla przemyslu. '.repeat(15)));
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('brand_verified');
    expect(r.cap_reason).toBeNull();
  });

  test('token trafia do positive_evidence (było undefined — detail.token nie istnieje)', () => {
    const r = evaluateBrandIdentityFallback(
      baseArgs('Rafapol opakowania. Rafapol dla przemyslu. '.repeat(30)));
    expect(r.positive_evidence.token).toBe('rafapol');
  });

  test('brak contentText (wywołanie spoza enrichOne) NIE uruchamia straży', () => {
    const args = baseArgs(undefined);
    const r = evaluateBrandIdentityFallback(args);
    expect(r.verified).toBe(true);
    expect(r.cap_reason).toBeNull();
  });

  test('straż nie jest wrażliwa na wielkość liter ani polskie znaki', () => {
    const r = evaluateBrandIdentityFallback(
      baseArgs('RAFAPOL Sp. z o.o. — łączymy jakość. Rafapol działa w Zabierzowie. '.repeat(20)));
    expect(r.verified).toBe(true);
  });
});

describe('straż przejętych domen — kontrakt wywołania', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'prospectEnrichmentService.js'), 'utf8');

  // raw_sources zawierają nawigację i stopkę, więc marka jest tam ZAWSZE, gdy
  // domena nazywa się jak firma. Straż musi dostać tekst PO ekstrakcji.
  test('enrichOne podaje tekst po ekstrakcji, nie raw_sources', () => {
    const call = SRC.slice(SRC.indexOf('brandFallback = evaluateBrandIdentityFallback({'));
    expect(call.slice(0, 600)).toMatch(/contentText: fastScraped\.text/);
  });

  test('brak wyjątków dla konkretnych domen', () => {
    const fn = SRC.slice(SRC.indexOf('function brandAppearsInContent('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/rafapol|automentel|solphy/i);
  });
});
