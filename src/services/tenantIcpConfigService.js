'use strict';
// ─────────────────────────────────────────────────────────────────
// services/tenantIcpConfigService.js
//
// Config service dynamicznego ICP per tenant — CRUD/versioning sygnałów w bazie.
// Celowo NIE dotyka SYSTEM_PROMPT/kontraktu AI/calcIcpScore() — to
// prospectEnrichmentService.js.
//
// Model danych (migracje 0285/0286):
//   tenant_icp_signals         — LIVE, edytowalny stan roboczy admina. Może być
//                                 CHWILOWO invalid (np. suma punktów w trakcie
//                                 przenoszenia punktów między sygnałami) — to
//                                 NIGDY nie wpływa na enrichment.
//   tenant_icp_config_versions — APPEND-ONLY snapshoty, ale zapisywane WYŁĄCZNIE
//                                 gdy LIVE jest poprawny (signals_sum == wymagana
//                                 suma) — ta tabela oznacza tylko konfiguracje,
//                                 które faktycznie MOGŁY być użyte do enrichmentu.
//   tenant_icp_configs         — jeden wiersz per tenant:
//                                 qualification_threshold (LIVE), current_version_id
//                                 (wskaźnik na ostatnią PUBLISHED, poprawną wersję),
//                                 config_revision (licznik KAŻDEJ LIVE mutacji,
//                                 niezależny od numeru opublikowanej wersji).
//
// DWIE ścieżki odczytu — nie mylić:
//   getActiveConfig(tenantId)    → LIVE, do panelu admina/edycji. Może być invalid.
//   getPublishedConfig(tenantId) → ostatnia PUBLISHED, poprawna wersja. JEDYNA,
//                                   której wolno używać do enrichmentu (patrz
//                                   prospectEnrichmentService.enrichOne()).
//
// Każda mutacja LIVE (add/update/toggle/reorder/delete sygnału, zmiana progu):
//   1. advisory lock per tenant (serializacja współbieżnych edycji),
//   2. sprawdza expected_revision względem tenant_icp_configs.config_revision
//      (optimistic concurrency dla EDYCJI ROBOCZEJ — 409 nawet gdy LIVE jest
//      akurat invalid, bo to i tak realna zmiana, którą można nadpisać cudzą),
//   3. wykonuje zmianę w tenant_icp_signals / tenant_icp_configs,
//   4. bumpRevisionAndMaybePublish(): zawsze +1 do config_revision; TWORZY nową
//      wersję i atomowo przestawia current_version_id NA NIĄ tylko jeśli po
//      zmianie signals_sum == wymagana suma — inaczej current_version_id
//      (i cała historia PUBLISHED) zostaje bez zmian, enrichment nic nie zauważa.
// Wszystko w JEDNEJ transakcji DB (db.transaction()).
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');

const DEFAULT_QUALIFICATION_THRESHOLD = 45;

// Ten serwis CELOWO nie zna "wymaganej" sumy punktów sygnałów (dawniej tu
// leżały zduplikowane GATES_MAX_SCORE=20/BONUS_MAX_SCORE=10/SIGNALS_MAX_SCORE=70
// — poprawka po code review: to duplikowało ICP_MAX_GATE_SCORE/ICP_BONUS_SIGNALS,
// które i tak są jedynym źródłem prawdy w prospectEnrichmentService.js, więc
// zmiana liczby/punktów bramek lub bonusów tam NIGDY nie zaktualizowałaby tej
// kopii). getActiveConfig() zwraca tylko surowe `maxScore` (sumę punktów
// aktywnych sygnałów) — czy to jest "poprawne" ocenia
// prospectEnrichmentService.evaluateIcpConfigValidity(), która liczy
// requiredSignalsMax = ICP_REQUIRED_SIGNALS_MAX_SCORE (decyzja 2026-09-22:
// stałe 100, niezależne od gates/bonus — patrz komentarz przy tej stałej)
// z ICH stałych, a nie z osobnej kopii tutaj.

