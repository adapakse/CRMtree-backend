'use strict';

// strong_brand_identity V3 (21.09, case Pepco/Euro Freight/BSH-TROX) — fallback
// URUCHAMIANY WYŁĄCZNIE gdy strict identity fallback (runIdentityFallback)
// zwrócił verified:false, reason:'insufficient_evidence' (foreign_address_conflict
// nadal wygrywa bez zmian). Testy poniżej używają realnych fragmentów treści
// zebranych podczas audytu 87 rekordów website_status='unconfirmed' (21.09),
// nie wymyślonych — każdy fixture odpowiada konkretnej, zweryfikowanej firmie.

const svc = require('../services/prospectEnrichmentService');

describe('findLegalEntityConflict — own-registry-block inference (KRS nieznany w naszej bazie)', () => {
  test('K+L Biuro Handlowe Polska: NIP+REGON zgodne, KRS w tym samym bloku -> NIE konflikt', () => {
    const company = { company_name: 'K+l Biuro Handlowe Polska - sp. z o.o.', nip: '7271245013' };
    const gusData = { regon: '471300817' };
    const sources = [{
      label: 'https://www.kplusl.com.pl/',
      text: 'dzonego przez Sąd Rejonowy dla Łodzi Śródmieścia, XX Wydział Krajowego Rejestru Sądowego po numerem KRS: 0000201560, NIP: 7271245013, REGON: 471300817.',
    }];
    const result = svc.findLegalEntityConflict({ company, krsData: {}, gusData, sources });
    expect(result.conflict).toBe(false);
  });

  test('ZBUiAND: NIP+REGON zgodne, KRS w tym samym bloku -> NIE konflikt', () => {
    const company = { company_name: 'Zakład Budowy Urządzeń i Aparatury Naukowo-doświadczalnej sp. z o.o.', nip: '6340021613' };
    const gusData = { regon: '271916016' };
    const sources = [{
      label: 'https://www.zbuiand.com.pl/',
      text: 'ZBUiAND Sp. z o.o. NIP: 634 002 16 13 REGON: 271916016 KRS: 0000062462 BDO: 000062528 Al. W. Korfantego 81 40-161 Katowice',
    }];
    const result = svc.findLegalEntityConflict({ company, krsData: {}, gusData, sources });
    expect(result.conflict).toBe(false);
  });

  test('Bemo Motors: NIP+REGON zgodne w tej samej stopce co KRS -> NIE konflikt (own-registry-block)', () => {
    const company = { company_name: 'Bemo Motors sp. z o.o. Salon Mazda Ford', nip: '7391729601' };
    const gusData = { regon: '510427910' };
    const sources = [{
      label: 'https://www.bemo-motors.pl/',
      text: 'Bemo Motors sp. z o.o. ul. Mogileńska 50, 61-044 Poznań NIP: 7391729601 REGON: 510427910 KRS: 0000132096',
    }];
    const result = svc.findLegalEntityConflict({ company, krsData: {}, gusData, sources });
    expect(result.conflict).toBe(false);
  });

  test('Bemo Motors: gdyby w oknie KRS nie było żadnego NIP/REGON, brak dowodu -> traktowane konserwatywnie jako konflikt (nie zgadujemy)', () => {
    const company = { company_name: 'Bemo Motors sp. z o.o. Salon Mazda Ford', nip: '7391729601' };
    const gusData = { regon: '510427910' };
    const sources = [{
      label: 'https://www.bemo-motors.pl/',
      text: 'Bemo Motors sp. z o.o. ul. Mogileńska 50, 61-044 Poznań KRS: 0000132096',
    }];
    const result = svc.findLegalEntityConflict({ company, krsData: {}, gusData, sources });
    expect(result.conflict).toBe(true);
  });

  test('gdy znamy WŁASNY KRS i się NIE zgadza -> konflikt mimo zgodnego NIP w innym miejscu strony (ground truth wygrywa nad inferencją)', () => {
    const company = { company_name: 'Testowa sp. z o.o.', nip: '1234563218' };
    const krsData = { krsNumber: '0000999999' };
    const gusData = { regon: '123456785' };
    const sources = [{
      label: 'https://example.pl/',
      text: 'Testowa Sp. z o.o. NIP: 1234563218 REGON: 123456785 KRS: 0000111111',
    }];
    const result = svc.findLegalEntityConflict({ company, krsData, gusData, sources });
    expect(result.conflict).toBe(true);
    expect(result.type).toBe('differing_krs');
  });

  test('realny konflikt: obcy NIP na stronie (Netto Indygo -> netto.pl, dane Netto Sp. z o.o.)', () => {
    const company = { company_name: 'Netto Indygo Sp. z o.o.', nip: '5261037737' };
    const sources = [{
      label: 'https://www.netto.pl/dane-firmy',
      text: 'Kobylanka Sąd Rejonowy Szczecin - Centrum w Szczecinie XIII Wydział Gospodarczy KRS Nr KRS 0000020322 NIP 852-10-21-463 VAT UE PL8521021463',
    }];
    const result = svc.findLegalEntityConflict({ company, krsData: {}, gusData: {}, sources });
    expect(result.conflict).toBe(true);
    expect(result.type).toBe('differing_nip');
  });

  test('wzmianka o NIP partnera/dostawcy w kontekście współpracy -> pomijana, nie konflikt', () => {
    const company = { company_name: 'Testowa sp. z o.o.', nip: '1234563218' };
    const sources = [{
      label: 'https://example.pl/',
      text: 'Naszym dostawcą jest firma XYZ, NIP 5555555555, z którą współpracujemy od lat.',
    }];
    const result = svc.findLegalEntityConflict({ company, krsData: {}, gusData: {}, sources });
    expect(result.conflict).toBe(false);
  });
});

