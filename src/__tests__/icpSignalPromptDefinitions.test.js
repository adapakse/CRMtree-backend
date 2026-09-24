// Testy regresyjne dla definicji 8 domyślnych sygnałów ICP (ai_definition).
//
// Od ETAPU B (dynamiczny ICP per tenant) definicje nie żyją już w statycznym
// SYSTEM_PROMPT, tylko w tenantIcpConfigService.DEFAULT_SIGNALS[].ai_definition
// — dokładnie ten sam tekst, 1:1 skopiowany z dawnego promptu przy migracji
// 0285 (zero parafrazowania). Ten plik testuje WYŁĄCZNIE treść definicji, nie
// faktyczną klasyfikację AI (do tego służy osobny, ręcznie odpalany replay na
// realnych firmach — patrz raport audytu): że jawnie dokumentuje rozpoznawanie
// każdej KLASY dowodu (w tym synonimów) i jawnie odrzuca każdą klasę dowodu
// granicznego/niewystarczającego — zapobiega to przyszłej regresji polegającej
// na przypadkowym usunięciu synonimu albo guardrailu przy edycji definicji.
//
// Każdy blok ma min. 2 klasy dowodu pozytywnego (w tym synonimy) i min. 2
// klasy dowodu granicznego/negatywnego, zgodnie z metodyką audytu z 18.09.2026.
//
// AKTUALIZACJA 23.09.2026 — decyzja biznesowa "recall-first": pracownicy CRM
// mają na tych prospektach pracować i dzwonić — koszt false negative (brak
// leada do zadzwonienia) jest wyższy niż koszt false positive (kilka minut
// straconych na słabszym telefonie). Wszystkie 7 AKTYWNYCH sygnałów zostało
// celowo poluzowanych: wiarygodna przesłanka biznesowa wystarcza do true,
// bez wymogu literalnych fraz, ocena semantyczna, przy niepewności wybieraj
// true — ale NIGDY bez żadnej konkretnej przesłanki w tekście (wspólna
// zasada w PROMPT_STATIC_HEADER, patrz osobny describe-block niżej). Wiele
// testów niżej oznaczonych "reguła cofnięta 23.09" dokumentuje ŚWIADOME
// odwrócenie wcześniejszych, precyzyjnych guardów z 18.09/19.09 — to nie
// regresja. Wagi (points) i próg kwalifikacji (45) NIE zostały ruszone w tej
// zmianie — patrz tenantIcpConfigService.test.js/icpScoring.test.js.
//
// DRUGA TURA 23.09.2026 — po przeglądzie pierwszej tury okazało się, że kilka
// pojedynczych, bardzo słabych faktów (sam alias sprzedaz@/sales@, sama
// funkcja Dyrektora Sprzedaży, samo duże portfolio klientów publicznych,
// samo hasło "serwis") mogło samodzielnie zapalać wysokopunktowe sygnały. Dla
// 6 z 7 aktywnych sygnałów (dzial_handlowy, zlozony_proces_sprzedazy,
// konsultacja_demo, opieka_nad_klientem, przetargi, cykliczna_obsluga)
// przywrócono wymóg choć minimalnego kontekstu/interakcji obok samego faktu —
// globalna filozofia recall-first ZOSTAJE, cofnięte są tylko te konkretne
// miejsca. siec_partnerow celowo pominięty — audyt nie znalazł tam analogicznego
// problemu. Testy niżej oznaczone "poprawka 23.09, druga tura" dokumentują tę
// korektę i w kilku miejscach zastępują testy "reguła cofnięta 23.09" z
// pierwszej tury (ten sam wzorzec cofnięcia-po-przeglądzie co dla starszych
// poprawek 19.09).

const { DEFAULT_SIGNALS } = require('../services/tenantIcpConfigService');
const { PROMPT_STATIC_HEADER } = require('../services/prospectEnrichmentService');

