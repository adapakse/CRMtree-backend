'use strict';

// Testy regresyjne dla poprawki retrievalu 19.09 (druga tura) — po regresjach
// znalezionych w replayu ETAP 3 (Arpol/partner_dealer_network, Berlinerluft/
// field_sales_team): szerokie wzorce "partner"/"handlow" łapały fałszywie
// istotne strony (artykuły o wydarzeniach branżowych, regulaminy handlowe) i
// wypychały prawdziwy dowód z budżetu 12k. Ta poprawka NIE zawęża z powrotem
// poprawnych fleksyjnych dopasowań (np. "handlowiec"/"handlowcy" nadal łapane
// przez rdzeń "handlow") — tylko dodaje wykluczenia i priorytetyzację jakości.

const svc = require('../services/prospectEnrichmentService');

describe('scoreLinkRelevance — dokumenty prawne nie podbijają "dział handlowy"', () => {
  test('"Ogólne Warunki Handlowe" NIE dostaje boosta z wzorca handlowcy', () => {
    const legalScore = svc.scoreLinkRelevance('/ogolne-warunki-handlowe-agb', 'Ogólne Warunki Handlowe');
    // Prawdziwa strona zespołu/kontaktu musi wyraźnie wygrywać.
    const realPageScore = svc.scoreLinkRelevance('/osobykontaktowe', 'Osoby kontaktowe');
    expect(legalScore).toBeLessThan(realPageScore);
  });

  test('regulamin/polityka prywatności też nie dostają boosta handlowcy', () => {
    expect(svc.scoreLinkRelevance('/regulamin-sprzedazy-handlowej', 'Regulamin')).toBeLessThan(9);
    expect(svc.scoreLinkRelevance('/polityka-prywatnosci', 'Polityka prywatności')).toBeLessThan(9);
  });

  test('poprawne odmiany "handlowiec/handlowcy" (NIE dokument prawny) nadal łapane na wysoki score', () => {
    expect(svc.scoreLinkRelevance('/nasi-handlowcy', 'Nasi handlowcy')).toBeGreaterThanOrEqual(9);
    expect(svc.scoreLinkRelevance('/dzial-handlowy', 'Dział handlowy')).toBeGreaterThanOrEqual(9);
  });
});

describe('scoreLinkRelevance — dwupoziomowe scorowanie "partner"', () => {
  test('dedykowana strona sieci partnerskiej dostaje wysoki (STRONG) score', () => {
    expect(svc.scoreLinkRelevance('/partnerzy', 'Partnerzy')).toBeGreaterThanOrEqual(9);
    expect(svc.scoreLinkRelevance('/zostan-partnerem', 'Zostań partnerem')).toBeGreaterThanOrEqual(9);
    expect(svc.scoreLinkRelevance('/program-partnerski', 'Program partnerski')).toBeGreaterThanOrEqual(9);
  });

  test('fraza o WŁASNEJ sieci handlowej (case Arpol) dostaje wysoki score mimo daty w URL-u', () => {
    expect(svc.scoreLinkRelevance('/spotkanie-partnerow-handlowych-arpol-2025', ''))
      .toBeGreaterThanOrEqual(9);
  });

  test('artykuł o wydarzeniu branżowym osoby trzeciej ("Partner Day") dostaje NISKI (WEAK) score', () => {
    const genetecScore = svc.scoreLinkRelevance('/genetec-partner-day-2026', '');
    const boschScore   = svc.scoreLinkRelevance('/bosch-partner-day-2025', '');
    const strongScore  = svc.scoreLinkRelevance('/partnerzy', 'Partnerzy');
    expect(genetecScore).toBeLessThan(strongScore);
    expect(boschScore).toBeLessThan(strongScore);
  });
});