// Fallback dla tenanta bez własnego configu w tenant_icp_signals (np. race
// condition tuż po utworzeniu tenanta, zanim migracja/seed go obejmie).
// 1:1 kopia 8 sygnałów CRMtree — te same key/label/ai_definition/points/tier
// co w migracji 0285 i w ICP_SIGNALS (prospectEnrichmentService.js). id-y
// poniżej to stałe placeholdery UŻYWANE WYŁĄCZNIE w tym trybie fallback —
// żaden realny tenant po migracji 0285 ich nie ma (ma własne, wylosowane
// gen_random_uuid()), więc nigdy się nie mieszają z prawdziwymi danymi.
const DEFAULT_SIGNALS = Object.freeze([
  {
    id: '00000000-0000-4000-8000-000000000001',
    key: 'dzial_handlowy',
    label: 'Dział handlowy',
    ai_definition:
      'TRUE oznacza REALNĄ funkcję sprzedażową — nie dowolny ślad biznesowy (poprawka 23.09, ' +
      'trzecia tura). Interpretuj semantycznie, nie wymagaj dosłownego zwrotu "dział handlowy": ' +
      '"dział sprzedaży", "sales team", "sales department", "zespół sprzedaży", "przedstawiciele ' +
      'handlowi" i ich funkcjonalne odpowiedniki liczą się tak samo. ' +
      'Główny dowód, dowolne z poniższych: (a) jawnie nazwany dział/zespół sprzedaży lub handlowy ' +
      '(nagłówek podstrony, sekcja, nazwa w strukturze firmy) — wystarcza nawet przy jednej ' +
      'widocznej osobie pod tym nagłówkiem, bo dowodem jest nazwana struktura, nie liczba osób; ' +
      '(b) co najmniej DWÓCH nazwanych handlowców/przedstawicieli/account managerów, nawet bez ' +
      'nagłówka działu; (c) POJEDYNCZA osoba sprzedażowa, JEŚLI kontekst (opis roli, zakres ' +
      'obowiązków, sposób przedstawienia — nie sam tytuł) pokazuje, że REALNIE prowadzi sprzedaż/ ' +
      'ofertowanie/pozyskiwanie klientów; (d) struktura funkcjonalnie pełniąca rolę sprzedaży mimo ' +
      'innej nazwy, jeśli jest OSOBNO opisana jako odpowiedzialna za pozyskiwanie/finalizowanie ' +
      'zamówień klientów (nie tylko nazwana podobnie z nazwy). ' +
      'NIE WYSTARCZA SAMODZIELNIE, nawet jeśli to jedyny dostępny ślad (poprawka 23.09, trzecia ' +
      'tura): sama osoba "Dyrektor Handlowy"/"Dyrektor ds. Handlowych" wymieniona np. w składzie ' +
      'zarządu, BEZ żadnego opisu, że realnie prowadzi sprzedaż — sam tytuł członka zarządu bez ' +
      'opisu roli to za mało, mogła objąć funkcję czysto nadzorczą; sekcja/strona "Dla firm"/"Dla ' +
      'biznesu" (to oferta kierowana do biznesu, nie dowód na istnienie działu sprzedaży); sam ' +
      'formularz kontaktowy lub formularz wyceny; sam adres sprzedaz@/sales@ (może być zwykłą ' +
      'ogólną skrzynką); ogólne "biuro"/"obsługa zleceń" (to może być administracja/logistyka, nie ' +
      'sprzedaż); samo Biuro Obsługi Klienta (BOK); samo biuro projektowe/dział B+R/dział techniczny ' +
      '(to zdolność projektowo-inżynierska, nie sprzedażowa); ogólne hasło "doradztwo techniczno- ' +
      'handlowe" BEZ wskazania konkretnych ludzi lub struktury odpowiedzialnej za sprzedaż. ' +
      'Powyższe wykluczenia mogą się WZAJEMNIE WSPIERAĆ tylko jeśli razem opisują TĘ SAMĄ, realną ' +
      'funkcję sprzedażową (np. "dział handlowy: sprzedaz@firma.pl" — dział już nazwany, adres to ' +
      'tylko dodatkowy kontakt do niego) — żadne z nich osobno nie zastępuje głównego dowodu, i nie ' +
      'sumuj kilku wykluczeń w nadzieję, że razem złożą się na dowód, jeśli żadne nie opisuje realnej ' +
      'sprzedaży. ZWRÓĆ FALSE, gdy jedyne dostępne ślady to wyłącznie pozycje z listy wykluczeń, bez ' +
      'żadnego głównego dowodu obok nich.',
    short_description: 'Jawnie nazwany dział/zespół sprzedaży albo kilka konkretnych osób pełniących role handlowe.',
    points: 30,
    tier: 'wysoka',
    active: true,
    sort_order: 1,
    requires_any_of: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    key: 'zlozony_proces_sprzedazy',
    label: 'Indywidualna wycena',
    ai_definition:
      'Relacyjny, projektowy lub negocjacyjny model PROCESU SPRZEDAŻY, nie zakup impulsowy. ' +
      'GRANICA (interpretuj semantycznie, nie tylko dosłownie): cena/oferta jest ustalana w jakimś ' +
      'stopniu INDYWIDUALNIE, na podstawie potrzeb/specyfikacji konkretnego klienta — nie musi być ' +
      'to jawnie nazwane "wyceną indywidualną", wystarczy wiarygodny opis wskazujący na ten sam ' +
      'mechanizm innymi słowami. ' +
      'Główny dowód (wystarcza sam), dowolne z poniższych LUB semantyczny odpowiednik: indywidualna ' +
      'oferta/wycena; przygotowanie oferty po poznaniu wymagań klienta; RFQ/zapytanie ofertowe ' +
      'prowadzące do oferty; negocjowanie warunków/ceny; elastyczne/dostosowywane do klienta ' +
      'warunki współpracy, umowy "szyte na miarę". ' +
      'Drugorzędne wsparcie (poprawka 23.09, druga tura — NIE wystarcza samo, potrzebuje obok ' +
      'siebie choć śladu, że oferta/cena faktycznie jest przygotowywana indywidualnie, nie ' +
      'standardowo): generyczne frazy CTA typu "zapytaj o ofertę", "poproś o wycenę", ' +
      '"przygotujemy ofertę", "skontaktuj się w sprawie oferty/wyceny", "zapytaj o warunki ' +
      'współpracy", sam kontakt do działu sprzedaży/ofert bez dalszego kontekstu — te wskazują na ' +
      'kanał kontaktu, ale same nie potwierdzają, że wycena jest indywidualna, a nie standardowa ' +
      'odpowiedź na zapytanie. ' +
      'Jeśli jedyny dostępny dowód to sam dobór/rekomendacja rozwiązania bez ŻADNEJ wzmianki o ' +
      'etapie oferty/ceny — to wciąż przede wszystkim dowód dla konsultacja_demo; ale gdy tekst ' +
      'łączy dobór rozwiązania Z choćby pośrednią wzmianką o dalszym etapie wyceny/umowy, licz to ' +
      'też tutaj. ' +
      'ZWRÓĆ FALSE: jawna, stała cena KONKRETNEGO produktu/usługi (cennik, cena jednostkowa w ' +
      'sklepie/katalogu) — to nadal standardowa sprzedaż, NAWET jeśli produkt jest sprzedawany ' +
      'firmom, chyba że firma OSOBNO opisuje proces ofertowy dla innej usługi (wtedy oceniaj tę ' +
      'drugą niezależnie). Przy braku jawnego cennika ORAZ przy braku jakiejkolwiek wzmianki o ' +
      'procesie ofertowym — przechyl się w stronę TRUE, jeśli firma jednoznacznie sprzedaje B2B ' +
      'produkty/usługi o charakterze projektowym, złożonym lub wymagającym dopasowania (nie dla ' +
      'prostych, jednorodnych produktów/usług o oczywistej standardowej cenie).',
    short_description: 'Firma przygotowuje ofertę, wycenę lub warunki indywidualnie dla konkretnego klienta.',
    points: 25,
    tier: 'wysoka',
    active: true,
    sort_order: 2,
    requires_any_of: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    key: 'konsultacja_demo',
    label: 'Konsultacja / demo',
    ai_definition:
      'TRUE wymaga choć JEDNEJ realnej interakcji przedsprzedażowej z klientem — rozmowy/analizy/ ' +
      'doboru PRZED złożeniem zamówienia, nie samej możliwości kontaktu (poprawka 23.09, trzecia ' +
      'tura). Interpretuj semantycznie: jeśli kontekst rzeczywiście opisuje interakcję i ' +
      'dopasowywanie rozwiązania do klienta, wybieraj TRUE nawet bez słowa "konsultacja" — ale sama ' +
      'możliwość kontaktu, bez opisu, że ktoś faktycznie analizuje/dobiera rozwiązanie, to za mało. ' +
      'Główny dowód (dosłowna fraza LUB semantyczny odpowiednik): analiza potrzeb klienta; dobór ' +
      'rozwiązania/produktu do wymagań klienta; konsultacja (płatna lub bezpłatna); doradztwo przy ' +
      'wyborze; wizja lokalna przed realizacją; demo/prezentacja produktu; wspólne projektowanie/ ' +
      'ustalanie rozwiązania z klientem; kontakt ze specjalistą/doradcą W CELU dobrania rozwiązania ' +
      '(nie ogólny kontakt handlowy); przypisany doradca/opiekun/dyrektor regionalny opisany jako ' +
      'wspierający wybór rozwiązania, nawet bez słowa "konsultacja"; formularz zbierający ' +
      'SZCZEGÓŁOWE parametry techniczne zamówienia (RFQ) — nie sam ogólny formularz kontaktowy. ' +
      'NIE WYSTARCZA SAMODZIELNIE, nawet jeśli to jedyny dostępny ślad (poprawka 23.09, trzecia ' +
      'tura): samo "skontaktuj się z nami"/"przedstawimy ofertę"/"zapytaj o ofertę" — to zaproszenie ' +
      'do kontaktu, nie dowód analizy/doboru; sam formularz kontaktowy lub ofertowy bez opisu, że ' +
      'ktoś po drugiej stronie faktycznie analizuje/dobiera rozwiązanie; samo istnienie biura ' +
      'projektowego (to zdolność projektowa, nie opisany etap rozmowy z klientem — chyba że tekst ' +
      'OSOBNO opisuje, że biuro projektowe prowadzi rozmowę/analizę z klientem przed realizacją, nie ' +
      'tylko projektuje); sam produkt "na wymiar"/"pod klienta" bez opisanej interakcji (patrz ' +
      'GRANICA niżej); ogólne marketingowe hasło "indywidualne podejście do klienta" bez opisu ' +
      'konkretnego etapu/osoby/procesu. ' +
      'GRANICA (produkcja na wymiar): produkcja/usługa "na wymiar", "pod klienta", "na życzenie ' +
      'klienta" NIE WYSTARCZA SAMA jako opis samej zdolności produkcyjnej — musi towarzyszyć jej ' +
      'choć przesłanka INTERAKCJI z klientem przed realizacją (np. "ustalamy z klientem", "po ' +
      'konsultacji", "na podstawie zgłoszonych wymagań", "dobieramy rozwiązanie", "analizujemy ' +
      'potrzeby klienta") — wtedy liczy się nawet bez opisanego wprost odrębnego „etapu rozmowy”. ' +
      'NIE LICZY SIĘ (to inny etap obsługi, nie sprzedażowy): doradca/opiekun ds. likwidacji ' +
      'szkód, ubezpieczeniowy, reklamacji lub gwarancji, serwisant, doradca serwisowy wsparcia ' +
      'posprzedażowego — to obsługa PO zakupie, nie etap decyzji o zakupie; ogólny, poradnikowy ' +
      'tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada niezwiązana z konkretną ' +
      'usługą/osobą w tej firmie). ' +
      'ZASTRZEŻENIE: nie ustawiaj true wyłącznie z samej nazwy branży bez żadnego punktu ' +
      'zaczepienia w tekście. Jeśli to ten sam fragment tekstu co dowód dla zlozony_proces_sprzedazy ' +
      'lub dzial_handlowy, oceń każdy sygnał NIEZALEŻNIE — licz go dla więcej niż jednego sygnału ' +
      'TYLKO jeśli fragment faktycznie opisuje osobne zjawiska biznesowe dla każdego z nich; sama ' +
      'ogólna wzmianka o biurze projektowym/obsłudze klienta/doradztwie nie może automatycznie ' +
      'zapalać kilku sygnałów naraz.',
    short_description: 'Przed zakupem występuje realny etap doradztwa, analizy potrzeb, doboru rozwiązania lub demo.',
    points: 15,
    tier: 'wysoka',
    active: true,
    sort_order: 3,
    requires_any_of: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    key: 'opieka_nad_klientem',
    label: 'Dedykowana opieka',
    ai_definition:
      'TRUE oznacza REALNĄ, TRWAŁĄ odpowiedzialność za KONKRETNEGO klienta/konto/relację — nie ' +
      'dowolną formę kontaktu z klientem (poprawka 23.09, czwarta tura). Interpretuj semantycznie: ' +
      'nie wymagaj dosłownego słowa "opiekun"/"KAM", wystarczy wiarygodny opis pełniący tę samą ' +
      'funkcję — ale musi z niego wynikać, że ktoś POZOSTAJE odpowiedzialny za danego klienta, a ' +
      'nie tylko z nim rozmawia, sprzedaje mu albo obsługuje jego zlecenie. ' +
      'Główny dowód (dowolne z poniższych, także bez słowa "opiekun"): "dedykowany opiekun", ' +
      '"opiekun biznesowy", "opiekun klienta", Key Account Manager (KAM), account manager, ' +
      '"Specjalista ds. Kluczowych Klientów", Customer Success, "stała opieka nad klientem", ' +
      'opieka handlowa B2B; osoba prowadząca konto klienta; dedykowany/stały kontakt przypisany do ' +
      'konkretnego klienta; specjalista/konsultant PRZYPISANY do konkretnego klienta lub jego ' +
      'branży (np. "kontakt z konsultantem odpowiedzialnym za daną branżę"). ' +
      'NIE WYSTARCZA SAMODZIELNIE (poprawka 23.09, czwarta tura — każdy z tych przypadków realnie ' +
      'wystąpił w benchmarku jako fałszywe TRUE): przypisanie przedstawiciela/handlowca TYLKO do ' +
      'REGIONU/terytorium/województwa — to podział rynku dla pozyskiwania sprzedaży, nie trwała ' +
      'odpowiedzialność za już pozyskanego klienta (dotyczy to także osoby nazwanej "opiekunem ' +
      'regionalnym"/"terytorialnym" — liczy się dopiero, gdy z tekstu OSOBNO wynika opieka nad ' +
      'KLIENTEM, nie nad obszarem); ogólne hasło "stała współpraca"/"wieloletnia współpraca" bez ' +
      'wskazania osoby lub roli odpowiedzialnej za klienta; "partner biznesowy"/"dedykowany ' +
      'partner"/"trusted partner" bez informacji, kto i w jakiej formie opiekuje się konkretnym ' +
      'klientem; rola OPERACYJNA (dyspozytor, koordynator transportu, planista, obsługa zleceń) — ' +
      'to prowadzenie procesu/zlecenia, nie relacji z klientem; rola TECHNICZNA (serwisant, ' +
      'wdrożeniowiec, tester, inżynier wsparcia) — to obsługa produktu, nie konta klienta; zwykły ' +
      'handlowiec/sprzedawca BEZ żadnej przesłanki, że pozostaje odpowiedzialny za klienta PO ' +
      'pozyskaniu; sama funkcja Kierownika/Dyrektora Sprzedaży — to zarządzanie zespołem. ' +
      'Każdy z powyższych liczy się DOPIERO wtedy, gdy tekst DODATKOWO wskazuje na ciągłą ' +
      'odpowiedzialność za konkretnego klienta/konto. Oferty pracy na role z głównego dowodu liczą ' +
      'się tak samo jak opis usługi na stronie. ' +
      'ZWRÓĆ FALSE: ogólne, niezróżnicowane Biuro Obsługi Klienta/infolinia BEZ wzmianki o ' +
      'przypisanej osobie/koncie. Sama opieka powdrożeniowa/serwis/odnowienia BEZ żadnej wzmianki ' +
      'o osobie odpowiedzialnej to przede wszystkim dowód dla cykliczna_obsluga_klienta_odnowienia ' +
      '(CO się dzieje), nie dla tego sygnału (KTO jest odpowiedzialny) — oceniaj oba niezależnie, ' +
      'ale gdy tekst łączy oba wątki, oba mogą wyjść true.',
    short_description: 'Konkretny opiekun/KAM/osoba lub zespół jest stale odpowiedzialny za klienta, konto albo segment.',
    points: 10,
    tier: 'wysoka',
    active: true,
    sort_order: 4,
    requires_any_of: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    key: 'przetargi',
    label: 'Przetargi',
    ai_definition:
      'Firma SPRZEDAJE w przetargach jako wykonawca/dostawca — UWAGA, częsta pomyłka w obie ' +
      'strony (KIERUNEK jest tu logiczną sprzecznością, nie kwestią interpretacji — nie zmieniaj ' +
      'go mimo ogólnej zasady recall-first). Dowód pozytywny (true): jawny lub semantycznie ' +
      'równoważny opis REALNEGO udziału w postępowaniu przetargowym JAKO WYKONAWCA/OFERENT/ ' +
      'DOSTAWCA — "realizujemy zamówienia publiczne", "oferta dla sektora publicznego", ' +
      '"doświadczenie w przetargach", "specjalista ds. przetargów/ofertowania", "startujemy w ' +
      'przetargach", "oferty przetargowe", "wygraliśmy przetarg" — nie wymagaj dosłownie słowa ' +
      '"przetarg", ale wymagaj choć POŚREDNIEJ wzmianki o trybie postępowania/zamówienia/konkursu ' +
      'ofert (np. "wygrany konkurs ofert", "zamówienie w trybie ustawy PZP", "postępowanie o ' +
      'udzielenie zamówienia"). ' +
      'NIE WYSTARCZA (poprawka 23.09, druga tura): samo duże/liczne portfolio klientów/ ' +
      'zamawiających publicznych (gminy, urzędy, spółki Skarbu Państwa) BEZ ŻADNEJ wzmianki o ' +
      'trybie pozyskania kontraktu — to nadal dowód na OBSŁUGĘ sektora publicznego, nie na SPOSÓB ' +
      'jego pozyskania, niezależnie od liczby takich klientów; firma mogła ich zdobyć bez żadnego ' +
      'przetargu. NIE liczy się, nawet jeśli słowo "przetarg" występuje (to firma ' +
      'KUPUJĄCA, zwróć false): "postępowania zakupowe", "zamówienia dla dostawców", "przetargi ' +
      'organizowane przez nas", "profil nabywcy".',
    short_description: 'Firma występuje jako wykonawca/dostawca w przetargach, nie jako zamawiający.',
    points: 5,
    tier: 'wysoka',
    active: true,
    sort_order: 5,
    requires_any_of: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    key: 'rozproszona_struktura',
    label: 'Rozproszona struktura',
    ai_definition:
      'Zespół lub sieć sprzedaży fizycznie rozproszona terytorialnie, WYŁĄCZNIE WŁASNA (ten sam ' +
      'podmiot/firma — nie osobne podmioty, nawet powiązane kapitałowo). Oddział/przedstawicielstwo ' +
      'tej samej firmy ZA GRANICĄ nadal się liczy jako własne — to NIE jest ' +
      'automatycznie inny podmiot tylko dlatego, że działa w innym kraju (nie wymagaj polskiego ' +
      'NIP/KRS, żeby uznać zagraniczny oddział za "własny" — firma może mieć oddział/ ' +
      'przedstawicielstwo bez odrębnej polskiej rejestracji). ' +
      'Główny dowód: oficjalne oddziały, biura regionalne lub placówki firmy w kilku miastach — ' +
      'to WYSTARCZA samo w sobie, nawet bez podanych nazwisk osób przy adresach. Przypisani ' +
      'regionalni handlowcy/przedstawiciele zwiększają pewność, ale NIE są warunkiem koniecznym. ' +
      'JAK ODRÓŻNIĆ własny zagraniczny oddział od spółki z grupy (częsta pomyłka): oddział/ ' +
      'przedstawicielstwo TEJ SAMEJ firmy jest opisany jako część JEJ struktury (np. "Oddział ' +
      'Niemcy", "przedstawicielstwo w Hiszpanii" pod tą samą nazwą firmy) — to liczy się jako ' +
      'własne. Jeśli natomiast lokalizacja w innym kraju ma WŁASNĄ, ODRĘBNĄ nazwę firmy z lokalną ' +
      'formą prawną (np. "[Nazwa]-Werk GmbH", "[Nazwa] Kft.", "[Nazwa] S.L.", "[Nazwa] AG", ' +
      '"[Nazwa] Sp. z o.o." obok głównej "[Nazwa] S.A.") — to jest OSOBNY PODMIOT GRUPY ' +
      'KAPITAŁOWEJ, nie własny oddział badanej spółki, NAWET jeśli działa pod tą samą marką/nazwą ' +
      'i jest wymieniony na tej samej stronie kontaktowej. Sama przynależność do ' +
      'międzynarodowej grupy/sieci spółek o wspólnej marce NIE wystarcza — lista krajów lub ' +
      'spółek grupy to nie własna sieć oddziałów badanej firmy. ' +
      'NIE liczy się (to nie własne oddziały tej firmy): lokalizacje realizacji/projektów u ' +
      'klientów, siedziby klientów, adresy zewnętrznych partnerów/dealerów/niezależnych ' +
      'dystrybutorów (nawet zagranicznych, nawet z "recognized distributor" w opisie), ani ' +
      'spółki-siostry/spółki z tej samej grupy kapitałowej (to osobne podmioty prawne — rozpoznaj ' +
      'je po odrębnej nazwie firmy/formie prawnej, patrz wyżej).',
    short_description: 'Firma ma własne, fizycznie rozproszone oddziały lub przedstawicieli terytorialnych.',
    points: 5,
    tier: 'srednia',
    active: false, // decyzja 2026-09-22: wyłączony w nowym DEFAULT_SIGNALS (schemat Gold)
    sort_order: 6,
    requires_any_of: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000007',
    key: 'siec_partnerow',
    label: 'Sieć partnerów',
    ai_definition:
      'KLUCZOWY WARUNEK — KIERUNEK RELACJI (to logiczna sprzeczność, nie kwestia interpretacji — ' +
      'nie zmieniaj tego mimo ogólnej zasady recall-first): sygnał dotyczy WYŁĄCZNIE sytuacji, w ' +
      'której BADANA FIRMA jest DOSTAWCĄ posiadającym/organizującym WŁASNĄ, zewnętrzną sieć ' +
      'sprzedaży — niezależne podmioty (dealerzy, dystrybutorzy, resellerzy, partnerzy handlowi), ' +
      'które ODSPRZEDAJĄ PRODUKTY LUB USŁUGI TEJ FIRMY. Zanim uznasz dowód za wystarczający, ustal ' +
      'kto jest dostawcą, a kto odsprzedawcą w opisanej relacji — sam fakt użycia słowa "partner"/ ' +
      '"dealer"/"dystrybutor" NIE wystarcza, jeśli kierunek relacji jest inny albo niesprzedażowy. ' +
      'Poza tym warunkiem kierunku, resztę oceniaj semantycznie i liberalnie — nie wymagaj ' +
      'dosłownych fraz z listy niżej, wystarczy wiarygodny opis tego samego mechanizmu. ' +
      'Główny dowód: "zostań partnerem", "sieć dealerska", "dla dystrybutorów", "strefa partnera" ' +
      'w domenie firmy — w kontekście rekrutacji odsprzedawców JEJ WŁASNYCH produktów/usług — LUB ' +
      'jawnie wymieniona lista niezależnych dystrybutorów/przedstawicieli na rynkach ' +
      'zagranicznych, którzy sprzedają dalej produkty tej firmy. ' +
      'ZASADA POZYTYWNA: jeżeli badana firma zaprasza inne firmy/sprzedawców do sprzedaży lub ' +
      'dystrybucji JEJ WŁASNYCH produktów/usług i opisuje to jako współpracę z dystrybutorami, ' +
      'dealerami, resellerami lub partnerami handlowymi — to jest to true, niezależnie od ' +
      'dokładnego sformułowania. Przykład: "Sprzedajesz nasze produkty / produkty z naszej ' +
      'kategorii? Rozpocznij z nami współpracę" połączone z informacją o modelu współpracy z ' +
      'dystrybutorami — to true, bo badana firma jest tu DOSTAWCĄ/PRODUCENTEM, a zewnętrzny ' +
      'podmiot ma sprzedawać JEJ ofertę. ' +
      'ZWRÓĆ FALSE (częste pomyłki w obie strony): firma SAMA jest dealerem/dystrybutorem/autoryzowanym ' +
      'partnerem CUDZEJ marki (np. "jesteśmy oficjalnym dystrybutorem [producenta ' +
      'X]") — to ONA jest odsprzedawcą, nie dostawcą budującym własną sieć; jej WŁASNY dział ' +
      'montażu/instalacji/serwisu również się nie liczy, to wewnętrzny zespół, nie zewnętrzna ' +
      'sieć; firma REKRUTUJE przewoźników, podwykonawców lub dostawców do współpracy z NIĄ (np. ' +
      '"zostań naszym partnerem" skierowane do przewoźników/poddostawców, którzy będą świadczyć ' +
      'usługę DLA tej firmy) — to ona jest stroną KUPUJĄCĄ usługę/zdolność, nie buduje sieci ' +
      'odsprzedającej jej produkty; "partner" oznacza partnera eventowego, marketingowego, ' +
      'lokalną atrakcję turystyczną lub inną współpracę niesprzedażową (patronat, cross-promocja, ' +
      'sponsoring); ogólne, marketingowe użycie słowa "partner"/"partnerzy" oznaczające KLIENTÓW ' +
      'lub relacje biznesowe w ogóle (np. "budujemy długoterminowe relacje z partnerami na całym ' +
      'świecie", "dostarczamy naszym partnerom niezawodne produkty"); linki do spółek-sióstr/spółek ' +
      'z tej samej grupy kapitałowej — to nie sieć odsprzedawców, tylko wewnętrzna ' +
      'struktura grupy — chyba że tekst wprost opisuje je jako dealerów/dystrybutorów tej firmy, ' +
      'nie jako powiązane firmy. Wymagany jest jawny kontekst NIEZALEŻNEGO podmiotu ' +
      'odsprzedającego/dystrybuującego PRODUKTY/USŁUGI TEJ FIRMY (nie cudzej), nie samo słowo ' +
      '"partner" w dowolnym znaczeniu.',
    short_description: 'Niezależni dealerzy/resellerzy/partnerzy sprzedają ofertę badanej firmy.',
    points: 5,
    tier: 'srednia',
    active: true,
    sort_order: 7,
    requires_any_of: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000008',
    key: 'ecommerce_b2b',
    label: 'E-commerce B2B',
    ai_definition:
      'Realny sklep/panel zamówieniowy w domenie firmy skierowany do klientów BIZNESOWYCH, nie ' +
      'zwykły sklep konsumencki (D2C) z możliwością wpisania NIP-u na fakturze. ' +
      'Główny dowód: sklep lub panel logowania w domenie firmy z co najmniej jedną cechą B2B — ' +
      'ceny netto/"dla firm", wymagana rejestracja firmy/NIP przy zakładaniu konta, rabaty ' +
      'ilościowe/hurtowe dla stałych klientów biznesowych, jawna nazwa "sklep B2B"/"panel B2B"/ ' +
      '"strefa klienta firmowego" — POD WARUNKIEM że tekst potwierdza realną funkcję zamówieniową ' +
      '(logowanie/konto/koszyk/składanie zamówień), nie tylko nazwę. ' +
      'NIE wystarcza: zwykły sklep detaliczny (ceny brutto, zakupy bez konta firmowego) tylko ' +
      'dlatego, że przy zamówieniu można podać NIP do faktury — to nadal sprzedaż D2C. ' +
      'NIE wystarcza: sama etykieta menu/link "Platforma B2B"/"B2B" bez żadnego dalszego opisu w ' +
      'dostępnym tekście, co ta platforma faktycznie robi (zamawianie, logowanie, konto) — nazwa ' +
      'linku w nawigacji to nie potwierdzenie działania panelu, może to być np. osobny produkt ' +
      'firmy (system/platforma techniczna), a nie sklep zamówieniowy. ' +
      'Oceniaj ten sygnał niezależnie od pozostałych, wyłącznie na podstawie dowodu na stronie.',
    short_description: 'Firma ma sklep/platformę zamówieniową B2B z realną obsługą zamówień online.',
    points: 5,
    tier: 'srednia',
    active: false, // decyzja 2026-09-22: wyłączony w nowym DEFAULT_SIGNALS (schemat Gold)
    sort_order: 8,
    // Odpowiedniki DEFAULT_SIGNALS[0].id (dzial_handlowy) i [3].id (opieka_nad_klientem) —
    // w trybie fallback (brak wierszy w bazie) te placeholder-id są jedynymi, względem
    // których requires_any_of może się odnosić. Samo pole requires_any_of od decyzji
    // 2026-09-22 nie wpływa już na scoring (patrz calcIcpScore w prospectEnrichmentService.js)
    // — zostaje jako inertna relacja, tego sygnału to i tak nie dotyczy, bo jest inactive.
    requires_any_of: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004'],
  },
  {
    id: '00000000-0000-4000-8000-000000000009',
    key: 'cykliczna_obsluga_klienta_odnowienia',
    label: 'Cykliczna obsługa',
    ai_definition:
      'Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i ' +
      'występują kolejne zaplanowane zdarzenia wymagające obsługi — interpretuj semantycznie, nie ' +
      'wymagaj dosłownych fraz z listy niżej.\n\n' +
      'TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, ' +
      'kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole, gwarancję z ' +
      'obowiązkowymi przeglądami, wsparcie posprzedażowe opisane jako ciągłe/długoterminowe, albo ' +
      'inne wiarygodnie powtarzalne działania dotyczące tego samego klienta — także gdy wynika to ' +
      'tylko pośrednio z charakteru usługi (np. serwis urządzeń/instalacji zwykle wymaga ' +
      'okresowych przeglądów, nawet bez wprost opisanego harmonogramu).\n\n' +
      'Nie wystarcza sama możliwość ponownego zakupu, newsletter, program lojalnościowy ani samo ' +
      'ogólne hasło „serwis" BEZ żadnego wskazania powtarzalności (poprawka 23.09, druga tura). ' +
      'Automatyczny abonament oraz hasło „serwis" liczą się TYLKO gdy towarzyszy im choć jedno ' +
      'konkretne słowo/fraza wskazująca powtarzalność (np. "cykliczny", "regularny", "okresowy", ' +
      '"odnowienie", "umowa serwisowa", "przegląd co [okres]", "kolejne wizyty") — sam bierny opis ' +
      '"oferujemy serwis" bez takiego wskaźnika to za mało. Przy niepewności, gdy jakiś wskaźnik ' +
      'powtarzalności jest obecny (choćby słaby), wybieraj true.',
    short_description: 'Po sprzedaży występują powtarzalne zdarzenia: przeglądy, serwis, odnowienia, kolejne wizyty itp.',
    points: 10,
    tier: null,
    active: true,
    sort_order: 9,
    requires_any_of: null,
  },
]);