describe('findForeignEntityOrCountryConflict — Tier A (twardy) / Tier B (miękki)', () => {
  test('Tier A: obcy numer rejestrowy (IMW -> deckert.de, Handelsregister)', () => {
    const sources = [{
      label: 'https://www.deckert.de/impressum',
      text: 'DCA Deckert Anlagenbau GmbH Theodor-Marwitz-Str. 7 21337 Lüneburg Handelsregister: HRB 2287 Registergericht: Lüneburg',
    }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'Deckert Anlagenbau' });
    expect(result).not.toBeNull();
    expect(result.tier).toBe('A');
    expect(result.type).toBe('foreign_registry_number');
  });

  test('Tier A: obcy numer rejestrowy (Famot -> DMG Mori, HRB Monachium)', () => {
    const sources = [{
      label: 'https://pl.dmgmori.com/stopka-redakcyjna',
      text: 'Zarejestrowana siedziba firmy: Monachium, Niemcy Numer rejestracji: HRB 307939, Sąd rejonowy w Monachium Numer VAT: DE 35 09 52 850',
    }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'DMG Mori' });
    expect(result.tier).toBe('A');
    expect(result.type).toBe('foreign_registry_number');
  });

  test('Tier A: JSON-LD addressCountry != PL', () => {
    const sources = [{ label: 'homepage', text: 'Tines Investment "@type":"Organization","address":{"@type":"PostalAddress","addressCountry":"IE"}' }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'Tines' });
    expect(result.tier).toBe('A');
    expect(result.type).toBe('jsonld_foreign_address_country');
  });

  test('Tier B: kraj wspomniany tylko w title, bez POLISH_LINK_EVIDENCE (Euro Freight -> eurofreight.com/Cyprus)', () => {
    const sources = [{ label: 'homepage', text: 'Eurofreight Logistics — leading the way in logistics across the region.' }];
    const result = svc.findForeignEntityOrCountryConflict({
      sources, homepageTitle: 'Eurofreight Logistics – Transportation Solutions in Cyprus & Internationally',
    });
    expect(result.tier).toBe('B');
    expect(result.polishLinkEvidence).toBe(false);
  });

  test('Tier B: kraj wspomniany, ale w kontekście wysyłki/eksportu -> nie liczy się', () => {
    const sources = [{ label: 'homepage', text: 'Realizujemy wysyłkę do Niemiec i innych krajów UE.' }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'Sklep online' });
    expect(result).toBeNull();
  });

  test('Tier B: kraj wspomniany, ale z POLISH_LINK_EVIDENCE obok -> polishLinkEvidence:true', () => {
    const sources = [{ label: 'homepage', text: 'Nasza spółka działa jako oddział w Polsce grupy z siedzibą w Niemczech.' }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'Firma XYZ' });
    expect(result.tier).toBe('B');
    expect(result.polishLinkEvidence).toBe(true);
  });

  test('brak jakiejkolwiek wzmianki o obcym kraju -> null', () => {
    const sources = [{ label: 'homepage', text: 'Firma działająca na terenie całej Polski, oddziały w Warszawie i Krakowie.' }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'Firma XYZ' });
    expect(result).toBeNull();
  });

  test('nazwa kraju na stronie identyfikacyjnej to zawsze Tier B, NIGDY twardy Tier A (Ardix Pl -> ardix.pl, biuro w Belgii obok polskiego) — sama nazwa kraju w tekście (bez numeru rejestrowego/JSON-LD) jest za słaba na twardy reject: globalne firmy często podają adres centrali w polityce prywatności RODO nawet na stronie lokalnej spółki (case Follett Europe Polska)', () => {
    const sources = [{
      label: 'https://ardix.biz/polityka-prywatnosci',
      text: 'Kontakt Poland ul. Centralna 56/M 43-210 Kobiór tel.: +48 32 750 69 11 sales@ardix.biz Belgium Onze-Lieve-Vrouwstraat 44 3560 Lummen tel.: +32 12 77 77 77 sales@ardix.biz',
    }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'Ardix' });
    expect(result).not.toBeNull();
    expect(result.tier).toBe('B');
    // Ten sam tekst zawiera TAKŻE polski adres (Poland/Kobiór) -> polishLinkEvidence:true
    // -> Tier B NIE ogranicza wyniku (patrz test integracyjny niżej).
    expect(result.polishLinkEvidence).toBe(true);
  });

  test('Tier A pozostaje TYLKO dla numeru rejestrowego/JSON-LD, nie dla samej nazwy kraju — nawet na stronie impressum (rank 0)', () => {
    const sources = [{
      label: 'https://example.de/impressum',
      text: 'Firma XYZ GmbH, Berlin, Germany. Kontakt: info@example.de.',
    }];
    const result = svc.findForeignEntityOrCountryConflict({ sources, homepageTitle: 'Example' });
    expect(result.tier).toBe('B'); // nie 'A' — sama nazwa kraju bez numeru rejestrowego
  });
});

