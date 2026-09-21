'use strict';
//
// checkDomainIdentity() — regresja po audycie INT (18.09.2026):
//
// 1. GENERIC_NAME_WORDS/GENERIC_NAME_STEMS — opisowe człony typu
//    "produkcyjno-handlowe" nie mogą być wybierane jako "najbardziej
//    charakterystyczne słowo" firmy zamiast właściwej marki (case: Mirex —
//    trafienie adresowe 1:1, ale nameHit padał na "produkcyjno").
// 2. Silne, PODWÓJNE trafienie adresowe (kod pocztowy + ulica jednocześnie)
//    ma wystarczać samo, bez dopasowania nazwy — dla firm po rebrandingu,
//    gdzie title strony już nie dzieli żadnego tokenu z nazwą rejestrową
//    (case: "Musi Novum" → "Hunters Novum").
//
// Obie zmiany nie mogą osłabić ochrony przed znanymi złymi dopasowaniami
// domeny (Mirol → Argentyna, IMW Inżynieria Maszyn Wałcz → Deckert/Niemcy).

const { checkDomainIdentity } = require('../services/prospectEnrichmentService');

const gus = (postcode, street) => ({ postcode, street });

describe('checkDomainIdentity — GENERIC_NAME_STEMS (fix 1)', () => {
  test('Mirex: "Produkcyjno-handlowe" nie przykrywa marki — słaby dowód (sam postcode) + poprawny nameHit', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Specjaliści od szkła — Mirex. Adres: 76-251 Słupsk.',
      title: 'Mirex Specjaliści od szkła',
      company: { company_name: "Przedsiębiorstwo Produkcyjno-handlowe 'Mirex' sp. z o.o." },
      krsData: null,
      gusData: gus('76-251', null),
    });
    expect(result.nameHit).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('name_plus_registry_address');
  });

  test('wariant: "Usługowo Produkcyjne" nie przykrywa marki (case: Novum)', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Novum — ochrona, sprzątanie, szwalnia. Adres: 96-300 Żyrardów.',
      title: 'Novum ochrona i sprzątanie',
      company: { company_name: "Przedsiębiorstwo Usługowo Produkcyjne 'Novum' sp. z o.o." },
      krsData: null,
      gusData: gus('96-300', null),
    });
    expect(result.nameHit).toBe(true);
    expect(result.verified).toBe(true);
  });

  test('wariant: "Handlowo-Usługowa" nie przykrywa marki', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Testmark — lider branży. Siedziba: 12-345 Miastowo.',
      title: 'Testmark - liderzy branży',
      company: { company_name: "Firma Handlowo-Usługowa 'Testmark' sp. z o.o." },
      krsData: null,
      gusData: gus('12-345', null),
    });
    expect(result.nameHit).toBe(true);
    expect(result.verified).toBe(true);
  });

  test('wariant: "Budowlano-Montażowy" nie przykrywa marki', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Budmax realizuje inwestycje od 1998. Adres: 44-100 Gliwice.',
      title: 'Budmax — realizacje budowlane',
      company: { company_name: "Zakład Budowlano-Montażowy 'Budmax' sp. z o.o." },
      krsData: null,
      gusData: gus('44-100', null),
    });
    expect(result.nameHit).toBe(true);
    expect(result.verified).toBe(true);
  });

  test('wariant: "Transportowo-Spedycyjne" nie przykrywa marki', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Transex — usługi transportowe w całej Europie. Adres: 61-005 Poznań.',
      title: 'Transex — transport i spedycja',
      company: { company_name: "Przedsiębiorstwo Transportowo-Spedycyjne 'Transex' sp. z o.o." },
      krsData: null,
      gusData: gus('61-005', null),
    });
    expect(result.nameHit).toBe(true);
    expect(result.verified).toBe(true);
  });

  test('regresja: "Wielobranżowe Kopalnia Ogorzelec" nadal działa (case sprzed poprawki, 21.08)', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Kopalnia Ogorzelec — wydobycie kruszyw. Adres: 58-100 Świdnica.',
      title: 'Kopalnia Ogorzelec',
      company: { company_name: 'Przedsiębiorstwo Wielobranżowe Kopalnia Ogorzelec sp. z o.o.' },
      krsData: null,
      gusData: gus('58-100', null),
    });
    expect(result.nameHit).toBe(true);
    expect(result.verified).toBe(true);
  });
});