// Konflikt na config_revision (LIVE edycja), NIE na "version" opublikowanej —
// te dwa liczniki są od tej migracji celowo niezależne (patrz nagłówek pliku).
class ConfigRevisionConflictError extends Error {
  constructor(tenantId, expectedRevision, actualRevision) {
    super(
      `Konflikt edycji configu ICP dla tenanta ${tenantId}: oczekiwano config_revision ${expectedRevision}, ` +
      `aktualna to ${actualRevision}. Ktoś inny zmienił roboczą konfigurację w międzyczasie — odśwież i spróbuj ponownie.`,
    );
    this.name = 'ConfigRevisionConflictError';
    this.status = 409;
    this.tenantId = tenantId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

// `.status` na wyjątku pozwala trasom HTTP (admin-tenants.js) zrobić
// `if (err.status) res.status(err.status).json({error: err.message})` bez
// osobnej warstwy mapowania błędów na kody — ten sam wzorzec, co już stosuje
// upsertTenantConfig (whatsappService) w tym samym routerze.
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

// ── Helpers ──────────────────────────────────────────────────────

function computeMaxScore(signals) {
  return (signals || []).reduce((sum, s) => sum + (s.active ? Number(s.points) : 0), 0);
}

function slugifyLabel(label) {
  const base = label
    .toLowerCase()
    // "ł" nie jest kombinacją znak+akcent (NFD go nie rozkłada, w przeciwieństwie do
    // ą/ć/ę/ń/ó/ś/ź/ż) — bez tej podmiany zostałby po prostu wycięty jak spacja,
    // gubiąc literę zamiast transliterować ją na "l" (np. "sygnał" -> "sygna", nie "sygnal").
    .replace(/ł/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 55);
  return base || 'sygnal';
}

const KEY_FORMAT = /^[a-z][a-z0-9_]*$/;

function validateKeyFormat(key) {
  if (typeof key !== 'string' || !KEY_FORMAT.test(key)) {
    throw badRequest('key musi zaczynać się literą i zawierać tylko [a-z0-9_]');
  }
  return key;
}

// Wywoływane WEWNĄTRZ withTenantLock — brak współbieżnych zapisów dla tego
// tenanta w tym momencie, więc pętla jest deterministyczna, nie tylko "best effort".
async function generateUniqueKey(client, tenantId, label) {
  const base = slugifyLabel(label);
  let candidate = base;
  let suffix = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT 1 FROM tenant_icp_signals WHERE tenant_id = $1 AND key = $2`,
      [tenantId, candidate],
    );
    if (rows.length === 0) return candidate;
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
}

async function assertKeyAvailable(client, tenantId, key, excludeId = null) {
  const { rows } = await client.query(
    `SELECT id FROM tenant_icp_signals WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key],
  );
  if (rows.some((r) => r.id !== excludeId)) {
    throw badRequest(`key "${key}" jest już zajęty w konfiguracji tego tenanta`);
  }
}

