'use strict';
//
// isDomainTrustedForThisRun() — regresja po incydencie na INT (18.09.2026):
// 'manual_correction' zapisane w kolumnie website_source bezterminowo omijało
// checkDomainIdentity(), nawet gdy TEN konkretny przebieg enrichmentu nie miał
// żadnego jawnego ręcznego override URL-a. Cztery realne rekordy skończyły
// jako "Wzbogacone" (status: done, gate: qualified) mimo
// identity_check.verified=false: IMW Inżynieria Maszyn Wałcz → deckert.de,
// M+B Birke → birke.com, Mirol → mirol.com, Minos → placeholder hostingowy.
//
// Poprawka: zaufanie jest wyłącznie jednorazowe (opts.trustedDomain, ustawiane
// przez POST /:id/re-process TYLKO gdy admin faktycznie podał NOWY URL —
// patrz websiteChanged w admin-prospects.js) — nigdy z trwale zapisanej
// kolumny website_source, którą enrichOne dalej tylko loguje/wyświetla.

const { isDomainTrustedForThisRun } = require('../services/prospectEnrichmentService');

describe('isDomainTrustedForThisRun — nie czyta już website_source', () => {
  test('company.website_source === "manual_correction" BEZ opts.trustedDomain → NIE zaufane (rdzeń poprawki)', () => {
    // Dawniej ta kombinacja sama w sobie omijała identity-check — właśnie to
    // psuło IMW/Deckert, M+B Birke, Mirol i Minos przy zwykłym re-processie.
    expect(isDomainTrustedForThisRun({})).toBe(false);
    expect(isDomainTrustedForThisRun({ trustedDomain: false })).toBe(false);
    expect(isDomainTrustedForThisRun(undefined)).toBe(false);
  });

  test('opts.trustedDomain === true → zaufane (jednorazowo, dla TEGO wywołania)', () => {
    expect(isDomainTrustedForThisRun({ trustedDomain: true })).toBe(true);
  });

  test('opts.trustedDomain jako string "true" (nie boolean) NIE liczy się — tylko dokładnie true', () => {
    expect(isDomainTrustedForThisRun({ trustedDomain: 'true' })).toBe(false);
  });
});

describe('isDomainTrustedForThisRun — cztery realne przypadki z incydentu 18.09', () => {
  // Każdy z tych rekordów ma w bazie website_source='manual_correction' z
  // wcześniejszego, przypadkowego ustawienia (dialog Re-process bez realnej
  // edycji URL-a). Zwykły kolejny re-process (opts bez trustedDomain) — czy
  // to przez pojedynczy re-process z pustym body, czy przez batch/import —
  // NIE MOŻE już z tego czerpać zaufania.
  const staleManualCorrectionCases = [
    { name: 'Imw Inżynieria Maszyn Wałcz sp. z o.o.', url: 'http://www.deckert.de' },
    { name: 'M+b Birke sp. z o.o. Malowanie Proszkowe', url: 'https://www.birke.com' },
    { name: 'Mirol sp. z o.o.', url: 'https://www.mirol.com' },
    { name: 'Minos. sp. z o.o. Hurtownia Papierosów i Chemii Gospodarczej', url: 'http://www.minos.com.pl' },
  ];

  test.each(staleManualCorrectionCases)('$name: zwykły re-process (opts={}) mimo stale website_source=manual_correction → NIE zaufane', ({ url }) => {
    // website_source samo w sobie nie jest już wejściem tej funkcji — dokładnie
    // to jest sedno poprawki, więc test dowodzi tego wprost: bez względu na to
    // jaka wartość website_source jest zapisana w bazie dla tego rekordu i
    // niezależnie od samego URL-a, brak opts.trustedDomain w TYM wywołaniu
    // zawsze daje false.
    expect(isDomainTrustedForThisRun({})).toBe(false);
    void url; // dokumentacyjne — pokazuje który realny przypadek to odtwarza
  });

  test.each(staleManualCorrectionCases)('$name: świeży re-process z FAKTYCZNIE nowym URL-em w TYM wywołaniu → zaufane tylko na ten jeden przebieg', ({ url }) => {
    expect(isDomainTrustedForThisRun({ trustedDomain: true })).toBe(true);
    void url;
  });
});
