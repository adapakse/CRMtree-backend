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
      'RÓWNOWAŻNE nazwy tej samej struktury — traktuj jako identyczny dowód, nie tylko dosłowne ' +
      '"dział handlowy": "dział handlowy", "dział sprzedaży", "sales team", "sales department", ' +
      '"zespół sprzedaży", "przedstawiciele handlowi" jako nazwana sekcja/nagłówek. ' +
      'Główny dowód: jawnie nazwany dział/zespół sprzedażowy (nagłówek podstrony, sekcja "Nasz ' +
      'zespół sprzedaży", nazwa działu w strukturze firmy, pod dowolną z powyższych równoważnych ' +
      'nazw) — WYSTARCZA nawet przy JEDNEJ widocznej, nazwanej osobie pod tym nagłówkiem, bo ' +
      'dowodem jest nazwana struktura organizacyjna, nie liczba osób. LUB: podstrona ' +
      'zespołu/kontaktu BEZ nazwanego nagłówka działu, ale z co najmniej 2-3 nazwanymi osobami ' +
      'pełniącymi role stricte handlowe (przedstawiciel handlowy, sprzedawca, account manager — ' +
      'nie zarząd) — to alternatywny, słabszy dowód używany tylko gdy nagłówka działu brak. ' +
      'NIE wystarcza: jedna nazwana osoba na stanowisku dyrektorskim ("Dyrektor Handlowy", ' +
      '"Dyrektor ds. Handlowych", "Sales Director") BEZ nazwanego działu/zespołu obok niej i bez ' +
      'innych wymienionych handlowców — to może być jedna osoba w zarządzie, nie dowód na ' +
      'istnienie sformalizowanego działu. ' +
      'Drugorzędne wsparcie: sam adres sprzedaz@/sales@ — może być zwykłą skrzynką ogólną.',
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
    label: 'Złożony proces sprzedaży / indywidualna wycena',
    ai_definition:
      'Relacyjny, projektowy lub negocjacyjny model PROCESU SPRZEDAŻY, nie zakup impulsowy. ' +
      'KLUCZOWA GRANICA: cena musi być ustalana INDYWIDUALNIE, PO stronie firmy, na podstawie ' +
      'potrzeb/specyfikacji konkretnego klienta — nie może być z góry jawnie podana jako stała ' +
      'kwota za standardowy produkt/usługę. Sam fakt sprzedaży B2B, posiadania formularza ' +
      'kontaktowego lub możliwości "skontaktowania się ze sprzedażą" NIE wystarcza, jeśli nie ' +
      'towarzyszy temu informacja, że wycena/oferta jest przygotowywana indywidualnie. ' +
      'Główny dowód — wymagany KONKRETNY dowód PROCESU OFERTOWEGO, jedno z poniższych: ' +
      'indywidualna oferta; indywidualna wycena; przygotowanie oferty PO poznaniu wymagań klienta ' +
      '(indywidualna kalkulacja); RFQ / zapytanie ofertowe PROWADZĄCE DO przygotowania oferty; ' +
      'negocjowanie indywidualnych warunków/ceny; frazy CTA równoważne powyższym — "zapytaj o ' +
      'ofertę", "poproś o wycenę", "przygotujemy ofertę", "wycena indywidualna", "wyślij zapytanie ' +
      'ofertowe". NIE WYSTARCZA (to osobne sygnały, nie ten): sama konsultacja, sam dobór/ ' +
      'rekomendacja rozwiązania czy konfiguracji pod potrzeby klienta bez wzmianki o etapie ' +
      'oferty/wyceny (to dowód dla konsultacja_demo, nie tego sygnału — dobór rozwiązania SAM W ' +
      'SOBIE nie implikuje indywidualnej kalkulacji ceny); sam projekt "pod klienta"; sam brak ' +
      'jawnego cennika bez żadnej z powyższych fraz. ' +
      'ZWRÓĆ FALSE: jawna, stała cena konkretnego produktu/usługi (cennik, cena jednostkowa przy ' +
      'produkcie w sklepie/katalogu) — to standardowa sprzedaż, nie indywidualna wycena, NAWET ' +
      'jeśli produkt jest sprzedawany firmom; format "od X zł" przy produkcie/usłudze/pokoju/pakiecie ' +
      '— to publiczny cennik z progami cenowymi, nie dowód indywidualnej kalkulacji dla ' +
      'konkretnego klienta; standardowa, jawnie podana cena pokoju/usługi/pakietu (np. cennik ' +
      'hotelowy, konsumencki cennik pakietów) — nawet jeśli firma osobno obsługuje też klientów ' +
      'biznesowych, sam TEN dowód tego nie potwierdza. UWAGA: jeśli firma ma OSOBNY, jawny ' +
      'cennik dla JEDNEJ usługi (np. standardowy nocleg) ORAZ oddzielnie opisany proces ofertowy ' +
      'dla INNEJ, odrębnej usługi (np. eventy/konferencje B2B, zamówienia produkcyjne) — oceniaj ' +
      'dowód dla tej DRUGIEJ usługi niezależnie; jawny cennik jednej usługi nie dyskwalifikuje ' +
      'automatycznie dowodu dla innej; sam kontakt do działu sprzedaży / formularz kontaktowy / ' +
      '"skontaktuj się z nami" BEZ jawnej informacji, że oferta/cena jest przygotowywana ' +
      'indywidualnie dla klienta — to zwykły kanał kontaktu, nie dowód procesu ofertowego. ' +
      'Drugorzędne wsparcie (NIE wystarcza samo): sam brak jawnego cennika bez którejś z ' +
      'powyższych fraz — brak ceny sam w sobie nie jest dowodem złożonego procesu sprzedaży.',
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
    label: 'Konsultacja, demo lub analiza potrzeb',
    ai_definition:
      'Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy z ' +
      'jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach). ' +
      'RÓWNOWAŻNE określenia tego samego etapu procesu — traktuj jako ten sam dowód: konsultacja, ' +
      'demo, dobór rozwiązania, analiza potrzeb, dobór techniczny, doradztwo przedsprzedażowe, ' +
      'projektowanie pod klienta/indywidualnego klienta. ' +
      'Główny dowód (dosłowna fraza LUB funkcjonalny odpowiednik — oba liczą się tak samo): ' +
      'dosłowne: "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania"; ' +
      'przypisany doradca/opiekun/dyrektor regionalny opisany jako doradztwo PRZEDSPRZEDAŻOWE, ' +
      'projektowe lub techniczne PRZY DOBORZE ROZWIĄZANIA (np. "Doradcy Twojego projektu"), nawet ' +
      'bez słowa "konsultacja"; formularz zbierający szczegółowe parametry rozwiązania/zamówienia ' +
      '(RFQ, zapytanie ofertowe z polami technicznymi), nie sam formularz kontaktowy ogólnego ' +
      'typu; sprzedaż oparta na indywidualnym projekcie technicznym/architektonicznym/ ' +
      'inżynierskim, gdzie analiza wymagań klienta jest jawnie opisanym etapem procesu (nie samym ' +
      'typem działalności — patrz zastrzeżenie niżej); doradztwo opisane jako DOSTOSOWANE do ' +
      'indywidualnych wymagań klienta (np. "doradztwo w [obszarze]" połączone w tym samym opisie ' +
      'z "dostosowujemy usługi do indywidualnych wymagań klienta") — to funkcjonalny odpowiednik ' +
      'doradztwa przedsprzedażowego, nawet jeśli samo słowo "doradztwo" bez tego dopełnienia ' +
      'byłoby zbyt ogólne. ' +
      'Drugorzędne wsparcie (nie wystarcza samo): ogólne hasło "indywidualne podejście do ' +
      'klienta" bez opisu konkretnego procesu, etapu lub osoby. ' +
      'NIE LICZY SIĘ (mimo słowa "doradca"/"konsultacja" w tekście): doradca/opiekun ds. ' +
      'likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji — to obsługa posprzedażowa/ ' +
      'roszczeniowa, nie doradztwo przy wyborze zakupu; serwisant, doradca serwisowy/techniczny ' +
      'wsparcia posprzedażowego, opiekun serwisu — to wsparcie techniczne dla już kupionego ' +
      'produktu, nie etap sprzedaży; ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej ' +
      'firmy (np. blogowa porada "na co zwrócić uwagę kupując X" bez odniesienia do konkretnej ' +
      'usługi/osoby/etapu w tej firmie) — to nie jest dowód konsultacji sprzedażowej, tylko treść ' +
      'informacyjna; sama produkcja/wykonanie "na wymiar", "na życzenie klienta", "według ' +
      'dokumentacji/wytycznych/specyfikacji klienta" — to opis MOŻLIWOŚCI PRODUKCYJNYCH ' +
      '(elastyczność wytwarzania), NIE dowód rozmowy doradczej, i NIE liczy się automatycznie ani ' +
      'dla tego sygnału, ani dla custom_quote_process; elastyczność produkcyjna i "możliwość ' +
      'personalizacji" produktu/usługi same w sobie — to opis ZDOLNOŚCI firmy, nie opis PROCESU ' +
      'rozmowy z klientem przed zakupem; realizacja projektu/dokumentacji DOSTARCZONEJ JUŻ przez ' +
      'klienta (firma tylko wykonuje to, co klient sam zaprojektował/określił) — brak tu żadnego ' +
      'etapu doboru/doradztwa PO stronie badanej firmy; fraza w stylu "uwzględniamy wymagania ' +
      'klienta w produkcji"/"od koncepcji, przez prototyp, aż po finalną produkcję"/"wspólnie ' +
      'stworzymy rozwiązania"/"projekt od pomysłu do realizacji" — to WCIĄŻ tylko opis zdolności ' +
      'produkcyjnej lub ogólne hasło o współpracy, dopóki nie jest OSOBNO opisany etap ROZMOWY/DORADZTWA/ANALIZY POTRZEB ' +
      'PRZED złożeniem zamówienia (kto, kiedy, w jakiej formie ustala z ' +
      'klientem właściwe rozwiązanie) — sam fakt, że produkt powstaje "pod klienta" lub hasło o ' +
      'wspólnej pracy nad projektem, nigdy nie wystarcza samo w sobie bez opisanego etapu doboru/ ' +
      'doradztwa; sam formularz kontaktowy ogólnego typu (imię, e-mail, wiadomość) — to nie jest ' +
      'dowód konsultacji/analizy potrzeb, nawet jeśli firma go używa jako jedynego kanału ' +
      'kontaktu. ZASTRZEŻENIE: nie ustawiaj true wyłącznie na podstawie branży/typu działalności ' +
      'ani z domysłu "każdy proces projektowy wymaga analizy potrzeb" — musi być konkretny ' +
      'tekstowy sygnał z listy powyżej, nie sama inferencja z rodzaju firmy. Jeśli jedyny dostępny ' +
      'dowód to opis elastyczności/personalizacji PRODUKCJI (bez osobno opisanego etapu rozmowy ' +
      'doradczej przed zamówieniem), zwróć false. Jeśli to ten sam fragment tekstu co dowód dla ' +
      'custom_quote_process, oceń oba sygnały niezależnie, ale nie licz jednego zdania jako dwóch ' +
      'niezależnych, mocniejszych dowodów.',
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
    label: 'Dedykowana opieka nad klientem B2B',
    ai_definition:
      'KLUCZOWA GRANICA: sygnał wymaga OSOBY (lub zespołu) PRZYPISANEJ NA STAŁE do konkretnego ' +
      'klienta, konta lub segmentu i odpowiedzialnej za CIĄGŁĄ relację z nim — nie samego ' +
      'istnienia działu/zespołu sprzedaży ani jednej rozmowy sprzedażowej. Rozstrzyga to, czy ' +
      'tekst albo (a) używa słownictwa dedykowanej opieki ("opiekun", "KAM", "Key Account ' +
      'Manager/Advisor", "account manager", "doradca ds. kluczowych klientów"), albo (b) wprost ' +
      'opisuje osobę jako odpowiedzialną NA STAŁE za określony obszar/segment/konto klienta — ' +
      'sama nazwa stanowiska sprzedażowego (bez żadnego z tych dwóch elementów) NIE wystarcza. ' +
      'RÓWNOWAŻNE określenia — traktuj jako ten sam dowód: dedykowany opiekun, Key Account ' +
      'Manager (KAM), account manager, customer success, opieka handlowa B2B, opiekun biznesowy. ' +
      'Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager", "account ' +
      'manager", "Customer Success", "stała opieka nad klientem", LUB osoba jawnie opisana jako ' +
      'odpowiedzialna na stałe za dany segment/branżę/konto ' +
      'klienta (np. "kontakt z konsultantem odpowiedzialnym za daną branżę"), nawet ' +
      'bez słowa "opiekun"/"KAM" wprost. Stanowiska/oferty pracy "Specjalista ds. klientów ' +
      'kluczowych", "Key Account Manager", "opiekun klienta biznesowego" i ich jednoznaczne ' +
      'odpowiedniki to RÓWNIEŻ mocny dowód — ogłoszenie o pracę na taką rolę liczy się tak samo ' +
      'jak opis usługi na stronie. ' +
      'ZWRÓĆ FALSE: samo Biuro Obsługi Klienta (BOK), sama infolinia, LUB nazwany kierownik/osoba ' +
      'zarządzająca BOK — to nadal ogólna, niezróżnicowana obsługa, nie opieka przypisana do ' +
      'konkretnego klienta/konta; zwykły handlowiec/przedstawiciel handlowy przypisany do ' +
      'REGIONU/terytorium — to pozyskiwanie sprzedaży na obszarze, nie opieka nad już ' +
      'pozyskanym, konkretnym klientem — chyba że tekst wprost nazywa tę osobę opiekunem/KAM lub ' +
      'opisuje ją jako odpowiedzialną na stałe za konkretne konto (nie tylko za "sprzedaż w ' +
      'regionie X"); Kierownik/Dyrektor Działu Sprzedaży — to funkcja zarządcza zespołu ' +
      'sprzedaży, nie osobista, ciągła opieka nad klientem; sam kontakt do działu sprzedaży ' +
      '(telefon/e-mail działu) bez informacji o stałej, przypisanej opiece nad konkretnym ' +
      'klientem/kontem; sama opieka powdrożeniowa, serwis, utrzymanie, aktualizacje, przeglądy ' +
      'czy odnowienia umów/usług BEZ wzmianki o przypisanym opiekunie/KAM — to dowód dla ' +
      'cykliczna_obsluga_klienta_odnowienia (CO się powtarzalnie dzieje z klientem), nie dla tego ' +
      'sygnału (KTO jest za niego stale odpowiedzialny) — oceniaj oba sygnały niezależnie.',
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
    label: 'Przetargi / dział ofertowania',
    ai_definition:
      'Firma SPRZEDAJE w przetargach jako wykonawca/dostawca — UWAGA, częsta pomyłka w obie ' +
      'strony: Dowód pozytywny (true): jawny język REALNEGO udziału w postępowaniu przetargowym ' +
      'JAKO WYKONAWCA/OFERENT/DOSTAWCA — "realizujemy zamówienia publiczne", "oferta dla sektora ' +
      'publicznego", "doświadczenie w przetargach", "specjalista ds. przetargów/ofertowania", ' +
      '"startujemy w przetargach", "oferty przetargowe", "wygraliśmy przetarg", "wygraliśmy ' +
      'wiele przetargów". NIE WYSTARCZA samo posiadanie klientów/zamawiających publicznych w ' +
      'portfolio realizacji (gmina, muzeum, biblioteka, urząd jako "Inwestor:" zrealizowanego ' +
      'projektu) — to dowód na OBSŁUGĘ sektora publicznego, nie na SPOSÓB pozyskania tego ' +
      'kontraktu. Bez jawnego słowa "przetarg"/"zamówienie publiczne"/"PZP" użytego w kontekście ' +
      'SPRZEDAŻY/WYGRANIA (nie samego faktu posiadania takiego klienta), zwróć false. NIE liczy ' +
      'się, nawet jeśli słowo "przetarg" występuje (to firma KUPUJĄCA, zwróć false): ' +
      '"postępowania zakupowe", "zamówienia dla dostawców", "przetargi organizowane przez nas", ' +
      '"profil nabywcy".',
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
    label: 'Rozproszona struktura sprzedaży / wiele oddziałów',
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
    label: 'Sieć partnerów / dealerów',
    ai_definition:
      'KLUCZOWY WARUNEK — KIERUNEK RELACJI: sygnał dotyczy WYŁĄCZNIE sytuacji, w której BADANA ' +
      'FIRMA jest DOSTAWCĄ posiadającym/organizującym WŁASNĄ, zewnętrzną sieć sprzedaży — ' +
      'niezależne podmioty (dealerzy, dystrybutorzy, resellerzy, partnerzy handlowi), które ' +
      'ODSPRZEDAJĄ PRODUKTY LUB USŁUGI TEJ FIRMY. Zanim uznasz dowód za wystarczający, ustal kto ' +
      'jest dostawcą, a kto odsprzedawcą w opisanej relacji — sam fakt użycia słowa "partner"/ ' +
      '"dealer"/"dystrybutor" NIE wystarcza, jeśli kierunek relacji jest inny albo niesprzedażowy. ' +
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
    label: 'Sprzedaż e-commerce (B2B)',
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
    label: 'Cykliczna obsługa klienta / odnowienia',
    ai_definition:
      'Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i ' +
      'występują kolejne zaplanowane zdarzenia wymagające obsługi.\n\n' +
      'TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, ' +
      'kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole albo inne ' +
      'powtarzalne działania dotyczące tego samego klienta.\n\n' +
      'Nie wystarcza sama możliwość ponownego zakupu, newsletter, program lojalnościowy, ' +
      'automatyczny abonament ani ogólne hasło „serwis". Musi istnieć realna, powtarzalna ' +
      'obsługa relacji z klientem.',
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
// do update/delete/reorder niżej) — zrobiłoby to niejednoznaczne: 8 defaultów
// (70 pkt) + nowy sygnał (N pkt) da 70+N, nigdy 70, więc pierwsze dodanie
// jakiegokolwiek sygnału na fallbackowym tenancie zawsze psułoby sumę. To
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
async function seedDefaultConfigForTenant(client, tenantId, { sourceTenantId = null, actorUserId = null } = {}) {
  let rowsToSeed = null;

  if (sourceTenantId) {
    const published = await getPublishedConfig(sourceTenantId, client);
    if (!published.isDefault) {
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
  // (albo do 70 dla DEFAULT_SIGNALS) — ta mutacja publikuje wersję 1 od razu.
  const result = await bumpRevisionAndMaybePublish(client, tenantId, actorUserId);
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