async function assertRequiresAnyOfValid(client, tenantId, requiresAnyOf, excludeId) {
  if (!Array.isArray(requiresAnyOf) || requiresAnyOf.length === 0) return;
  if (excludeId && requiresAnyOf.includes(excludeId)) {
    throw badRequest('requires_any_of nie może wskazywać na sam siebie');
  }
  const { rows } = await client.query(
    `SELECT id FROM tenant_icp_signals WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, requiresAnyOf],
  );
  if (rows.length !== new Set(requiresAnyOf).size) {
    throw badRequest('requires_any_of zawiera id sygnału spoza konfiguracji tego tenanta');
  }
}

async function nextSortOrder(client, tenantId) {
  const { rows: [{ next }] } = await client.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM tenant_icp_signals WHERE tenant_id = $1`,
    [tenantId],
  );
  return next;
}

function validateNewSignalInput(input) {
  if (!input || typeof input.label !== 'string' || !input.label.trim()) {
    throw badRequest('label jest wymagany');
  }
  if (typeof input.aiDefinition !== 'string' || !input.aiDefinition.trim()) {
    throw badRequest('aiDefinition jest wymagany');
  }
  if (!Number.isInteger(input.points) || input.points < 0) {
    throw badRequest('points musi być nieujemną liczbą całkowitą');
  }
}