// Dawne promptKey (nazwy pól w kontrakcie JSON z AI, np. "field_sales_team")
// zmapowane na dzisiejsze, stabilne tenant_icp_signals.key (np. "dzial_handlowy")
// — patrz komentarz przy tej kolumnie w migracji 0285. Mapa istnieje wyłącznie
// po to, żeby nie przepisywać wszystkich testów niżej pod nowe nazwy.
const KEY_BY_PROMPT_KEY = {
  field_sales_team: 'dzial_handlowy',
  custom_quote_process: 'zlozony_proces_sprzedazy',
  consultation_demo_needs_analysis: 'konsultacja_demo',
  dedicated_customer_care_b2b: 'opieka_nad_klientem',
  tender_bidding_department: 'przetargi',
  distributed_sales_structure: 'rozproszona_struktura',
  partner_dealer_network: 'siec_partnerow',
  ecommerce_b2b: 'ecommerce_b2b',
};

// Zwraca ai_definition z whitespace (w tym zawijanie linii) znormalizowanym
// do pojedynczych spacji, żeby dopasowania fraz nie zależały od tego, gdzie
// akurat przechodzi łamanie wiersza w źródle.
function definitionBlockFor(promptKey) {
  const key = KEY_BY_PROMPT_KEY[promptKey];
  expect(key).toBeDefined();
  const signal = DEFAULT_SIGNALS.find(s => s.key === key);
  expect(signal).toBeDefined();
  return signal.ai_definition.replace(/\s+/g, ' ');
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
    expect(block).toMatch(/wystarcza nawet przy jednej widocznej osobie pod tym nagłówkiem/);
  });

  // TRZECIA TURA (23.09) — po benchmarku na 100 firmach 63% wyników miało
  // dokładnie ten sam tercet dzial_handlowy+zlozony_proces_sprzedazy+
  // konsultacja_demo, a 81% przekraczało próg 45. Ta granica jest teraz
  // NAJWĘŻSZA ze wszystkich trzech tur: pojedyncza osoba liczy się TYLKO gdy
  // kontekst (nie sam tytuł) pokazuje realne prowadzenie sprzedaży, a nie
  // "kontekst w postaci tytułu stanowiska" jak w drugiej turze.
  test('trzecia tura: pojedyncza osoba wymaga kontekstu roli, NIE samego tytułu stanowiska', () => {
    expect(block).toMatch(/POJEDYNCZA osoba sprzedażowa, JEŚLI kontekst \(opis roli, zakres\s+obowiązków, sposób przedstawienia — nie sam tytuł\) pokazuje, że REALNIE prowadzi sprzedaż/);
  });

  test('trzecia tura: dwóch nazwanych handlowców wystarcza nawet bez nagłówka działu (przywrócone z 18.09)', () => {
    expect(block).toMatch(/co najmniej DWÓCH nazwanych handlowców\/przedstawicieli\/account managerów, nawet bez\s+nagłówka działu/);
  });

  test('trzecia tura: sam adres sprzedaz@/sales@ NIE wystarcza samodzielnie', () => {
    expect(block).toMatch(/sam adres sprzedaz@\/sales@ \(może być zwykłą\s+ogólną skrzynką\)/);
  });

  // Regresja: case Energokessel (benchmark 100 firm) — "Janusz Gajda –
  // Dyrektor ds. Handlowych w zarządzie" bez opisu roli błędnie dało TRUE.
  test('REGRESJA (case Energokessel): sam Dyrektor ds. Handlowych wymieniony w zarządzie, bez opisu roli, NIE wystarcza', () => {
    expect(block).toMatch(/sama osoba "Dyrektor Handlowy"\/"Dyrektor ds\. Handlowych" wymieniona np\. w składzie\s+zarządu, BEZ żadnego opisu, że realnie prowadzi sprzedaż/);
    expect(block).toMatch(/sam tytuł członka zarządu bez\s+opisu roli to za mało, mogła objąć funkcję czysto nadzorczą/);
  });

  // Regresja: case Telbeskid — sekcja "Dla biznesu" błędnie dała TRUE.
  test('REGRESJA (case Telbeskid): sekcja "Dla firm"/"Dla biznesu" NIE wystarcza do dzial_handlowy', () => {
    expect(block).toMatch(/sekcja\/strona "Dla firm"\/"Dla\s+biznesu" \(to oferta kierowana do biznesu, nie dowód na istnienie działu sprzedaży\)/);
  });

  // Regresja: case Budrem — "kontakt biurowy, obsługa zleceń" błędnie dało TRUE.
  test('REGRESJA (case Budrem): ogólne "biuro"/"obsługa zleceń" NIE wystarcza (to może być administracja, nie sprzedaż)', () => {
    expect(block).toMatch(/ogólne "biuro"\/"obsługa zleceń" \(to może być\s+administracja\/logistyka, nie\s+sprzedaż\)/);
  });

  // Regresja: case Posadzki Przemysłowe — "doradztwo techniczno-handlowe"
  // bez nazwanych ludzi/struktury błędnie dało TRUE.
  test('REGRESJA (case Posadzki Przemysłowe): ogólne "doradztwo techniczno-handlowe" bez struktury/ludzi NIE wystarcza', () => {
    expect(block).toMatch(/ogólne hasło "doradztwo techniczno-\s*handlowe" BEZ wskazania konkretnych ludzi lub struktury\s+odpowiedzialnej za sprzedaż/);
  });

  test('sama sekcja/strona "Dla firm" oraz formularz kontaktowy/wyceny NIE wystarczają', () => {
    expect(block).toMatch(/sam formularz kontaktowy lub formularz wyceny/);
  });

  test('samo BOK oraz samo biuro projektowe/dział B+R/dział techniczny NIE wystarczają', () => {
    expect(block).toMatch(/samo Biuro Obsługi Klienta \(BOK\); samo biuro projektowe\/dział B\+R\/dział techniczny/);
    expect(block).toMatch(/to zdolność projektowo-inżynierska, nie sprzedażowa/);
  });

  test('wykluczenia mogą się wzajemnie wspierać TYLKO jeśli opisują tę samą, realną funkcję sprzedażową', () => {
    expect(block).toMatch(/Powyższe wykluczenia mogą się WZAJEMNIE WSPIERAĆ tylko jeśli razem opisują TĘ SAMĄ, realną\s+funkcję sprzedażową/);
    expect(block).toMatch(/nie sumuj kilku wykluczeń w nadzieję, że razem złożą się na dowód/);
  });

  test('podłoga recall-first zostaje: FALSE tylko gdy jedyne ślady to wyłącznie wykluczenia, bez głównego dowodu', () => {
    expect(block).toMatch(/ZWRÓĆ FALSE, gdy jedyne dostępne ślady to wyłącznie pozycje z listy wykluczeń, bez\s+żadnego głównego dowodu obok nich/);
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

  // Zaktualizowano 23.09 (decyzja recall-first, 3. poprawka po Enrichment V2
  // audycie). Cały ten describe-block dokumentował poprzednią, precyzyjną
  // granicę (poprawki 19.09) — WIELE z tych guardów zostało teraz CELOWO
  // cofniętych, bo produkt ma priorytetyzować recall nad precyzją (koszt
  // zbędnego telefonu < koszt pominiętego klienta). To NIE jest przypadkowa
  // regresja — poniższe testy sprawdzają AKTUALNĄ, świadomą granicę.

  test('reguła cofnięta 23.09: brak cennika + złożony/projektowy produkt B2B TERAZ przechyla się w stronę true', () => {
    expect(block).toMatch(/Przy braku jawnego cennika ORAZ przy braku jakiejkolwiek wzmianki o procesie ofertowym — przechyl się w stronę TRUE/);
    expect(block).not.toMatch(/brak ceny sam w sobie nie jest dowodem złożonego procesu sprzedaży/);
  });

  test('GRANICA interpretowana semantycznie, nie dosłownie', () => {
    expect(block).toMatch(/GRANICA \(interpretuj semantycznie, nie tylko dosłownie\): cena\/oferta jest ustalana w jakimś stopniu INDYWIDUALNIE/);
  });

  // Poprawka 19.09 (szósta tura, case Dtm System/Warszawianka) nadal
  // obowiązuje w OGÓLNEJ formie: to nie precyzja tylko logika — jawny, stały
  // cennik KONKRETNEGO produktu jest wprost sprzeczny z "ceną ustalaną
  // indywidualnie". Poprzednie osobne bullety "format od X zł"/"cennik
  // pokoju" są teraz jednym, ogólniejszym guardem.
  test('logiczna sprzeczność (nie precyzja): jawna, stała cena KONKRETNEGO produktu/usługi nadal NIE wystarcza', () => {
    expect(block).toMatch(/ZWRÓĆ FALSE: jawna, stała cena KONKRETNEGO produktu\/usługi \(cennik, cena jednostkowa w sklepie\/katalogu\)/);
    expect(block).toMatch(/NAWET jeśli produkt jest sprzedawany firmom/);
  });

  test('poprawka 23.09, druga tura: sam kontakt do działu sprzedaży/formularz PONOWNIE nie wystarcza samodzielnie', () => {
    expect(block).toMatch(/sam kontakt do działu sprzedaży\/ofert bez dalszego kontekstu — te wskazują na\s+kanał kontaktu, ale same nie potwierdzają, że wycena jest indywidualna/);
  });

  // Granica względem konsultacja_demo ZOSTAJE (to podział koncepcyjny, nie
  // guard precyzyjny) — ale wymóg dowodu złagodzony: dawniej "bez wzmianki",
  // teraz "bez ŻADNEJ wzmianki", i przy połączeniu z choćby pośrednim
  // wątkiem wyceny liczy się w obu sygnałach.
  test('podział koncepcyjny z konsultacja_demo ZOSTAJE, ale próg złagodzony do "bez ŻADNEJ wzmianki"', () => {
    expect(block).toMatch(/sam dobór\/rekomendacja rozwiązania bez ŻADNEJ wzmianki o etapie oferty\/ceny/);
    expect(block).toMatch(/to wciąż przede wszystkim dowód dla konsultacja_demo/);
    expect(block).toMatch(/gdy tekst łączy dobór rozwiązania Z choćby pośrednią wzmianką.*licz to też tutaj/);
  });

  test('poprawka 23.09, druga tura: frazy CTA przesunięte z "głównego dowodu" do "drugorzędnego wsparcia"', () => {
    expect(block).toMatch(/Drugorzędne wsparcie \(poprawka 23\.09, druga tura — NIE wystarcza samo/);
    expect(block).toContain('zapytaj o ofertę');
    expect(block).toContain('poproś o wycenę');
    expect(block).not.toMatch(/TO PRZYKŁADY, nie zamknięta lista/);
  });

  test('graniczny przypadek (case Kolumnapark): jawny cennik JEDNEJ usługi nie dyskwalifikuje dowodu dla INNEJ, odrębnej usługi B2B', () => {
    expect(block).toMatch(/chyba że firma OSOBNO opisuje proces ofertowy dla innej usługi \(wtedy oceniaj tę drugą niezależnie\)/);
  });
});

describe('consultation_demo_needs_analysis — klasy dowodu', () => {
  const block = definitionBlockFor('consultation_demo_needs_analysis');

  test.each([
    ['demo/prezentacja', 'demo'],
    ['dobór rozwiązania', 'dobór rozwiązania'],
    ['analiza potrzeb', 'analiza potrzeb'],
    ['doradztwo przy wyborze', 'doradztwo przy wyborze'],
    ['wizja lokalna', 'wizja lokalna'],
    ['wspólne projektowanie/ustalanie rozwiązania', 'wspólne projektowanie'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  // Zaktualizowano 23.09 (decyzja recall-first). Poniższe guardy z poprawek
  // 18.09/19.09 (Euronyl, Postęp) były precyzyjnymi wykluczeniami dokładnie
  // tej klasy dowodu, którą recall-first ma teraz ZALICZAĆ: produkcja "na
  // wymiar"/"pod klienta" bez osobno opisanego etapu rozmowy. To CELOWE
  // cofnięcie, nie regresja — testy niżej sprawdzają nową, świadomą granicę.

  test('serwis/wsparcie posprzedażowe nadal NIE liczy się (podział koncepcyjny PRZED/PO zakupie zostaje)', () => {
    expect(block).toMatch(/to obsługa PO zakupie, nie etap decyzji o zakupie/);
  });

  // Poprawka 23.09 (druga tura) — pełne złagodzenie z pierwszej tury cofało
  // sprawdzoną wcześniej poprawkę (case Euronyl/Postęp: "na wymiar" bez
  // żadnej przesłanki interakcji dawało realny false positive w benchmarku).
  // Przywrócony wymóg: potrzebna choć przesłanka INTERAKCJI, nie pełny,
  // osobno opisany "etap rozmowy" jak w oryginalnej (18.09) wersji.
  test('poprawka 23.09 (druga/trzecia tura): produkcja "na wymiar" BEZ przesłanki interakcji z klientem PONOWNIE nie wystarcza', () => {
    expect(block).toMatch(/NIE WYSTARCZA SAMA jako opis samej zdolności produkcyjnej — musi towarzyszyć jej\s+choć przesłanka INTERAKCJI z klientem przed realizacją/);
    expect(block).toMatch(/sam produkt "na wymiar"\/"pod klienta" bez opisanej interakcji/);
  });

  test('poprawka 23.09: z choćby minimalną przesłanką interakcji ("ustalamy z klientem" itp.) nadal liczy się bez osobnego opisanego etapu rozmowy', () => {
    expect(block).toMatch(/"ustalamy z klientem", "po\s+konsultacji", "na podstawie zgłoszonych wymagań", "dobieramy rozwiązanie"/);
    expect(block).toMatch(/wtedy liczy się nawet bez opisanego wprost odrębnego „etapu rozmowy”/);
  });

  // Regresja: case Tank Mark — "Osobom zainteresowanym przedstawimy ofertę"
  // (czysty boilerplate "skontaktuj się") błędnie dało TRUE.
  test('REGRESJA (case Tank Mark): samo "przedstawimy ofertę"/"skontaktuj się" NIE wystarcza do konsultacji', () => {
    expect(block).toMatch(/samo "skontaktuj się z nami"\/"przedstawimy ofertę"\/"zapytaj o ofertę" — to zaproszenie\s+do kontaktu, nie dowód analizy\/doboru/);
  });

  // Regresja: case Izoserwis — to samo "biuro projektowe" uzasadniło JEDNOCZEŚNIE
  // dzial_handlowy i konsultacja_demo (35 pkt z jednego faktu).
  test('REGRESJA (case Izoserwis): samo istnienie biura projektowego NIE wystarcza (chyba że osobno opisuje rozmowę z klientem)', () => {
    expect(block).toMatch(/samo istnienie biura\s+projektowego \(to zdolność projektowa, nie opisany etap rozmowy z klientem — chyba że tekst\s+OSOBNO opisuje, że biuro projektowe prowadzi rozmowę\/analizę z klientem przed realizacją/);
  });

  test('zasada niezależności dowodu: jeden fragment zapala kilka sygnałów TYLKO gdy opisuje osobne zjawiska', () => {
    expect(block).toMatch(/oceń każdy sygnał NIEZALEŻNIE — licz go dla więcej niż jednego sygnału\s+TYLKO jeśli fragment faktycznie opisuje osobne zjawiska biznesowe/);
    expect(block).toMatch(/sama\s+ogólna wzmianka o biurze projektowym\/obsłudze klienta\/doradztwie nie może automatycznie\s+zapalać kilku sygnałów naraz/);
  });

  test('zastrzeżenie zostaje: sama nazwa branży bez punktu zaczepienia w tekście nadal NIE wystarcza', () => {
    expect(block).toMatch(/nie ustawiaj true wyłącznie z samej nazwy branży bez żadnego punktu zaczepienia w tekście/);
  });

  test('przy niepewności (recall-first): gdy kontekst opisuje interakcję/dopasowywanie rozwiązania, wybieraj true nawet bez słowa "konsultacja"', () => {
    expect(block).toMatch(/jeśli kontekst rzeczywiście opisuje interakcję i\s+dopasowywanie rozwiązania do klienta, wybieraj TRUE nawet bez słowa "konsultacja"/);
  });

  test('reguła "aktywny dobór" (cofnięta wcześniej, 19.09) nadal nie występuje w definicji', () => {
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

  // Zaktualizowano 23.09 (decyzja recall-first). Poprawka 19.09 (piąta tura)
  // wprowadziła twardy wymóg "NA STAŁE przypisanej" osoby i odrzucała m.in.
  // zwykłego handlowca regionalnego czy Dyrektora Sprzedaży bez dodatkowych
  // elementów. Recall-first CELOWO obniża ten próg: wystarczy, że klient ma
  // JEDNĄ wskazaną osobę do kontaktu zamiast ogólnej infolinii.
  test('BOK/infolinia BEZ wzmianki o przypisanej osobie nadal NIE wystarcza (podłoga zostaje)', () => {
    expect(block).toMatch(/ZWRÓĆ FALSE: ogólne, niezróżnicowane Biuro Obsługi Klienta\/infolinia BEZ wzmianki o\s+przypisanej osobie\/koncie/);
  });

  // CZWARTA TURA (23.09) — benchmark 100 firm pokazał 38% miękkich TRUE na tym
  // sygnale (najwyższy odsetek ze wszystkich siedmiu). Zaostrzone: TRUE musi
  // oznaczać TRWAŁĄ odpowiedzialność za konkretnego klienta, nie dowolną formę
  // kontaktu. Recall-first (semantyczne odpowiedniki bez słowa "opiekun")
  // ZOSTAJE — zawężona jest tylko klasa dowodu.
  test('czwarta tura: TRUE wymaga TRWAŁEJ odpowiedzialności za KONKRETNEGO klienta, nie dowolnego kontaktu', () => {
    expect(block).toMatch(/TRUE oznacza REALNĄ, TRWAŁĄ odpowiedzialność za KONKRETNEGO klienta\/konto\/relację/);
    expect(block).toMatch(/musi z niego wynikać, że ktoś POZOSTAJE odpowiedzialny za danego klienta, a\s+nie tylko z nim rozmawia, sprzedaje mu albo obsługuje jego zlecenie/);
  });

  test('czwarta tura: semantyczne odpowiedniki bez słowa "opiekun" nadal liczą się (recall zachowany)', () => {
    expect(block).toMatch(/osoba prowadząca konto klienta; dedykowany\/stały kontakt przypisany do\s+konkretnego klienta/);
    expect(block).toMatch(/kontakt z konsultantem odpowiedzialnym za daną\s+branżę/);
    expect(block).toMatch(/Specjalista ds\. Kluczowych Klientów/);
  });

  // REGRESJA (case Pharma Nord, benchmark 100): "Przedstawiciel handlowy
  // przypisany do regionu klienta" dało TRUE mimo że reguła z drugiej tury
  // już to wykluczała — bo "opiekun regionalny/terytorialny" figurował
  // jednocześnie na liście RÓWNOWAŻNYCH określeń. Sprzeczność usunięta.
  test('REGRESJA (Pharma Nord): przypisanie TYLKO do regionu nie wystarcza, nawet gdy nazwane "opiekunem regionalnym"', () => {
    expect(block).toMatch(/przypisanie przedstawiciela\/handlowca TYLKO do\s+REGIONU\/terytorium\/województwa/);
    expect(block).toMatch(/dotyczy to także osoby nazwanej "opiekunem\s+regionalnym"\/"terytorialnym"/);
    expect(block).not.toMatch(/RÓWNOWAŻNE określenia.*opiekun regionalny\/terytorialny/s);
  });

  test('REGRESJA (Top Promotion): ogólna "stała współpraca" bez wskazanej osoby NIE wystarcza', () => {
    expect(block).toMatch(/ogólne hasło "stała współpraca"\/"wieloletnia współpraca" bez\s+wskazania osoby lub roli odpowiedzialnej za klienta/);
  });

  test('REGRESJA (Lacroix): "partner biznesowy"/"trusted partner" bez informacji o opiece NIE wystarcza', () => {
    expect(block).toMatch(/"partner biznesowy"\/"dedykowany\s+partner"\/"trusted partner" bez informacji, kto i w jakiej formie opiekuje się konkretnym\s+klientem/);
  });

  test('REGRESJA (Polski Transport): rola OPERACYJNA (dyspozytor/koordynator) NIE wystarcza', () => {
    expect(block).toMatch(/rola OPERACYJNA \(dyspozytor, koordynator transportu, planista, obsługa zleceń\) —\s+to prowadzenie procesu\/zlecenia, nie relacji z klientem/);
  });

  test('REGRESJA (Nuuxe): rola TECHNICZNA (tester/serwisant/wdrożeniowiec) NIE wystarcza', () => {
    expect(block).toMatch(/rola TECHNICZNA \(serwisant,\s+wdrożeniowiec, tester, inżynier wsparcia\) — to obsługa produktu, nie konta klienta/);
  });

  test('czwarta tura: zwykły handlowiec bez przesłanki odpowiedzialności PO pozyskaniu NIE wystarcza', () => {
    expect(block).toMatch(/zwykły\s+handlowiec\/sprzedawca BEZ żadnej przesłanki, że pozostaje odpowiedzialny za klienta PO\s+pozyskaniu/);
    expect(block).toMatch(/sama funkcja Kierownika\/Dyrektora Sprzedaży — to zarządzanie zespołem/);
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

  // Poprawka 23.09 (druga tura) — pierwsza tura pozwalała samej SKALI
  // portfolio klientów publicznych wystarczyć bez żadnej wzmianki o trybie
  // pozyskania kontraktu; to dokładnie ta różnica, którą oryginalna (18.09)
  // definicja explicite odróżniała: dowód na OBSŁUGĘ sektora publicznego ≠
  // dowód na SPOSÓB pozyskania kontraktu. Przywrócony wymóg choć pośredniej
  // wzmianki o trybie postępowania/zamówienia.
  test('poprawka 23.09, druga tura: samo duże/liczne portfolio klientów publicznych PONOWNIE nie wystarcza bez wzmianki o trybie', () => {
    expect(block).toMatch(/samo duże\/liczne portfolio klientów\/\s+zamawiających publicznych.*BEZ ŻADNEJ wzmianki o\s+trybie pozyskania kontraktu/s);
    expect(block).toMatch(/to nadal dowód na OBSŁUGĘ sektora publicznego, nie na SPOSÓB\s+jego pozyskania, niezależnie od liczby takich klientów/);
  });

  test('nie wymaga dosłownego słowa "przetarg", ale wymaga choć pośredniej wzmianki o trybie postępowania', () => {
    expect(block).toMatch(/nie wymagaj dosłownie słowa\s+"przetarg", ale wymagaj choć POŚREDNIEJ wzmianki o trybie postępowania\/zamówienia\/konkursu\s+ofert/);
  });

  test('kierunek sprzedawca vs kupujący ZOSTAJE jako logiczna sprzeczność, nie guard precyzyjny', () => {
    expect(block).toMatch(/KIERUNEK jest tu logiczną sprzecznością, nie kwestią interpretacji — nie zmieniaj go mimo ogólnej zasady recall-first/);
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

  // 23.09 (recall-first): kierunek relacji ZOSTAJE (logiczna sprzeczność),
  // ale poza tym warunkiem sygnał ma być oceniany liberalnie/semantycznie —
  // dodane explicite, żeby nie zgubić tego przy przyszłych edycjach.
  test('poza warunkiem kierunku: reszta oceniana liberalnie/semantycznie (23.09)', () => {
    expect(block).toMatch(/Poza tym warunkiem kierunku, resztę oceniaj semantycznie i liberalnie/);
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

  // Zaktualizowano 23.09 (audyt Enrichment V2) — usunięto asercję zależności
  // scoringu od dzial_handlowy/dedicated_customer_care_b2b: Decyzja
  // 2026-09-22 (prospectEnrichmentService.js calcIcpScore, komentarz przy
  // rawHits/requires_any_of) wyłączyła requires_any_of ze scoringu — każdy
  // sygnał, w tym ecommerce_b2b, liczy punkty NIEZALEŻNIE od innych. Aktualna
  // definicja to teraz wprost potwierdza własnym zdaniem końcowym, zamiast
  // starego "TYLKO razem z...". Ten sam fakt sprawdza już
  // tenantIcpConfigService.test.js/icpScoring.test.js na poziomie logiki
  // scoringu — tu tylko dokumentacyjnie, przez treść promptu.
  test('dokumentuje niezależność scoringu od innych sygnałów (decyzja 2026-09-22 usunęła requires_any_of ze scoringu)', () => {
    expect(block).toMatch(/Oceniaj ten sygnał niezależnie od pozostałych, wyłącznie na podstawie dowodu na stronie/);
    expect(block).not.toMatch(/TYLKO razem z/);
  });
});

// 9. sygnał (dodany po 0285/0288, poza starą mapą promptKey) — nie miał
// dotąd własnego describe-bloku w tym pliku. Dodane przy okazji audytu
// recall-first 23.09, żeby wszystkie 7 AKTYWNYCH sygnałów miały pokrycie.
describe('cykliczna_obsluga_klienta_odnowienia — klasy dowodu', () => {
  const signal = DEFAULT_SIGNALS.find(s => s.key === 'cykliczna_obsluga_klienta_odnowienia');
  const block = signal.ai_definition.replace(/\s+/g, ' ');

  test.each([
    ['regularne przeglądy', 'regularne przeglądy'],
    ['cykliczny serwis', 'cykliczny serwis'],
    ['odnawianie lub przedłużanie umów/usług', 'odnawianie lub przedłużanie umów'],
  ])('rozpoznaje klasę pozytywną: %s', (_label, phrase) => {
    expect(block.toLowerCase()).toContain(phrase.toLowerCase());
  });

  test('graniczny przypadek: sama możliwość ponownego zakupu/newsletter/program lojalnościowy NIE wystarcza', () => {
    expect(block).toMatch(/Nie wystarcza sama możliwość ponownego zakupu, newsletter, program lojalnościowy ani samo\s+ogólne hasło „serwis" BEZ żadnego wskazania powtarzalności/);
  });

  // Poprawka 23.09 (druga tura) — pierwsza tura pozwalała samemu ogólnemu
  // hasłu "serwis" wystarczyć przy "choćby minimalnym opisie powtarzalności"
  // (mgliste w praktyce). Przywrócony konkretny wymóg: musi paść choć jedno
  // słowo/fraza jawnie wskazująca powtarzalność.
  test('poprawka 23.09, druga tura: samo ogólne "serwis" bez konkretnego wskaźnika powtarzalności PONOWNIE nie wystarcza', () => {
    expect(block).toMatch(/Automatyczny abonament oraz hasło „serwis" liczą się TYLKO gdy towarzyszy im choć jedno\s+konkretne słowo\/fraza wskazująca powtarzalność/);
    expect(block).toMatch(/sam bierny opis\s+"oferujemy serwis" bez takiego wskaźnika to za mało/);
  });

  test('przy niepewności: liczy się obecność JAKIEGOKOLWIEK wskaźnika powtarzalności (choćby słabego)', () => {
    expect(block).toMatch(/Przy niepewności, gdy jakiś wskaźnik\s+powtarzalności jest obecny \(choćby słaby\), wybieraj true/);
  });
});

// Zasada recall-first (23.09) żyje RAZ, w nagłówku promptu wspólnym dla
// wszystkich sygnałów tenanta (PROMPT_STATIC_HEADER) — nie duplikowana w
// każdej definicji z osobna. Ten blok pilnuje, żeby nikt jej stamtąd
// przypadkiem nie usunął przy przyszłej edycji.
describe('PROMPT_STATIC_HEADER — wspólna zasada recall-first (23.09)', () => {
  test('nakazuje ocenę semantyczną i preferencję TRUE przy rozsądnej niepewności', () => {
    expect(PROMPT_STATIC_HEADER).toMatch(/recall-first — decyzja biznesowa 2026-09-23/);
    expect(PROMPT_STATIC_HEADER).toMatch(/Wiarygodna, konkretna przesłanka biznesowa WYSTARCZA do true/);
    expect(PROMPT_STATIC_HEADER).toMatch(/Przy rozsądnej niepewności.*wybieraj TRUE, nie FALSE/s);
  });

  test('zachowuje podłogę: zero konkretnej przesłanki w tekście nadal NIE wystarcza', () => {
    expect(PROMPT_STATIC_HEADER).toMatch(/NIGDY nie ustawiaj true bez ŻADNEJ konkretnej przesłanki z treści/);
  });

  test('nie zawiera już starej, precyzyjnej zasady głównej ("każdy sygnał potrzebuje KONKRETNEGO DOWODU... nie zgaduj w żadną stronę")', () => {
    expect(PROMPT_STATIC_HEADER).not.toMatch(/Nie zgaduj w żadną stronę/);
  });

  // Trzecia tura (23.09) — dodana po benchmarku 100 firm: case Izoserwis
  // pokazał, że jeden fakt ("biuro projektowe") uzasadniał jednocześnie dwa
  // różne sygnały. Zasada żyje RAZ w nagłówku, nie duplikowana per sygnał.
  test('ZASADA NIEZALEŻNOŚCI DOWODU (trzecia tura): jeden fragment zapala kilka sygnałów tylko przy osobnym sensie biznesowym', () => {
    expect(PROMPT_STATIC_HEADER).toMatch(/ZASADA NIEZALEŻNOŚCI DOWODU \(2026-09-23, trzecia tura\)/);
    expect(PROMPT_STATIC_HEADER).toMatch(/nie może automatycznie\s+zapalać kilku różnych\s+sygnałów naraz/);
  });
});
