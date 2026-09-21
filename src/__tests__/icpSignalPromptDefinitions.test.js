// Testy regresyjne dla definicji 8 sygnałów ICP w SYSTEM_PROMPT.
//
// SYSTEM_PROMPT steruje niedeterministycznym modelem (DeepSeek), więc te testy
// NIE weryfikują faktycznej klasyfikacji AI (do tego służy osobny, ręcznie
// odpalany replay na realnych firmach — patrz raport audytu). Weryfikują, że
// prompt jawnie dokumentuje rozpoznawanie każdej KLASY dowodu (w tym
// synonimów) i jawnie odrzuca każdą klasę dowodu granicznego/niewystarczającego
// — to zapobiega przyszłej regresji polegającej na przypadkowym usunięciu
// synonimu albo guardrailu przy kolejnej edycji promptu.
//
// Każdy blok ma min. 2 klasy dowodu pozytywnego (w tym synonimy) i min. 2
// klasy dowodu granicznego/negatywnego, zgodnie z metodyką audytu z 18.09.2026.

const { SYSTEM_PROMPT } = require('../services/prospectEnrichmentService');

// Zwraca blok definicji z whitespace (w tym zawijanie linii) znormalizowanym
// do pojedynczych spacji, żeby dopasowania fraz nie zależały od tego, gdzie
// akurat przechodzi łamanie wiersza w źródle promptu.
function definitionBlockFor(promptKey) {
  const start = SYSTEM_PROMPT.indexOf(`${promptKey} (`);
  expect(start).toBeGreaterThan(-1);
  const rest = SYSTEM_PROMPT.slice(start);
  const nextBlank = rest.indexOf('\n\n');
  const raw = rest.slice(0, nextBlank === -1 ? rest.length : nextBlank);
  return raw.replace(/\s+/g, ' ');
}