const PATCH_COLUMN_MAP = {
  label: 'label',
  aiDefinition: 'ai_definition',
  shortDescription: 'short_description',
  points: 'points',
  tier: 'tier',
  active: 'active',
  sortOrder: 'sort_order',
  requiresAnyOf: 'requires_any_of',
};

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object') throw badRequest('patch musi być obiektem');
  if ('key' in patch) throw badRequest('key jest niezmienny i nie może być edytowany');
  if ('label' in patch && (typeof patch.label !== 'string' || !patch.label.trim())) {
    throw badRequest('label musi być niepustym tekstem');
  }
  if ('aiDefinition' in patch && (typeof patch.aiDefinition !== 'string' || !patch.aiDefinition.trim())) {
    throw badRequest('aiDefinition musi być niepustym tekstem');
  }
  // Opcjonalne — pusty/brak = tooltip w Prospektach pokazuje tylko label.
  if ('shortDescription' in patch && patch.shortDescription !== null && typeof patch.shortDescription !== 'string') {
    throw badRequest('shortDescription musi być tekstem albo null');
  }
  if (typeof patch.shortDescription === 'string' && patch.shortDescription.length > 500) {
    throw badRequest('shortDescription: maksymalnie 500 znaków');
  }
  if ('points' in patch && (!Number.isInteger(patch.points) || patch.points < 0)) {
    throw badRequest('points musi być nieujemną liczbą całkowitą');
  }
}

function buildSetClause(patch, startIndex) {
  const sets = [];
  const values = [];
  let i = startIndex;
  for (const [key, col] of Object.entries(PATCH_COLUMN_MAP)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${col} = $${i}`);
      values.push(patch[key]);
      i += 1;
    }
  }
  return { sets, values };
}

async function withTenantLock(tenantId, fn) {
  return db.transaction(async (client) => {
    // Serializuje WSZYSTKIE mutacje configu ICP tego tenanta — zwalniany
    // automatycznie na COMMIT/ROLLBACK, więc nie wymaga jawnego unlocka.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tenant_icp:${tenantId}`]);
    return fn(client);
  });
}

// config_revision → jedyne źródło prawdy o "stanie roboczej edycji" tego
// tenanta. Celowo NIE version/current_version_id (ten licznik zamraża się,
// gdy LIVE jest invalid — patrz nagłówek pliku) — inaczej dwie kolejne
// invalid-edycje nie zderzyłyby się przez expected_revision.
async function getCurrentRevision(client, tenantId) {
  const { rows: [row] } = await client.query(
    `SELECT config_revision FROM tenant_icp_configs WHERE tenant_id = $1`,
    [tenantId],
  );
  return row ? row.config_revision : 0; // 0 = tenant nigdy jeszcze nie edytował LIVE configu
}

async function assertExpectedRevision(client, tenantId, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) return; // caller świadomie pomija sprawdzenie
  const current = await getCurrentRevision(client, tenantId);
  if (current !== expectedRevision) {
    throw new ConfigRevisionConflictError(tenantId, expectedRevision, current);
  }
}