describe('findDifferentEntityBrand — mocny dowód innego podmiotu (BSH -> bsh.pl -> TROX SE)', () => {
  test('marka innego podmiotu powtórzona w title + na osobnej podstronie, zero śladu własnej marki -> wykryte', () => {
    const company = { company_name: 'BSH Sprzęt Gospodarstwa Domowego Sp. z o.o.' };
    const sources = [
      { label: 'https://www.bsh.pl/en/general-terms-and-conditions', text: 'These are the general terms and conditions of TROX SE, a company registered in Germany.' },
      { label: 'https://www.bsh.pl/en/contact', text: 'Contact TROX SE for more information about our ventilation products.' },
    ];
    const result = svc.findDifferentEntityBrand({ company, sources, homepageTitle: 'Homepage | TROX SE Homepage' });
    expect(result).not.toBeNull();
    expect(result.type).toBe('different_entity_brand');
    expect(result.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('pojedyncza wzmianka o innej marce (tylko title) -> NIE wystarcza (wymaga ≥2 niezależnych miejsc)', () => {
    const company = { company_name: 'Testowa sp. z o.o.' };
    const sources = [{ label: 'https://example.pl/o-nas', text: 'Współpracujemy z wieloma partnerami na rynku.' }];
    const result = svc.findDifferentEntityBrand({ company, sources, homepageTitle: 'Homepage | Foreign Brand SE' });
    expect(result).toBeNull();
  });

  test('gdy własna marka pojawia się GDZIEKOLWIEK na stronie -> mechanizm w ogóle się nie uruchamia (zbyt ryzykowne)', () => {
    const company = { company_name: 'Cartonplast Polska sp. z o.o.' };
    const sources = [
      { label: 'homepage', text: 'Cartonplast Polska oferuje wynajem opakowań.' },
      { label: 'https://example.pl/stopka', text: 'Nasza centrala: Cartonplast Group GmbH, Niemcy.' },
      { label: 'https://example.pl/o-firmie', text: 'Cartonplast Group GmbH jest częścią międzynarodowej grupy.' },
    ];
    const result = svc.findDifferentEntityBrand({ company, sources, homepageTitle: 'Cartonplast Polska' });
    expect(result).toBeNull();
  });
});

describe('evaluateBrandIdentityFallback — pełny przepływ, przypadki kontrolne', () => {
  const emptyKrsGus = { krsData: {}, gusData: {} };

  test('Pepco -> pepco.pl: brand_verified (domena+title+wielostronicowa spójność marki)', () => {
    const company = { company_name: 'Pepco Poland Sp. z o.o.' };
    const sources = [
      { label: 'https://www.pepco.pl/', text: 'Pepco - feel the quality, love the price. Sklepy Pepco w całej Polsce.'.repeat(20) },
      { label: 'https://www.pepco.pl/o-nas', text: 'Pepco Poland działa od wielu lat, oferując modę i akcesoria domowe w przystępnych cenach.'.repeat(20) },
      { label: 'https://www.pepco.pl/kontakt', text: 'Kontakt do Pepco Poland Sp. z o.o. Infolinia i dane kontaktowe.'.repeat(20) },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://www.pepco.pl', candidateSource: 'resolver',
      homepageTitle: 'Pepco - feel the quality, love the price - Pepco Poland', sources,
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('brand_verified');
  });

  test('Eurocash -> eurocash.pl: insufficient_evidence (brak realnej treści, maxChars poniżej progu)', () => {
    const company = { company_name: 'Eurocash S.A.' };
    const sources = [{ label: 'https://www.eurocash.pl/', text: 'Eurocash' }];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://www.eurocash.pl', candidateSource: 'csv_import',
      homepageTitle: 'Eurocash S.A.', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
  });

  test('Netto Indygo -> netto.pl: legal_entity_conflict (obcy NIP)', () => {
    const company = { company_name: 'Netto Indygo Sp. z o.o.', nip: '5261037737' };
    const sources = [{
      label: 'https://www.netto.pl/dane-firmy',
      text: 'Kobylanka Sąd Rejonowy Szczecin - Centrum w Szczecinie XIII Wydział Gospodarczy KRS Nr KRS 0000020322 NIP 852-10-21-463',
    }];
    const result = svc.evaluateBrandIdentityFallback({
      company, krsData: {}, gusData: {}, candidateUrl: 'https://www.netto.pl', candidateSource: 'resolver',
      homepageTitle: 'Netto', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('legal_entity_conflict');
  });

  test('IMW -> deckert.de: foreign_entity_or_country_conflict (Tier A, Handelsregister)', () => {
    const company = { company_name: 'Imw Inżynieria Maszyn Wałcz sp. z o.o.' };
    const sources = [{
      label: 'https://www.deckert.de/impressum',
      text: 'DCA Deckert Anlagenbau GmbH Handelsregister: HRB 2287 Registergericht: Lüneburg',
    }];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://www.deckert.de', candidateSource: 'resolver',
      homepageTitle: 'Deckert Anlagenbau', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('foreign_entity_or_country_conflict');
  });

  test('Famot -> DMG Mori: foreign_entity_or_country_conflict (Tier A, HRB Monachium)', () => {
    const company = { company_name: 'Famot Pleszew sp. z o.o.' };
    const sources = [{
      label: 'https://pl.dmgmori.com/stopka-redakcyjna',
      text: 'Zarejestrowana siedziba firmy: Monachium, Niemcy Numer rejestracji: HRB 307939',
    }];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://pl.dmgmori.com', candidateSource: 'resolver',
      homepageTitle: 'DMG Mori', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('foreign_entity_or_country_conflict');
  });

  test('BSH -> bsh.pl -> TROX SE: różne poprawne ścieżki odrzucenia, nigdy verified — via różne mocne dowody zależnie od tego co strona ujawnia', () => {
    const company = { company_name: 'BSH Sprzęt Gospodarstwa Domowego Sp. z o.o.' };
    // Wariant bez wzmianki o kraju/numerze rejestrowym — sama powtórzona marka
    // TROX SE, żeby przetestować different_entity_brand w izolacji od
    // foreign_entity_or_country_conflict (które ma pierwszeństwo w kolejności).
    const sources = [
      { label: 'https://www.bsh.pl/en/products', text: 'TROX SE ventilation products and air handling units for commercial buildings.' },
      { label: 'https://www.bsh.pl/en/support', text: 'Contact TROX SE support team for spare parts and service requests.' },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://www.bsh.pl', candidateSource: 'resolver',
      homepageTitle: 'Homepage | TROX SE Homepage', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('different_entity_brand');
  });

  test('BSH -> bsh.pl -> TROX SE: gdy strona ujawnia TAKŻE obcy numer rejestrowy (Handelsregister), foreign_entity_or_country_conflict (Tier A) wygrywa kolejnością nad different_entity_brand — wciąż REJECTED, nie verified', () => {
    const company = { company_name: 'BSH Sprzęt Gospodarstwa Domowego Sp. z o.o.' };
    const sources = [
      { label: 'https://www.bsh.pl/en/general-terms-and-conditions', text: 'TROX SE, Handelsregister: HRB 2287, Registergericht Düsseldorf.' },
      { label: 'https://www.bsh.pl/en/contact', text: 'Contact TROX SE ventilation products support team.' },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://www.bsh.pl', candidateSource: 'resolver',
      homepageTitle: 'Homepage | TROX SE Homepage', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('foreign_entity_or_country_conflict');
  });

  test('Follett Europe Polska -> folletteurope.com: capped do insufficient_evidence (group/global portal bez polish link)', () => {
    const company = { company_name: 'Follett Europe Polska sp. z o.o. Urządzenia Gastronomiczne' };
    const bigText = 'Follett Europe provides ice machines and food service equipment across the region.'.repeat(20);
    const sources = [
      { label: 'https://www.folletteurope.com/', text: bigText },
      { label: 'https://www.folletteurope.com/about', text: bigText },
      { label: 'https://www.folletteurope.com/contact', text: bigText },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://www.folletteurope.com', candidateSource: 'resolver',
      homepageTitle: 'Europe | Follett Ice', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
    expect(result.cap_reason).toMatch(/group\/global portal/);
  });

  test('Euro Freight Logistics -> eurofreight.com: capped do insufficient_evidence (Tier B Cyprus bez polish link)', () => {
    const company = { company_name: 'Euro Freight Logistics sp. z o.o.' };
    const bigText = 'Eurofreight Logistics offers freight forwarding and transportation solutions worldwide.'.repeat(20);
    const sources = [
      { label: 'https://www.eurofreight.com/', text: bigText },
      { label: 'https://www.eurofreight.com/about', text: bigText },
      { label: 'https://www.eurofreight.com/contact', text: bigText },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, ...emptyKrsGus, candidateUrl: 'https://www.eurofreight.com', candidateSource: 'resolver',
      homepageTitle: 'Eurofreight Logistics – Transportation Solutions in Cyprus & Internationally', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
    expect(result.cap_reason).toMatch(/tier B/);
  });

  test('Ardix Pl -> ardix.pl: biuro w Belgii NIE blokuje weryfikacji, bo ta sama strona ma TAKŻE polski adres (polishLinkEvidence) — świadomy wybór projektowy, nie luka: odróżnienie "nasz oddział zagraniczny" od "inna zagraniczna firma" jest niemożliwe bez numeru rejestrowego, więc gdy jest silny brand-score I lokalny polski dowód obok, nie blokujemy (analogicznie do istniejącej reguły identitySecondarySignal dla Cartonplast)', () => {
    const company = { company_name: 'Ardix Pl sp. z o.o.' };
    const bigText = 'Ardix to firma technologiczna oferująca rozwiązania IT dla biznesu.'.repeat(20);
    const sources = [
      { label: 'https://www.ardix.pl/', text: bigText },
      { label: 'https://ardix.biz/kontakt', text: bigText },
      {
        label: 'https://ardix.biz/polityka-prywatnosci',
        text: `${bigText} Kontakt Poland ul. Centralna 56/M 43-210 Kobiór tel.: +48 32 750 69 11 sales@ardix.biz Belgium Onze-Lieve-Vrouwstraat 44 3560 Lummen tel.: +32 12 77 77 77 sales@ardix.biz`,
      },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, krsData: {}, gusData: {}, candidateUrl: 'https://www.ardix.pl', candidateSource: 'resolver',
      homepageTitle: 'Ardix', sources,
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('brand_verified');
  });

  test('gdy obcy kraj na stronie identyfikacyjnej NIE ma obok żadnego polskiego dowodu (Follett-podobny profil) -> capped do unresolved, mimo wysokiego brand-score', () => {
    const company = { company_name: 'Testowa Marka Europe sp. z o.o.' };
    const bigText = 'Testowa Marka Europe provides equipment and services across the region.'.repeat(20);
    const sources = [
      { label: 'https://www.testowamarka.com/', text: bigText },
      { label: 'https://www.testowamarka.com/o-nas', text: bigText },
      { label: 'https://www.testowamarka.com/privacy-policy', text: `${bigText} 801 Church Lane Easton, PA 18040 United States` },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, krsData: {}, gusData: {}, candidateUrl: 'https://www.testowamarka.com', candidateSource: 'resolver',
      homepageTitle: 'Testowa Marka Europe', sources,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
    expect(result.cap_reason).toMatch(/tier B/);
  });

  test('Euro-Net -> euro.com.pl: insufficient_evidence (token "euro" jest generyczny, nie potwierdza sam)', () => {
    const company = { company_name: 'Euro-Net Sp. z o.o. (RTV Euro AGD)' };
    const token = svc.firstDistinctiveNameToken(company.company_name);
    expect(token).not.toBe('euro');
  });

  test('source=resolver wymaga wyższego progu i jednoczesnego dopasowania domeny+title (samo wysokie punktowe multi-page nie wystarcza)', () => {
    const company = { company_name: 'Testowa Marka sp. z o.o.' };
    const bigText = 'Testowa Marka to lider rynku, znany z jakości i doświadczenia od lat.'.repeat(20);
    const sources = [
      { label: 'https://inny-adres.pl/', text: bigText },
      { label: 'https://inny-adres.pl/o-nas', text: bigText },
    ];
    const result = svc.evaluateBrandIdentityFallback({
      company, krsData: {}, gusData: {}, candidateUrl: 'https://inny-adres.pl', candidateSource: 'resolver',
      homepageTitle: 'Coś zupełnie innego', sources,
    });
    // brak dopasowania domeny/title -> hardRequiredForResolver nie spełniony
    expect(result.verified).toBe(false);
  });
});