describe('categorizePage — dokumenty prawne trafiają do kategorii z zerowym budżetem', () => {
  test('"warunki handlowe" kategoryzuje się jako legal_excluded, nie oferta/kontakt', () => {
    expect(svc.categorizePage('/ogolne-warunki-handlowe-agb', 'Ogólne Warunki Handlowe')).toBe('legal_excluded');
  });
  test('regulamin i polityka prywatności też trafiają do legal_excluded', () => {
    expect(svc.categorizePage('/regulamin', 'Regulamin')).toBe('legal_excluded');
    expect(svc.categorizePage('/polityka-prywatnosci', null)).toBe('legal_excluded');
  });
});

describe('categorizePage — nowa kategoria realizacje_przetargi (19.09, ETAP 1)', () => {
  test('/realizacje i /przetargi trafiają do realizacje_przetargi, nie other', () => {
    expect(svc.categorizePage('/realizacje', 'Realizacje')).toBe('realizacje_przetargi');
    expect(svc.categorizePage('/przetargi', 'Przetargi')).toBe('realizacje_przetargi');
  });
  test('referencje i "case study" też trafiają tu, nie do oferta/o_nas_zespol', () => {
    expect(svc.categorizePage('/referencje', 'Referencje')).toBe('realizacje_przetargi');
    expect(svc.categorizePage('/case-studies', 'Case Studies')).toBe('realizacje_przetargi');
  });
});

describe('selectWithinBudget — legal_excluded nigdy nie dostaje budżetu', () => {
  test('strona kategorii legal_excluded ma included_chars=0 niezależnie od score/długości tekstu', () => {
    const pages = [
      { path: '/ogolne-warunki-handlowe-agb', anchor: null, score: 10, text: 'x'.repeat(3000), label: 'Warunki', category: 'legal_excluded' },
    ];
    const { selected, outcomes } = svc.selectWithinBudget(pages, 12000);
    expect(selected.find(p => p.path === '/ogolne-warunki-handlowe-agb')).toBeUndefined();
    expect(outcomes.get('/ogolne-warunki-handlowe-agb').included_chars).toBe(0);
    expect(outcomes.get('/ogolne-warunki-handlowe-agb').reason).toBe('category_budget_exhausted');
  });
});

describe('selectWithinBudget — global_12k_truncation NIEZALEŻNIE od category_budget_exhausted', () => {
  test('strona traci budżet przez globalny limit, mimo że JEJ WŁASNA kategoria miała jeszcze miejsce', () => {
    // /a zjada cały totalLimit=100 w kategorii kontakt_oddzialy (reserved 3000,
    // więc TA kategoria wcale nie jest wyczerpana — dowodzi, że /b trafia w
    // rozróżnienie global_12k_truncation, a nie category_budget_exhausted).
    const pages = [
      { path: '/a', anchor: null, score: 9, text: 'x'.repeat(100), label: 'a', category: 'kontakt_oddzialy' },
      { path: '/b', anchor: null, score: 9, text: 'y'.repeat(50), label: 'b', category: 'o_nas_zespol' },
    ];
    const { outcomes } = svc.selectWithinBudget(pages, 100);

    expect(outcomes.get('/a')).toMatchObject({ included_chars: 100, reason: 'included' });
    expect(outcomes.get('/b')).toMatchObject({ included_chars: 0, reason: 'global_12k_truncation' });
  });
});