// JEDYNE źródło prawdy dla progu kwalifikacji — app_settings.prospect_lead_min_score,
// dokładnie ten sam klucz i domyślna wartość (45) co getMinScore() w
// crm-prospects-dashboard.js (bucketowanie dashboardu) i minLeadScore() we
// froncie (admin-prospects.component.ts, gate przycisku "→ Lead"). ŚWIADOMA
// decyzja (2026-09, po audycie): tenant_icp_configs.qualification_threshold był
// martwym duplikatem — nigdy nieczytanym przez realny enrichment ani żadną inną
// logikę — więc NIE jest już niezależnie edytowalny (patrz brak
// setQualificationThreshold poniżej i brak PUT /icp-threshold w admin-tenants.js).
// Kolumna qualification_threshold w tenant_icp_configs zostaje w schemacie
// (ma DEFAULT 45, nic jej nie psuje), ale już nic do niej nie zapisuje ani nie
// czyta jej jako źródła — usunięcie migracją nie było warte narzutu przy tak
// małej zmianie. Jeśli klucz w app_settings kiedyś zmieni nazwę, zmień w OBU
// miejscach naraz (tu i w crm-prospects-dashboard.js), inaczej znów rozjadą się
// dwa niezależne progi.
async function getTenantQualificationThreshold(tenantId, queryable = db) {
  const { rows } = await queryable.query(
    `SELECT value FROM app_settings WHERE key = 'prospect_lead_min_score' AND tenant_id = $1`,
    [tenantId],
  );
  const parsed = parseInt(rows[0]?.value, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_QUALIFICATION_THRESHOLD;
}

// Rdzeń każdej mutacji LIVE — wołane PO zapisaniu zmiany w tenant_icp_signals,
// w tej samej transakcji:
//   1. config_revision zawsze +1 (niezależnie od tego, czy wynik jest poprawny),
//   2. jeśli signals_sum aktywnych sygnałów == wymagana suma → PUBLIKUJE: nowy
//      wiersz w tenant_icp_config_versions (z ZAMROŻONYM na ten moment
//      prospect_lead_min_score) + current_version_id na niego,
//   3. jeśli NIE → current_version_id/version zostają DOKŁADNIE jak były —
//      enrichOne() (getPublishedConfig) nic nie zauważa, dalej używa starej,
//      poprawnej wersji. Invalid stan NIGDY nie trafia do tenant_icp_config_versions
//      (ta tabela oznacza wyłącznie configi, które faktycznie mogły być użyte).
async function bumpRevisionAndMaybePublish(client, tenantId, createdBy = null) {
  const { rows: [cfgRow] } = await client.query(
    `INSERT INTO tenant_icp_configs (tenant_id, config_revision, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET config_revision = tenant_icp_configs.config_revision + 1, updated_at = now()
     RETURNING config_revision, current_version_id`,
    [tenantId],
  );

  const { rows: signalRows } = await client.query(
    `SELECT id, key, label, ai_definition, short_description, points, tier, active, sort_order, requires_any_of
       FROM tenant_icp_signals
      WHERE tenant_id = $1
      ORDER BY sort_order, created_at`,
    [tenantId],
  );
  const maxScore = computeMaxScore(signalRows);
  const qualificationThreshold = await getTenantQualificationThreshold(tenantId, client);

  // Lazy require (nie top-level): prospectEnrichmentService.js już requires
  // tenantIcpConfigService.js na starcie procesu, żeby budować prompty/scoring —
  // top-level require w drugą stronę zapętliłby się na niepełnych exports.
  // W momencie gdy JAKAKOLWIEK mutacja faktycznie się wykonuje, oba moduły są
  // już w pełni załadowane, więc ten require() tylko czyta gotowy cache.
  const { ICP_REQUIRED_SIGNALS_MAX_SCORE } = require('./prospectEnrichmentService');

  if (maxScore !== ICP_REQUIRED_SIGNALS_MAX_SCORE) {
    return { configRevision: cfgRow.config_revision, published: false, version: null };
  }

  const { rows: [{ next_version: nextVersion }] } = await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM tenant_icp_config_versions
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const snapshot = signalRows.map((s) => ({
    id: s.id,
    key: s.key,
    label: s.label,
    ai_definition: s.ai_definition,
    short_description: s.short_description,
    points: s.points,
    tier: s.tier,
    active: s.active,
    sort_order: s.sort_order,
    requires_any_of: s.requires_any_of,
  }));
  const { rows: [version] } = await client.query(
    `INSERT INTO tenant_icp_config_versions
       (tenant_id, version, qualification_threshold, max_score, snapshot, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [tenantId, nextVersion, qualificationThreshold, maxScore, JSON.stringify(snapshot), createdBy],
  );
  await client.query(
    `UPDATE tenant_icp_configs SET current_version_id = $2, updated_at = now() WHERE tenant_id = $1`,
    [tenantId, version.id],
  );

  return { configRevision: cfgRow.config_revision, published: true, version };
}

// Sygnał liczy się jako "miał historię" gdy jego id występuje w KTÓRYMKOLWIEK
// opublikowanym snapshocie tego tenanta — czyli mógł realnie zostać użyty do
// enrichmentu (patrz deleteSignal). jsonb_array_elements zamiast @> na całej
// tablicy: @> na array-of-objects wymaga dopasowania całego obiektu-elementu,
// nie samego pola "id" — niejednoznaczne, więc jawny EXISTS jest bezpieczniejszy.
async function wasSignalEverPublished(client, tenantId, signalId) {
  const { rows } = await client.query(
    `SELECT 1
       FROM tenant_icp_config_versions v, jsonb_array_elements(v.snapshot) elem
      WHERE v.tenant_id = $1 AND elem->>'id' = $2
      LIMIT 1`,
    [tenantId, signalId],
  );
  return rows.length > 0;
}

// ── Odczyt ───────────────────────────────────────────────────────

// LIVE — roboczy stan edytowany w panelu admina. Może być CHWILOWO invalid
// (signals_sum != wymagana suma) — to nie jest błąd, to normalny stan w
// trakcie edycji. NIGDY nie używać tego do faktycznego enrichmentu — do tego
// służy getPublishedConfig() niżej.
async function getActiveConfig(tenantId) {
  const { rows: signalRows } = await db.query(
    `SELECT id, key, label, ai_definition, short_description, points, tier, active, sort_order, requires_any_of
       FROM tenant_icp_signals
      WHERE tenant_id = $1
      ORDER BY sort_order, created_at`,
    [tenantId],
  );

  const { rows: [cfg] } = await db.query(
    `SELECT current_version_id, config_revision
       FROM tenant_icp_configs
      WHERE tenant_id = $1`,
    [tenantId],
  );
  // Zawsze live z app_settings.prospect_lead_min_score — patrz komentarz przy
  // getTenantQualificationThreshold(). NIE czytamy tu tenant_icp_configs
  // .qualification_threshold — ta kolumna jest martwa/nieaktualizowana.
  const qualificationThreshold = await getTenantQualificationThreshold(tenantId);

  // maxScore = surowa suma punktów AKTYWNYCH sygnałów, bez żadnego osądu, czy to
  // "poprawna" wartość — ten serwis nie zna gates/bonus, więc nie ocenia. Do tego
  // służy prospectEnrichmentService.evaluateIcpConfigValidity(getActiveConfig(...)).
  if (signalRows.length === 0) {
    return {
      signals: DEFAULT_SIGNALS,
      activeSignals: DEFAULT_SIGNALS.filter((s) => s.active),
      qualificationThreshold,
      maxScore: computeMaxScore(DEFAULT_SIGNALS),
      currentVersionId: null,
      configRevision: cfg?.config_revision ?? 0,
      isDefault: true,
    };
  }

  return {
    signals: signalRows,
    activeSignals: signalRows.filter((s) => s.active),
    qualificationThreshold,
    maxScore: computeMaxScore(signalRows),
    currentVersionId: cfg?.current_version_id ?? null,
    configRevision: cfg?.config_revision ?? 0,
    isDefault: false,
  };
}

// PUBLISHED — ostatnia poprawna, opublikowana wersja. JEDYNA funkcja, której
// wolno używać do faktycznego enrichmentu (patrz prospectEnrichmentService
// .enrichOne()) — całkowicie odporna na to, że admin akurat edytuje LIVE
// config gdzieś w innej karcie przeglądarki. Czyta wyłącznie z
// tenant_icp_config_versions (samowystarczalny snapshot), NIGDY z
// tenant_icp_signals. `queryable` (domyślnie `db`) pozwala wywołać to też
// wewnątrz cudzej transakcji (np. seedDefaultConfigForTenant kopiujący
// PUBLISHED config źródłowego tenanta przez `client`).
async function getPublishedConfig(tenantId, queryable = db) {
  const { rows: [cfg] } = await queryable.query(
    `SELECT current_version_id FROM tenant_icp_configs WHERE tenant_id = $1`,
    [tenantId],
  );

  if (!cfg || !cfg.current_version_id) {
    // Nic jeszcze nie zostało opublikowane (nowy tenant przed seedem, albo
    // LIVE nigdy nie osiągnął poprawnej sumy) — pełny fallback do domyślnego
    // pakietu CRMtree, identyczny jak w getActiveConfig(). Próg wciąż live
    // z app_settings, nie hardkodowany — tenant mógł już go sobie ustawić
    // w Ustawieniach zanim jeszcze skonfigurował sygnały.
    return {
      signals: DEFAULT_SIGNALS,
      activeSignals: DEFAULT_SIGNALS.filter((s) => s.active),
      qualificationThreshold: await getTenantQualificationThreshold(tenantId, queryable),
      maxScore: computeMaxScore(DEFAULT_SIGNALS),
      currentVersionId: null,
      currentVersionNumber: null,
      isDefault: true,
    };
  }

  const { rows: [version] } = await queryable.query(
    `SELECT * FROM tenant_icp_config_versions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, cfg.current_version_id],
  );

  return {
    signals: version.snapshot,
    activeSignals: version.snapshot.filter((s) => s.active),
    qualificationThreshold: version.qualification_threshold,
    maxScore: version.max_score,
    currentVersionId: version.id,
    currentVersionNumber: version.version,
    isDefault: false,
  };
}