describe('field_sales_team — klasy dowodu', () => {
  const block = definitionBlockFor('field_sales_team');

  test.each([
    ['dosłowne "dział handlowy"', 'dział handlowy'],
    ['synonim "dział sprzedaży"', 'dział sprzedaży'],
    ['synonim angielski "sales team"/"sales department"', 'sales team'],
    ['synonim "przedstawiciele handlowi" jako nazwana sekcja', 'przedstawiciele handlowi'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  test('jawnie nazwany dział wystarcza nawet przy jednej osobie', () => {
    expect(block).toMatch(/WYSTARCZA nawet przy JEDNEJ/);
  });

  test('graniczny przypadek: sam dyrektor bez nazwanego działu NIE wystarcza', () => {
    expect(block).toMatch(/NIE wystarcza: jedna nazwana osoba na stanowisku dyrektorskim/);
    expect(block).toContain('Dyrektor Handlowy');
  });

  test('graniczny przypadek: sam adres sprzedaz@/sales@ to za mało', () => {
    expect(block).toMatch(/sprzedaz@\/sales@/);
  });
});

describe('custom_quote_process — klasy dowodu', () => {
  const block = definitionBlockFor('custom_quote_process');

  test.each([
    ['"zapytaj o ofertę"', 'zapytaj o ofertę'],
    ['"poproś o wycenę"', 'poproś o wycenę'],
    ['"oferta indywidualna"/"indywidualna oferta"', 'indywidualna oferta'],
    ['RFQ', 'RFQ'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  test('graniczny przypadek: sam brak cennika bez frazy CTA NIE wystarcza', () => {
    expect(block).toMatch(/NIE wystarcza samo\): sam brak jawnego cennika/);
  });

  // Poprawka 19.09 (szósta tura) — model czasem uznawał zwykły publiczny
  // cennik/standardową cenę produktu za dowód indywidualnego ofertowania
  // (case Dtm System: ceny wprost przy produktach; case Warszawianka: cennik
  // pakietów "od X zł"). Doprecyzowanie granicy, nie nowe synonimy.
  test('KLUCZOWA GRANICA: cena musi być ustalana indywidualnie PO stronie firmy, nie z góry podana', () => {
    expect(block).toMatch(/KLUCZOWA GRANICA: cena musi być ustalana INDYWIDUALNIE/);
  });

  test('graniczny przypadek (case Dtm System): jawna, stała cena produktu w katalogu NIE wystarcza', () => {
    expect(block).toMatch(/jawna, stała cena konkretnego produktu\/usługi \(cennik, cena jednostkowa przy\s+produkcie w sklepie\/katalogu\)/);
    expect(block).toMatch(/NAWET jeśli produkt jest sprzedawany firmom/);
  });

  test('graniczny przypadek (case Warszawianka): format "od X zł" NIE wystarcza', () => {
    expect(block).toMatch(/format "od X zł" przy produkcie\/usłudze\/pokoju\/pakiecie/);
  });

  test('graniczny przypadek: standardowy cennik pokoju\/usługi\/pakietu NIE wystarcza mimo obsługi klientów biznesowych', () => {
    expect(block).toMatch(/standardowa, jawnie podana cena pokoju\/usługi\/pakietu/);
  });

  test('graniczny przypadek: sam formularz kontaktowy\/kontakt ze sprzedażą bez wzmianki o indywidualnej wycenie NIE wystarcza', () => {
    expect(block).toMatch(/sam kontakt do działu sprzedaży \/ formularz kontaktowy \/ "skontaktuj się z nami" BEZ/);
  });

  // Poprawka 19.09 (dziewiąta tura) — po pełnym replayu 40 firm precision
  // sygnału trafiło 100%, ale recall spadł (Terrano, Kolumnapark, Gas Trading,
  // Uds błędnie false mimo realnego dowodu). Nie cofamy poprawki (DTM/
  // Warszawianka mają zostać false) — dodajemy węższe rozpoznanie
  // funkcjonalnego odpowiednika: aktywny dobór parametrów PRZEZ firmę oraz
  // spersonalizowane CTA, plus rozdzielenie cennika jednej usługi od procesu
  // ofertowego innej (case Kolumnapark: cennik pokoi vs oferta eventowa B2B).
  test('funkcjonalny odpowiednik: aktywny dobór wariantu/parametrów PRZEZ firmę liczy się bez słowa "wycena"', () => {
    expect(block).toMatch(/firma AKTYWNIE DOBIERA\/REKOMENDUJE\s+konkretny wariant\/parametry\/konfigurację/);
  });

  test('funkcjonalny odpowiednik: spersonalizowane CTA ("jakie rozwiązania możemy Ci zaproponować") liczy się, nie tylko neutralny link "kontakt"', () => {
    expect(block).toMatch(/dowiedz się, jakie rozwiązania możemy Ci zaproponować/);
  });

  test('graniczny przypadek (case Kolumnapark): jawny cennik JEDNEJ usługi nie dyskwalifikuje dowodu dla INNEJ, odrębnej usługi B2B', () => {
    expect(block).toMatch(/jeśli firma ma OSOBNY, jawny\s+cennik dla JEDNEJ usługi.*ORAZ oddzielnie opisany proces\s+ofertowy dla INNEJ/s);
  });
});

describe('consultation_demo_needs_analysis — klasy dowodu', () => {
  const block = definitionBlockFor('consultation_demo_needs_analysis');

  test.each([
    ['konsultacja/demo', 'demo'],
    ['dobór rozwiązania', 'dobór rozwiązania'],
    ['analiza potrzeb', 'analiza potrzeb'],
    ['dobór techniczny', 'dobór techniczny'],
    ['doradztwo przedsprzedażowe', 'doradztwo przedsprzedażowe'],
    ['projektowanie pod klienta', 'projektowanie pod klienta'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  test('graniczny przypadek: zwykły formularz kontaktowy NIE wystarcza', () => {
    expect(block).toMatch(/sam formularz kontaktowy ogólnego typu/);
  });

  test('graniczny przypadek: serwis/wsparcie posprzedażowe NIE liczy się', () => {
    expect(block).toMatch(/wsparcie techniczne dla już kupionego produktu, nie etap sprzedaży/);
  });

  test('graniczny przypadek (18.09, Euronyl): "uwzględnianie wymagań klienta" w produkcji, bez osobnego etapu rozmowy, NIE liczy się', () => {
    expect(block).toMatch(/opis MOŻLIWOŚCI PRODUKCYJNYCH/);
    expect(block).toMatch(/sam fakt, że produkt powstaje "pod klienta"/);
  });

  // Poprawka 19.09 (ósma tura, case Postęp) — usunięto sprzeczny bullet
  // dowodu pozytywnego ("funkcjonalne: personalizacja/dostosowanie do
  // indywidualnych potrzeb"), który wprost kolidował z wykluczeniem
  // "elastyczność produkcyjna" dodanym już wcześniej (case Euronyl) — model
  // miał w tym samym bloku sprzeczne instrukcje na ten sam wzorzec tekstu.
  test('nie zawiera już sprzecznego bullet-a pozytywnego o "personalizacji/dostosowaniu" (usunięty)', () => {
    expect(block).not.toMatch(/funkcjonalne: oferta personalizacji\/dostosowania produktu/);
  });

  test('graniczny przypadek (case Postęp): "elastyczność produkcyjna" i "możliwość personalizacji" same w sobie NIE wystarczają', () => {
    expect(block).toMatch(/elastyczność produkcyjna i "możliwość personalizacji" produktu\/usługi same w sobie/);
    expect(block).toMatch(/to opis ZDOLNOŚCI firmy, nie opis PROCESU rozmowy z klientem przed zakupem/);
  });

  test('graniczny przypadek (case Postęp): realizacja projektu dostarczonego JUŻ przez klienta NIE liczy się', () => {
    expect(block).toMatch(/realizacja projektu\/dokumentacji DOSTARCZONEJ JUŻ przez klienta/);
  });

  test('graniczny przypadek (case Postęp): hasła "wspólnie stworzymy rozwiązania"\/"od koncepcji po produkcję" bez osobnego etapu doradztwa NIE wystarczają', () => {
    expect(block).toMatch(/"wspólnie stworzymy rozwiązania"\/"projekt od\s+pomysłu do realizacji"/);
    expect(block).toMatch(/dopóki nie jest OSOBNO opisany etap ROZMOWY\/DORADZTWA\/ANALIZY POTRZEB/);
  });

  // Punkt "aktywny dobór wariantu/parametrów" (9. tura) cofnięty decyzją
  // użytkownika — powodował systematyczne Postęp=true. Zostaje tylko punkt Elmex.
  test('funkcjonalny odpowiednik (case Elmex): doradztwo jawnie dostosowane do indywidualnych wymagań klienta liczy się', () => {
    expect(block).toMatch(/doradztwo opisane jako DOSTOSOWANE do indywidualnych wymagań klienta/);
  });

  test('reguła "aktywny dobór" (cofnięta) nie występuje w definicji consultation', () => {
    expect(block).not.toMatch(/AKTYWNIE DOBIERA\/REKOMENDUJE klientowi/);
    expect(block).not.toMatch(/Rozstrzyga kierunek/);
  });
});

describe('dedicated_customer_care_b2b — klasy dowodu', () => {
  const block = definitionBlockFor('dedicated_customer_care_b2b');

  test.each([
    ['dedykowany opiekun', 'dedykowany opiekun'],
    ['Key Account Manager / KAM', 'Key Account Manager'],
    ['account manager (bez "Key")', 'account manager'],
    ['Customer Success', 'Customer Success'],
    ['opieka handlowa B2B', 'opieka handlowa B2B'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  test('graniczny przypadek: samo BOK/infolinia (nawet z nazwanym kierownikiem) NIE wystarcza', () => {
    expect(block).toMatch(/samo Biuro Obsługi Klienta \(BOK\), sama infolinia, LUB nazwany kierownik/);
  });

  // Poprawka 19.09 (piąta tura) — doprecyzowanie granicy semantycznej po
  // znalezieniu FN (Sps Electronics: named consultants "odpowiedzialny za daną
  // branżę" bez słowa opiekun/KAM) i powtarzającej się niejednoznaczności
  // (Dtm System, Uds: regionalny handlowiec vs KAM) w benchmarku na świeżej
  // próbce workend_ola_14001-15000. Nie hardcoduje tych firm — testuje samą
  // zasadę.
  test('KLUCZOWA GRANICA: wymaga przypisania NA STAŁE do konkretnego klienta/konta/segmentu, nie samego działu sprzedaży', () => {
    expect(block).toMatch(/KLUCZOWA GRANICA: sygnał wymaga OSOBY \(lub zespołu\) PRZYPISANEJ NA STAŁE/);
  });

  test('pozytywna zasada: osoba opisana jako odpowiedzialna na stałe za segment/branżę liczy się bez słowa "opiekun"/"KAM"', () => {
    expect(block).toMatch(/osoba jawnie opisana jako odpowiedzialna na stałe za\s+dany segment\/branżę\/konto klienta/);
    expect(block).toMatch(/kontakt z konsultantem odpowiedzialnym za daną\s+branżę/);
  });

  test('graniczny przypadek: zwykły handlowiec regionalny (bez słowa opiekun\/KAM) NIE wystarcza', () => {
    expect(block).toMatch(/zwykły handlowiec\/przedstawiciel handlowy przypisany do\s+REGIONU\/terytorium/);
    expect(block).toMatch(/nie tylko za "sprzedaż w regionie X"/);
  });

  test('graniczny przypadek: Kierownik\/Dyrektor Działu Sprzedaży sam w sobie NIE wystarcza', () => {
    expect(block).toMatch(/Kierownik\/Dyrektor Działu Sprzedaży — to funkcja zarządcza/);
  });

  test('graniczny przypadek: sam kontakt do działu sprzedaży bez stałej opieki NIE wystarcza', () => {
    expect(block).toMatch(/sam kontakt do działu sprzedaży \(telefon\/e-mail działu\) bez informacji/);
  });
});

describe('tender_bidding_department — klasy dowodu', () => {
  const block = definitionBlockFor('tender_bidding_department');

  test.each([
    ['wygraliśmy przetarg(i)', 'wygraliśmy przetarg'],
    ['doświadczenie w przetargach', 'doświadczenie w przetargach'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  test('graniczny przypadek: sam klient publiczny w portfolio NIE wystarcza', () => {
    expect(block).toMatch(/NIE WYSTARCZA samo posiadanie klientów\/zamawiających publicznych/);
  });

  test('graniczny przypadek: firma kupująca w przetargach NIE liczy się', () => {
    expect(block).toMatch(/to firma KUPUJĄCA, zwróć false/);
    expect(block).toContain('postępowania zakupowe');
  });
});

describe('distributed_sales_structure — klasy dowodu', () => {
  const block = definitionBlockFor('distributed_sales_structure');

  test('rozpoznaje klasę pozytywną: własne oddziały/placówki/biura regionalne', () => {
    expect(block).toMatch(/oficjalne oddziały, biura regionalne lub placówki firmy/);
  });
  test('rozpoznaje klasę pozytywną: przypisani regionalni handlowcy (wzmocnienie)', () => {
    expect(block).toMatch(/regionalni handlowcy\/przedstawiciele zwiększają pewność/);
  });

  test('graniczny przypadek: lokalizacje partnerów/dealerów NIE liczą się', () => {
    expect(block).toMatch(/adresy zewnętrznych partnerów\/dealerów\/niezależnych dystrybutorów/);
  });
  test('graniczny przypadek: spółki-siostry z tej samej grupy NIE liczą się', () => {
    expect(block).toMatch(/spółki-siostry\/spółki z tej samej grupy kapitałowej/);
  });

  test('graniczny przypadek (18.09, Silbo): zagraniczny oddział TEJ SAMEJ firmy nadal się liczy jako własny', () => {
    expect(block).toMatch(/Oddział\/przedstawicielstwo tej samej firmy ZA GRANICĄ nadal się liczy jako własne/);
    expect(block).toMatch(/nie wymagaj polskiego NIP\/KRS/);
  });

  // Poprawka 19.09 (siódma tura, case Krause) — model liczył
  // KRAUSE-Werk GmbH/KRAUSE-Systems AG/KRAUSE Kft. (osobne spółki grupy w
  // innych krajach) jako własne oddziały badanej spółki, mimo że wykluczenie
  // spółek-sióstr już istniało w prompcie. Brakowało KONKRETNEGO sposobu
  // odróżnienia "oddział tej samej firmy za granicą" (Silbo, nadal true) od
  // "spółka z grupy w innym kraju" (Krause, ma być false) — stąd rozpoznanie
  // po odrębnej nazwie/formie prawnej, nie kolejny synonim.
  test('podaje konkretny sposób odróżnienia własnego oddziału od spółki z grupy (po nazwie/formie prawnej)', () => {
    expect(block).toMatch(/JAK ODRÓŻNIĆ własny zagraniczny oddział od spółki z grupy/);
    expect(block).toMatch(/WŁASNĄ, ODRĘBNĄ nazwę firmy z lokalną\s+formą prawną/);
  });

  test('graniczny przypadek (case Krause): różne spółki grupy z lokalną formą prawną (GmbH, AG, Kft.) to NIE własne oddziały', () => {
    expect(block).toMatch(/to jest OSOBNY PODMIOT GRUPY KAPITAŁOWEJ, nie\s+własny oddział badanej spółki, NAWET jeśli działa pod tą samą marką/);
  });

  test('graniczny przypadek: sama przynależność do międzynarodowej grupy/marki NIE wystarcza', () => {
    expect(block).toMatch(/lista krajów lub spółek grupy to nie własna sieć oddziałów\s+badanej firmy/);
  });
});

describe('partner_dealer_network — klasy dowodu', () => {
  const block = definitionBlockFor('partner_dealer_network');

  test.each([
    ['"zostań partnerem"', 'zostań partnerem'],
    ['"sieć dealerska"', 'sieć dealerska'],
    ['"dla dystrybutorów"', 'dla dystrybutorów'],
    ['"strefa partnera"', 'strefa partnera'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  test('graniczny przypadek: ogólne słowo "partner" oznaczające klienta NIE wystarcza', () => {
    expect(block).toMatch(/ogólne, marketingowe użycie słowa "partner"\/"partnerzy" oznaczające KLIENTÓW/);
    expect(block).toMatch(/długoterminowe relacje z partnerami na całym świecie/);
  });

  test('graniczny przypadek: spółki-siostry tej samej grupy NIE liczą się (chyba że opisane jako dealerzy)', () => {
    expect(block).toMatch(/spółek-sióstr\/spółek z tej samej grupy kapitałowej/);
  });

  // Poprawka 19.09 (trzecia tura) — kierunek relacji biznesowej, case Elmex/CCI/Gaja/
  // Ośrodek Kocierz z benchmarku na świeżej próbce workend_ola_14001-15000.
  test('jawnie wymaga ustalenia kierunku relacji (kto jest dostawcą, kto odsprzedawcą)', () => {
    expect(block).toMatch(/KIERUNEK RELACJI/);
    expect(block).toMatch(/ustal kto jest dostawcą, a kto odsprzedawcą/);
  });

  test('graniczny przypadek (case CCI): firma będąca SAMA dealerem/dystrybutorem cudzej marki zwraca false', () => {
    expect(block).toMatch(/firma SAMA jest dealerem\/dystrybutorem\/autoryzowanym partnerem CUDZEJ marki/);
    expect(block).toMatch(/WŁASNY dział montażu\/instalacji\/serwisu również\s+się nie liczy/);
  });

  test('graniczny przypadek (case Elmex): rekrutacja przewoźników/podwykonawców/dostawców zwraca false', () => {
    expect(block).toMatch(/firma REKRUTUJE przewoźników, podwykonawców lub dostawców/);
    expect(block).toMatch(/to ona jest stroną KUPUJĄCĄ usługę\/zdolność/);
  });

  test('graniczny przypadek (case Ośrodek Kocierz): partner eventowy/marketingowy/atrakcja lokalna zwraca false', () => {
    expect(block).toMatch(/partnera eventowego, marketingowego, lokalną atrakcję turystyczną/);
  });

  test('pozytywny warunek (case Gaja): wymaga odsprzedaży PRODUKTÓW\/USŁUG TEJ FIRMY, nie cudzej', () => {
    expect(block).toMatch(/PRODUKTY\/USŁUGI TEJ FIRMY \(nie cudzej\)/);
  });

  // Poprawka 19.09 (czwarta tura) — Gaja zwracała false 3/3 mimo jawnej treści
  // "Sprzedajesz bieliznę? Rozpocznij z nami współpracę... model współpracy z
  // dystrybutorami sprawdza się od dekad" — brakowało jednej, wprost
  // sformułowanej zasady pozytywnej dla tego dokładnego wzorca (zaproszenie
  // odsprzedawców WŁASNEJ oferty), nie kolejnego synonimu.
  test('ZASADA POZYTYWNA (case Gaja): zaproszenie do sprzedaży/dystrybucji WŁASNYCH produktów firmy = true', () => {
    expect(block).toMatch(/ZASADA POZYTYWNA: jeżeli badana firma zaprasza inne firmy\/sprzedawców/);
    expect(block).toMatch(/Sprzedajesz nasze produkty \/ produkty z naszej\s+kategorii\? Rozpocznij z nami współpracę/);
    expect(block).toMatch(/badana firma jest tu DOSTAWCĄ\/PRODUCENTEM, a zewnętrzny\s+podmiot ma sprzedawać JEJ ofertę/);
  });
});

describe('ecommerce_b2b — klasy dowodu', () => {
  const block = definitionBlockFor('ecommerce_b2b');

  test('rozpoznaje klasę pozytywną: panel/sklep B2B z cechą B2B (ceny netto, NIP przy koncie, rabaty hurtowe)', () => {
    expect(block).toMatch(/ceny netto\/"dla firm"/);
    expect(block).toMatch(/rabaty ilościowe\/hurtowe/);
  });
  test('rozpoznaje klasę pozytywną: jawna nazwa "sklep B2B"/"panel B2B"', () => {
    expect(block).toMatch(/"sklep B2B"\/"panel B2B"/);
  });

  test('graniczny przypadek: zwykły sklep konsumencki z NIP-em na fakturze NIE wystarcza', () => {
    expect(block).toMatch(/NIE wystarcza: zwykły sklep detaliczny/);
    expect(block).toMatch(/to nadal sprzedaż D2C/);
  });

  test('graniczny przypadek (18.09, Arpol): sama etykieta "Platforma B2B" bez opisu funkcji NIE wystarcza', () => {
    expect(block).toMatch(/sama etykieta menu\/link "Platforma B2B"\/"B2B" bez żadnego dalszego opisu/);
  });

  test('zachowuje zależność scoringu od dzial_handlowy/opieki B2B (dokumentacyjnie, logika w kodzie)', () => {
    expect(block).toMatch(/TYLKO razem z dzial_handlowy lub dedicated_customer_care_b2b/);
  });
});