describe('checkDomainIdentity — strong_registry_address (fix 2)', () => {
  test('Novum: tytuł strony nadal zawiera "Novum" gdzieś w nazwie — dzięki fix 1 nameHit jest już true (uslugowo/produkcyjne poprawnie odfiltrowane), więc trafia w silny dowód adresowy niezależnie od kolejności warunków', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Hunters Novum (dawniej Musi Novum) — ochrona, sprzątanie, szwalnia. 96-300 Żyrardów, ul. 1 Maja 10.',
      title: 'MUSI NOVUM Spółka z o.o. HUNTERS NOVUM sp.z o.o. (dawniej MUSI NOVUM Sp. z o.o.)',
      company: { company_name: "Przedsiębiorstwo Usługowo Produkcyjne 'Novum' sp. z o.o." },
      krsData: null,
      gusData: gus('96-300', '1 Maja'),
    });
    expect(result.nameHit).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('strong_registry_address');
  });

  test('rebranding na CAŁKOWICIE inną markę (zero wspólnego tokenu z nazwą rejestrową) — tylko fix 2 ratuje ten przypadek', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Nova Team — kompleksowa obsługa klienta biznesowego. Siedziba: 40-012 Katowice, ul. Górnicza 5.',
      title: 'Nova Team — rebranding, nowa marka',
      company: { company_name: "Alfa-Metal sp. z o.o." },
      krsData: null,
      gusData: gus('40-012', 'Górnicza'),
    });
    expect(result.nameHit).toBe(false); // "alfa-metal" naprawdę nie występuje w tytule
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('strong_registry_address');
  });

  test('pojedyncze trafienie adresowe (sam postcode, bez ulicy) NIE wystarcza bez nameHit', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Zupełnie inna firma. Adres: 96-300 Żyrardów.',
      title: 'Zupełnie inna marka',
      company: { company_name: "Przedsiębiorstwo Usługowo Produkcyjne 'Novum' sp. z o.o." },
      krsData: null,
      gusData: gus('96-300', '1 Maja'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
  });

  test('pojedyncze trafienie adresowe (sama ulica, bez postcode) NIE wystarcza bez nameHit', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Zupełnie inna firma, ul. 1 Maja 10.',
      title: 'Zupełnie inna marka',
      company: { company_name: "Przedsiębiorstwo Usługowo Produkcyjne 'Novum' sp. z o.o." },
      krsData: null,
      gusData: gus('96-300', '1 Maja'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
  });
});

describe('checkDomainIdentity — ochrona przed znanymi złymi domenami (bez regresji)', () => {
  test('Mirol: przypadkowa zbieżność nazwy (Argentyna), zero dopasowania adresowego — nadal odrzucone', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Software de Gestión para Empresas Constructoras e Inmobiliarias. Mirol SyS.',
      title: 'Software de Gestión PyMes Constructoras e Inmobiliarias | Mirol SyS',
      company: { company_name: 'Mirol sp. z o.o.' },
      krsData: null,
      gusData: gus('09-412', 'Ogorzelice'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
  });

  test('IMW/Deckert: obca firma (Niemcy), zero dopasowania nazwy i adresu — nadal odrzucone', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Deckert Anlagenbau — Wir sind ein mittelständisches Unternehmen mit Sitz in Lüneburg.',
      title: 'Startseite Deckert Anlagenbau',
      company: { company_name: 'Imw Inżynieria Maszyn Wałcz sp. z o.o.' },
      krsData: null,
      gusData: gus('78-600', 'Ciasna'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
  });

  test('Berlinerluft: spółka-córka wspominająca niemiecką centralę obok WŁASNEGO silnego adresu — nie jest to konflikt, i teraz też przechodzi przez strong_registry_address (regresja 20.08 + nowa reguła)', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Nasza siedziba: 75-201 Koszalin, ul. Lniana 13. Jesteśmy częścią międzynarodowej grupy Berlinerluft Holding GmbH.',
      title: 'Berlinerluft — systemy wentylacyjne',
      company: { company_name: 'Berlinerluft sp. z o.o.' },
      krsData: null,
      gusData: gus('75-201', 'Lniana'),
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('strong_registry_address');
  });

  test('sama zbieżność słowa marki bez żadnego dopasowania adresowego — nadal odrzucone (nowe rdzenie nie tworzą furtki)', () => {
    const result = checkDomainIdentity({
      nip: null,
      text: 'Firma produkcyjno-handlowa działająca w zupełnie innym mieście, inny adres, inny profil.',
      title: 'Testmark Global — inna, niepowiązana firma',
      company: { company_name: "Przedsiębiorstwo Produkcyjno-Handlowe 'Testmark' sp. z o.o." },
      krsData: null,
      gusData: gus('99-999', 'Nieistniejąca'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('insufficient_evidence');
  });
});