async function getConfigVersionById(tenantId, versionId) {
  const { rows: [version] } = await db.query(
    `SELECT * FROM tenant_icp_config_versions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, versionId],
  );
  return version || null;
}

// Materializuje DEFAULT_SIGNALS jako realne wiersze, jeśli tenant jeszcze
// ŻADNYCH nie ma (fallback → LIVE) — wołane na WEJŚCIU do każdej mutacji,
// przed jej właściwą logiką. Bez tego: admin edytujący jeden z "widocznych"
// 8 domyślnych sygnałów (w UI pokazywanych z placeholder-UUID z DEFAULT_SIGNALS,
// bo tenant nie ma jeszcze własnych wierszy) trafiałby PUT-em/DELETE-em w id,
// którego fizycznie nie ma w bazie — 404 zamiast realnej edycji, a pozostałe
// 7 "widocznych" sygnałów zniknęłoby przy kolejnym odświeżeniu.
//
// W PRAKTYCE to dziś rzadka ścieżka: seedDefaultConfigForTenant() materializuje
// defaults automatycznie już w POST /admin/tenants (tworzenie tenanta), więc
// każdy tenant utworzony od tej zmiany nigdy nie jest naprawdę w fallbacku —
// to jest wyłącznie defensywna siatka dla starszych/ręcznie tworzonych tenantów.
//
// Zwraca mapę placeholder-id (z DEFAULT_SIGNALS) → nowe, realne id, żeby
// wywołujący mógł przetłumaczyć id przyjęte od frontendu (który renderował
// fallback z placeholderami) na realny wiersz, jeśli akurat na taki trafił.
// Pusta mapa = tenant już miał własne wiersze, nic nie zrobiono (tani no-op).
async function ensureLiveSignalsMaterialized(client, tenantId, actorUserId) {
  const { rows: existing } = await client.query(
    `SELECT 1 FROM tenant_icp_signals WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  if (existing.length > 0) return new Map();

  const idToKey = new Map(DEFAULT_SIGNALS.map((s) => [s.id, s.key]));
  const keyToNewId = new Map();
  for (const s of DEFAULT_SIGNALS) {
    const { rows: [row] } = await client.query(
      `INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, key`,
      [tenantId, s.key, s.label, s.ai_definition, s.short_description ?? null, s.points, s.tier, s.active, s.sort_order],
    );
    keyToNewId.set(row.key, row.id);
  }
  for (const s of DEFAULT_SIGNALS) {
    if (!s.requires_any_of?.length) continue;
    const newIds = s.requires_any_of.map((depId) => keyToNewId.get(idToKey.get(depId))).filter(Boolean);
    if (newIds.length === 0) continue;
    await client.query(
      `UPDATE tenant_icp_signals SET requires_any_of = $1 WHERE tenant_id = $2 AND key = $3`,
      [newIds, tenantId, s.key],
    );
  }

  const placeholderToNewId = new Map();
  for (const s of DEFAULT_SIGNALS) placeholderToNewId.set(s.id, keyToNewId.get(s.key));
  return placeholderToNewId;
}

// Eksportowany wrapper na ensureLiveSignalsMaterialized — do jawnego wołania
// z warstwy tras (admin-tenants.js) PRZED addSignal, wyłącznie gdy caller wie,
// że tenant jest akurat w fallbacku (cfg.isDefault === true) i admin dodaje
// "+ Nowy sygnał" — bez tego pozostałe 7 "widocznych" defaultów zniknęłoby
// przy kolejnym odświeżeniu (patrz komentarz przy addSignal). No-op (tania
// pojedyncza SELECT) dla tenanta, który już ma własne wiersze — bezpieczne
// wołać zawsze przed dodaniem, nie tylko warunkowo.
async function materializeDefaultsIfFallback(tenantId, actorUserId = null) {
  return withTenantLock(tenantId, (client) => ensureLiveSignalsMaterialized(client, tenantId, actorUserId));
}

// ── Mutacje — każda: advisory lock → expected_revision → materializacja
//    defaultów (jeśli potrzebna) → zmiana LIVE stanu → bumpRevisionAndMaybePublish
//    (publikuje TYLKO jeśli wynik jest poprawny), w jednej transakcji DB.
//    Zwracają { ...signal?, configRevision, published, version } — `version`
//    jest null, gdy ta mutacja NIE opublikowała nowej wersji (LIVE został
//    invalid, stara PUBLISHED wersja zostaje aktywna). ──────────────────

// CELOWO addSignal NIE materializuje defaultów automatycznie (w przeciwieństwie
// do update/delete/reorder niżej) — zrobiłoby to niejednoznaczne: 9 defaultów
// (aktywne sumują się do 100) + nowy sygnał (N pkt) da 100+N, nigdy 100, więc
// pierwsze dodanie jakiegokolwiek sygnału na fallbackowym tenancie zawsze
// psułoby sumę. To
// świadomie generyczny, "czysty" primitive: dodaje DOKŁADNIE ten jeden sygnał,
// nic więcej. Materializację przy "+Dodaj sygnał" na fallbacku robi warstwa
// tras (patrz materializeDefaultsIfFallback niżej, wołane z admin-tenants.js
// PRZED addSignal) — osobny, jawny krok, nie wtopiony w ten primitive.
async function addSignal(tenantId, input, { expectedRevision, actorUserId = null } = {}) {
  validateNewSignalInput(input);
  return withTenantLock(tenantId, async (client) => {
    await assertExpectedRevision(client, tenantId, expectedRevision);

    const key = input.key
      ? validateKeyFormat(input.key)
      : await generateUniqueKey(client, tenantId, input.label);
    if (input.key) await assertKeyAvailable(client, tenantId, key);

    if (input.requiresAnyOf?.length) {
      await assertRequiresAnyOfValid(client, tenantId, input.requiresAnyOf, null);
    }

    const sortOrder = input.sortOrder ?? (await nextSortOrder(client, tenantId));

    const { rows: [signal] } = await client.query(
      `INSERT INTO tenant_icp_signals
         (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order, requires_any_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        tenantId,
        key,
        input.label,
        input.aiDefinition,
        input.shortDescription ?? null,
        input.points,
        input.tier ?? null,
        input.active ?? true,
        sortOrder,
        input.requiresAnyOf?.length ? input.requiresAnyOf : null,
      ],
    );

    const result = await bumpRevisionAndMaybePublish(client, tenantId, actorUserId);
    return { signal, ...result };
  });
}

async function updateSignal(tenantId, signalId, patch, { expectedRevision, actorUserId = null } = {}) {
  validatePatch(patch);
  return withTenantLock(tenantId, async (client) => {
    await assertExpectedRevision(client, tenantId, expectedRevision);
    const placeholderMap = await ensureLiveSignalsMaterialized(client, tenantId, actorUserId);
    // Jeśli caller przysłał placeholder-id z DEFAULT_SIGNALS (bo tenant był
    // jeszcze w fallbacku, gdy UI go renderowało) — po materializacji ten
    // konkretny sygnał ma już REALNE id, tłumaczymy na nie.
    const resolvedSignalId = placeholderMap.get(signalId) ?? signalId;

    if (patch.requiresAnyOf) {
      await assertRequiresAnyOfValid(client, tenantId, patch.requiresAnyOf, resolvedSignalId);
    }

    const { sets, values } = buildSetClause(patch, 3);
    if (sets.length === 0) throw badRequest('updateSignal: brak pól do zmiany');

    const { rows: [signal] } = await client.query(
      `UPDATE tenant_icp_signals
          SET ${sets.join(', ')}, updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, resolvedSignalId, ...values],
    );
    if (!signal) throw notFound(`Sygnał ${signalId} nie istnieje dla tenanta ${tenantId}`);

    const result = await bumpRevisionAndMaybePublish(client, tenantId, actorUserId);
    return { signal, ...result };
  });
}

async function setSignalActive(tenantId, signalId, active, opts = {}) {
  return updateSignal(tenantId, signalId, { active: !!active }, opts);
}

async function reorderSignals(tenantId, orderedSignalIds, { expectedRevision, actorUserId = null } = {}) {
  if (!Array.isArray(orderedSignalIds) || orderedSignalIds.length === 0) {
    throw badRequest('reorderSignals: orderedSignalIds musi być niepustą tablicą');
  }
  return withTenantLock(tenantId, async (client) => {
    await assertExpectedRevision(client, tenantId, expectedRevision);
    const placeholderMap = await ensureLiveSignalsMaterialized(client, tenantId, actorUserId);
    const resolvedIds = orderedSignalIds.map((id) => placeholderMap.get(id) ?? id);

    const { rows: existing } = await client.query(
      `SELECT id FROM tenant_icp_signals WHERE tenant_id = $1`,
      [tenantId],
    );
    const existingIds = new Set(existing.map((r) => r.id));
    const providedIds = new Set(resolvedIds);
    const sameSet = existingIds.size === providedIds.size
      && [...existingIds].every((id) => providedIds.has(id));
    if (!sameSet) {
      throw badRequest(
        'reorderSignals: lista musi zawierać dokładnie wszystkie sygnały tenanta, bez duplikatów i braków',
      );
    }

    for (let i = 0; i < resolvedIds.length; i += 1) {
      await client.query(
        `UPDATE tenant_icp_signals SET sort_order = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3`,
        [i + 1, tenantId, resolvedIds[i]],
      );
    }

    const result = await bumpRevisionAndMaybePublish(client, tenantId, actorUserId);
    return { ...result };
  });
}

// Soft delete (active=false, wiersz zostaje) gdy sygnał wystąpił w
// KTÓRYMKOLWIEK opublikowanym snapshocie tego tenanta — mógł więc realnie
// zostać użyty do enrichmentu, a historyczne wyniki muszą zostać wyjaśnialne.
// Hard delete tylko dla sygnału, który nigdy nie został opublikowany (dodany
// i usunięty, zanim LIVE osiągnął poprawną sumę — nic go nie wyjaśnia).
async function deleteSignal(tenantId, signalId, { expectedRevision, actorUserId = null } = {}) {
  return withTenantLock(tenantId, async (client) => {
    await assertExpectedRevision(client, tenantId, expectedRevision);
    const placeholderMap = await ensureLiveSignalsMaterialized(client, tenantId, actorUserId);
    const resolvedSignalId = placeholderMap.get(signalId) ?? signalId;

    const everPublished = await wasSignalEverPublished(client, tenantId, resolvedSignalId);

    if (everPublished) {
      const { rows: [signal] } = await client.query(
        `UPDATE tenant_icp_signals SET active = false, updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, resolvedSignalId],
      );
      if (!signal) throw notFound(`Sygnał ${signalId} nie istnieje dla tenanta ${tenantId}`);
      const result = await bumpRevisionAndMaybePublish(client, tenantId, actorUserId);
      return { signal, softDeleted: true, ...result };
    }

    // Czyści referencje u innych sygnałów tego tenanta zanim usunie wiersz —
    // requires_any_of nie ma FK na elementy tablicy (patrz komentarz w migracji).
    // NULLIF(...,  '{}') zamiast gołego array_remove(): Postgres po usunięciu ostatniego
    // elementu zwraca pustą tablicę '{}', nie NULL — normalizujemy do NULL dla spójności
    // z resztą kodu (addSignal/updateSignal też reprezentują "brak zależności" jako NULL).
    await client.query(
      `UPDATE tenant_icp_signals
          SET requires_any_of = NULLIF(array_remove(requires_any_of, $1), ARRAY[]::uuid[]),
              updated_at = now()
        WHERE tenant_id = $2 AND requires_any_of @> ARRAY[$1]::uuid[]`,
      [resolvedSignalId, tenantId],
    );

    const { rowCount } = await client.query(
      `DELETE FROM tenant_icp_signals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, resolvedSignalId],
    );
    if (rowCount === 0) throw notFound(`Sygnał ${signalId} nie istnieje dla tenanta ${tenantId}`);

    const result = await bumpRevisionAndMaybePublish(client, tenantId, actorUserId);
    return { softDeleted: false, ...result };
  });
}