describe('selectDiverseCandidates — reprezentacja różnych kategorii przed 3. linkiem tej samej', () => {
  test('5 stron kategorii "partnerzy" nie zajmuje wszystkich miejsc kosztem innych kategorii', () => {
    const candidates = [
      { path: '/spotkanie-partnerow-handlowych-arpol-2025', anchor: null, score: 10, fullHref: 'x' },
      { path: '/genetec-partner-day-2026', anchor: null, score: 9, fullHref: 'x' },
      { path: '/arpol-partnerem-merytorycznym-aviation-future-forum-2025', anchor: null, score: 9, fullHref: 'x' },
      { path: '/bosch-partner-day-2025', anchor: null, score: 9, fullHref: 'x' },
      { path: '/genetec-partner-day-13-14-marca-2025', anchor: null, score: 9, fullHref: 'x' },
      { path: '/kontakt', anchor: 'Kontakt', score: 9, fullHref: 'x' },
      { path: '/o-nas', anchor: 'O nas', score: 8, fullHref: 'x' },
      { path: '/oferta', anchor: 'Oferta', score: 7, fullHref: 'x' },
    ];
    const selected = svc.selectDiverseCandidates(candidates, 4);
    const categories = selected.map(c => c.category);
    const partnerzyCount = categories.filter(c => c === 'partnerzy').length;

    expect(selected.length).toBe(4);
    // Limit różnorodności = 2 na kategorię w pierwszym przebiegu — z 4 miejsc
    // maksymalnie 2 mogą pójść do "partnerzy" w pierwszym przebiegu, więc
    // pozostałe 2 muszą trafić do innych kategorii (kontakt_oddzialy/o_nas_zespol/oferta).
    expect(partnerzyCount).toBeLessThanOrEqual(2);
    expect(new Set(categories).size).toBeGreaterThan(1);
    // Najsilniejsza strona partnerska (prawdziwy dowód) musi się załapać.
    expect(selected.some(c => c.path === '/spotkanie-partnerow-handlowych-arpol-2025')).toBe(true);
  });

  test('gdy kandydatów jest mniej niż limit, wszyscy przechodzą niezależnie od kategorii', () => {
    const candidates = [
      { path: '/kontakt', anchor: 'Kontakt', score: 9, fullHref: 'x' },
      { path: '/o-nas', anchor: 'O nas', score: 8, fullHref: 'x' },
    ];
    const selected = svc.selectDiverseCandidates(candidates, 12);
    expect(selected.length).toBe(2);
  });
});

describe('selectWithinBudget — tie-break: strona z osobami wygrywa remis z formularzem kontaktowym', () => {
  test('/osobykontaktowe i /formularz-kontaktowy: przy tym samym score strona z osobami dostaje budżet PRZED formularzem', () => {
    const pages = [
      { path: '/formularz-kontaktowy', anchor: 'Formularz kontaktowy', score: 10, text: 'x'.repeat(3000), label: 'Formularz', category: 'kontakt_oddzialy' },
      { path: '/osobykontaktowe', anchor: 'Osoby kontaktowe', score: 10, text: 'y'.repeat(1027), label: 'Osoby', category: 'kontakt_oddzialy' },
    ];
    const { selected, outcomes } = svc.selectWithinBudget(pages, 12000);

    const osoby = outcomes.get('/osobykontaktowe');
    const formularz = outcomes.get('/formularz-kontaktowy');

    // Strona z osobami musi dostać CAŁĄ swoją treść (1027 zn.), nie okruchy.
    expect(osoby.included_chars).toBe(1027);
    // Formularz dostaje resztę budżetu kategorii (3000 - 1027), nie odwrotnie.
    expect(formularz.included_chars).toBe(3000 - 1027);

    const osobyIdx = selected.findIndex(p => p.path === '/osobykontaktowe');
    const formularzIdx = selected.findIndex(p => p.path === '/formularz-kontaktowy');
    expect(osobyIdx).toBeLessThan(formularzIdx);
  });

  test('pageRankTieBreakBonus: strony z osobami/zespołem > 0, formularze kontaktowe < 0, zwykły /kontakt neutralny', () => {
    expect(svc.pageRankTieBreakBonus('/osobykontaktowe')).toBeGreaterThan(0);
    expect(svc.pageRankTieBreakBonus('/zespol')).toBeGreaterThan(0);
    expect(svc.pageRankTieBreakBonus('/dzial-sprzedazy')).toBeGreaterThan(0);
    expect(svc.pageRankTieBreakBonus('/formularz-kontaktowy')).toBeLessThan(0);
    expect(svc.pageRankTieBreakBonus('/contact-form')).toBeLessThan(0);
    expect(svc.pageRankTieBreakBonus('/kontakt')).toBe(0);
  });
});