// Seeduje LIVE config nowego tenanta (8 sygnałów + wersja 1) — wywoływane
// z POST /admin/tenants (admin-tenants.js) w TEJ SAMEJ transakcji co insert do
// `tenants`, więc dostaje `client` z zewnątrz zamiast otwierać własną transakcję
// (inaczej niż addSignal/updateSignal/... — tu nie ma advisory locka, bo świeżo
// tworzony tenant nie może mieć współbieżnych edycji configu).
//
// sourceTenantId (opcjonalny): jeśli podany i ma opublikowany config, KOPIUJE
// jego PUBLISHED (nie LIVE!) config — ten sam wzorzec co reszta POST
// /admin/tenants (feature flags/app_settings/group_profiles też kopiowane z
// tenanta "gold"). PUBLISHED, nie LIVE, celowo: gdyby gold był akurat w
// trakcie edycji (LIVE chwilowo invalid), nowy tenant nigdy nie powinien
// odziedziczyć zepsutej, nieopublikowanej konfiguracji. Gdy sourceTenantId
// brak/gold nie ma jeszcze żadnej opublikowanej wersji (pierwszy tenant na
// instalacji, przed utworzeniem gold) — fallback do DEFAULT_SIGNALS.
//
// requires_any_of tłumaczone jest przez KLUCZ (key), nigdy przez id — id źródła
// (gold albo placeholdery w DEFAULT_SIGNALS) nic nie znaczą dla nowo wstawianych
// wierszy, które i tak dostają świeże gen_random_uuid().
// Nowy tenant nie może dostać configu, którego bumpRevisionAndMaybePublish i
// tak nie opublikuje. Taki config zostawiłby current_version_id = NULL, więc
// Ustawienia → Enrichment/ICP pokazywałyby LIVE (np. sumę 70), a enrichment po
// cichu liczyłby wg runtime'owego fallbacku DEFAULT_SIGNALS (100) — dwie różne
// konfiguracje bez jednego widocznego błędu. Lepiej wywalić tworzenie tenanta
// z czytelnym komunikatem (audyt multi-tenant ICP, 23.09).
function seedSourceInvalid(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function assertSeedSourceValid(rowsToSeed, sourceLabel) {
  // Lazy require z tego samego powodu co w bumpRevisionAndMaybePublish.
  const { ICP_REQUIRED_SIGNALS_MAX_SCORE } = require('./prospectEnrichmentService');

  if (!Array.isArray(rowsToSeed) || rowsToSeed.length === 0) {
    throw seedSourceInvalid(`${sourceLabel}: brak jakichkolwiek sygnałów ICP do skopiowania.`);
  }

  const seenKeys = new Set();
  for (const r of rowsToSeed) {
    if (typeof r.key !== 'string' || !KEY_FORMAT.test(r.key)) {
      throw seedSourceInvalid(`${sourceLabel}: sygnał ma nieprawidłowy key ("${r.key}").`);
    }
    if (seenKeys.has(r.key)) {
      throw seedSourceInvalid(`${sourceLabel}: zduplikowany key "${r.key}".`);
    }
    seenKeys.add(r.key);
    if (typeof r.label !== 'string' || !r.label.trim()) {
      throw seedSourceInvalid(`${sourceLabel}: sygnał "${r.key}" nie ma etykiety.`);
    }
    if (typeof r.ai_definition !== 'string' || !r.ai_definition.trim()) {
      throw seedSourceInvalid(`${sourceLabel}: sygnał "${r.key}" nie ma definicji dla AI.`);
    }
    if (!Number.isInteger(Number(r.points)) || Number(r.points) < 0) {
      throw seedSourceInvalid(`${sourceLabel}: sygnał "${r.key}" ma nieprawidłowe punkty ("${r.points}").`);
    }
    if (typeof r.active !== 'boolean') {
      throw seedSourceInvalid(`${sourceLabel}: sygnał "${r.key}" ma nieprawidłową flagę active.`);
    }
  }

  const activeSum = computeMaxScore(rowsToSeed);
  if (activeSum !== ICP_REQUIRED_SIGNALS_MAX_SCORE) {
    throw seedSourceInvalid(
      `${sourceLabel}: suma punktów aktywnych sygnałów wynosi ${activeSum}, ` +
      `a wymagane jest ${ICP_REQUIRED_SIGNALS_MAX_SCORE}. Napraw konfigurację ICP tenanta ` +
      `źródłowego (Ustawienia aplikacji → Enrichment/ICP) i spróbuj ponownie.`,
    );
  }
}

async function seedDefaultConfigForTenant(client, tenantId, { sourceTenantId = null, actorUserId = null } = {}) {
  let rowsToSeed = null;
  let sourceLabel = 'Wbudowana domyślna konfiguracja ICP (DEFAULT_SIGNALS)';

  if (sourceTenantId) {
    const published = await getPublishedConfig(sourceTenantId, client);
    if (!published.isDefault) {
      sourceLabel = 'Konfiguracja ICP tenanta źródłowego (gold)';
      rowsToSeed = published.signals.map((s) => ({
        key: s.key, label: s.label, ai_definition: s.ai_definition, short_description: s.short_description,
        points: s.points, tier: s.tier, active: s.active, sort_order: s.sort_order,
        requiresAnyOfKeys: (s.requires_any_of || [])
          .map((depId) => published.signals.find((sig) => sig.id === depId)?.key)
          .filter(Boolean),
      }));
    }
  }

  if (!rowsToSeed) {
    const idToKey = new Map(DEFAULT_SIGNALS.map((s) => [s.id, s.key]));
    rowsToSeed = DEFAULT_SIGNALS.map((s) => ({
      key: s.key, label: s.label, ai_definition: s.ai_definition, short_description: s.short_description,
      points: s.points, tier: s.tier, active: s.active, sort_order: s.sort_order,
      requiresAnyOfKeys: (s.requires_any_of || []).map((id) => idToKey.get(id)).filter(Boolean),
    }));
  }

  assertSeedSourceValid(rowsToSeed, sourceLabel);

  const keyToNewId = {};
  for (const r of rowsToSeed) {
    const { rows: [row] } = await client.query(
      `INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, key`,
      [tenantId, r.key, r.label, r.ai_definition, r.short_description ?? null, r.points, r.tier, r.active, r.sort_order],
    );
    keyToNewId[row.key] = row.id;
  }
  for (const r of rowsToSeed) {
    if (!r.requiresAnyOfKeys?.length) continue;
    const newIds = r.requiresAnyOfKeys.map((k) => keyToNewId[k]).filter(Boolean);
    if (newIds.length === 0) continue;
    await client.query(
      `UPDATE tenant_icp_signals SET requires_any_of = $1 WHERE tenant_id = $2 AND key = $3`,
      [newIds, tenantId, r.key],
    );
  }

  // Wiersz w tenant_icp_configs trzeba mieć (żeby było na czym trzymać
  // config_revision/current_version_id) — qualification_threshold NIE jest
  // już tu przekazywany, kolumna zostaje na swoim DEFAULT 45 (nieużywanym,
  // patrz getTenantQualificationThreshold — jedyne źródło to app_settings).
  await client.query(
    `INSERT INTO tenant_icp_configs (tenant_id, updated_at)
     VALUES ($1, now())
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );

  // Seedowane sygnały sumują się do dokładnie tego, co było poprawne u źródła
  // (albo do 100 dla DEFAULT_SIGNALS) — ta mutacja publikuje wersję 1 od razu.
  const result = await bumpRevisionAndMaybePublish(client, tenantId, actorUserId);
  // Ostateczna bramka: cokolwiek by się nie stało wyżej, tenant nie wychodzi z
  // tej funkcji z nieopublikowanym configiem.
  if (!result.published) {
    throw seedSourceInvalid(
      `${sourceLabel}: nie udało się opublikować startowej konfiguracji ICP nowego tenanta. ` +
      `Tenant nie został utworzony.`,
    );
  }
  return { signalsSeeded: rowsToSeed.length, ...result };
}

module.exports = {
  DEFAULT_QUALIFICATION_THRESHOLD,
  DEFAULT_SIGNALS,
  ConfigRevisionConflictError,
  computeMaxScore,
  getActiveConfig,
  getPublishedConfig,
  getTenantQualificationThreshold,
  getConfigVersionById,
  materializeDefaultsIfFallback,
  addSignal,
  updateSignal,
  setSignalActive,
  reorderSignals,
  deleteSignal,
  seedDefaultConfigForTenant,
};
