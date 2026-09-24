-- Migration 0285: dynamiczna konfiguracja sygnałów ICP per tenant (ETAP A —
-- tylko data model + seed. SYSTEM_PROMPT, AI output, scoring i frontend NADAL
-- czytają stare stałe ICP_SIGNALS/ICP_GATE_DEFS w prospectEnrichmentService.js
-- — to się nie zmienia w tej migracji, patrz tenantIcpConfigService.js ETAP B).
--
-- Cztery tabele:
--   tenant_icp_signals         — LIVE, edytowalna lista sygnałów per tenant (to admin
--                                 edytuje w przyszłej zakładce Tenant → Enrichment/ICP).
--                                 id = techniczne UUID rekordu, key = niezmienny biznesowy
--                                 identyfikator (patrz komentarz niżej), label = edytowalna.
--   tenant_icp_config_versions — APPEND-ONLY snapshoty. Każda mutacja configu (add/edit/
--                                 toggle/reorder/delete/threshold) tworzy nowy wiersz z pełną
--                                 kopią stanu w danym momencie — stary prospekt zawsze da się
--                                 wyjaśnić wg wersji, której użyto, nawet gdy live-config
--                                 później się zmieni.
--   tenant_icp_configs         — jeden wiersz per tenant: LIVE qualification_threshold +
--                                 current_version_id (wskaźnik na "oficjalnie aktualny"
--                                 snapshot). qualification_threshold ma tu własną kolumnę,
--                                 NIE jest czytany wyłącznie z historycznego snapshotu —
--                                 to właściwość całej konfiguracji, nie pojedynczego sygnału.
--                                 max_score NIE jest tu trzymane — liczone on-the-fly z
--                                 aktywnych sygnałów (SUM(points) WHERE active), bo nie ma
--                                 technicznego powodu duplikować tę wartość w stanie live
--                                 (w przeciwieństwie do snapshotu wersji, gdzie max_score
--                                 to historyczny fakt "ile wynosił max w momencie enrichmentu").
--
-- prospect_companies.icp_config_version_id: NULL dla WSZYSTKICH istniejących dziś
-- rekordów (decyzja: nie przypisujemy sztucznie do wersji 1 — te enrichmenty powstały
-- przed wdrożeniem wersjonowania, NULL = "legacy, sprzed systemu wersji", nie "wersja 1").

CREATE TABLE IF NOT EXISTS tenant_icp_signals (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key              VARCHAR(64) NOT NULL,
  label            VARCHAR(255) NOT NULL,
  ai_definition    TEXT        NOT NULL,
  points           INT         NOT NULL CHECK (points >= 0),
  tier             VARCHAR(32),
  requires_any_of  UUID[],
  active           BOOLEAN     NOT NULL DEFAULT true,
  sort_order       INT         NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_icp_signals_tenant
  ON tenant_icp_signals(tenant_id, active, sort_order);

COMMENT ON COLUMN tenant_icp_signals.id IS
  'Techniczne id rekordu (UUID) — to na nim operuje ETAP B: kontrakt odpowiedzi AI
   {"signals":[{"id",...}]} i requires_any_of wskazują na TEN id.';
COMMENT ON COLUMN tenant_icp_signals.key IS
  'Niezmienny biznesowy identyfikator sygnału (np. "dzial_handlowy") — nadawany raz przy
   tworzeniu, NIGDY nie zmieniany (w przeciwieństwie do label, które admin może dowolnie
   edytować). Dla 8 domyślnych sygnałów CRMtree to dokładnie te same wartości, jakie
   calcIcpScore() dziś zapisuje jako breakdown[].id w prospect_companies.icp_signals —
   sprawdzone w kodzie (prospectEnrichmentService.js:815-830, ICP_SIGNALS[].id), NIE mylić
   z promptKey (np. "field_sales_team"), który jest osobnym kluczem używanym tylko w
   kontrakcie JSON z AI (icp_signals{}/signal_reasoning{}), nie w danych historycznych
   prospektów. Dzięki temu stare enrichmenty (sprzed tej migracji) nadal mapują się po
   key na definicję sygnału, nawet jeśli label zostanie później zmieniony przez admina.
   Dla nowych, customowych sygnałów tenanta: key generowany raz przy tworzeniu (slug z
   label + deduplikacja), również nigdy nie zmieniany.';
COMMENT ON COLUMN tenant_icp_signals.ai_definition IS
  'Wolny tekst wklejany do promptu AI jako definicja tego sygnału. Dla 8 domyślnych sygnałów
   CRMtree to dosłowna kopia bloków z SYSTEM_PROMPT (prospectEnrichmentService.js) — zero
   parafrazowania, żeby nie stracić strojenia z realnych audytów.';
COMMENT ON COLUMN tenant_icp_signals.requires_any_of IS
  'Opcjonalna zależność: sygnał liczy się w scoringu tylko gdy PRZYNAJMNIEJ JEDEN z tych
   id (innych sygnałów TEGO SAMEGO tenanta) też ma hit=true. Egzekwowane w backendowym
   scoringu (ETAP B), nie w prompcie AI. Brak FK na elementy tablicy — przy usunięciu
   sygnału backend (deleteSignal) sam czyści referencje u innych sygnałów.';

CREATE TABLE IF NOT EXISTS tenant_icp_config_versions (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version                  INT         NOT NULL CHECK (version >= 1),
  qualification_threshold  INT         NOT NULL,
  max_score                INT         NOT NULL,
  snapshot                 JSONB       NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               UUID        REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_tenant_icp_config_versions_tenant
  ON tenant_icp_config_versions(tenant_id, version DESC);

COMMENT ON COLUMN tenant_icp_config_versions.snapshot IS
  'Pełna kopia aktywnych i nieaktywnych sygnałów w momencie mutacji:
   [{id,key,label,ai_definition,points,tier,active,sort_order,requires_any_of}, ...].
   Samowystarczalna — wyjaśnienie starego prospekta nie wymaga joina do (być może
   już zmienionej) tenant_icp_signals.';
COMMENT ON COLUMN tenant_icp_config_versions.max_score IS
  'Suma points aktywnych sygnałów w momencie tej mutacji — historyczny fakt "ile wynosił
   max_score, gdy tej wersji użyto do enrichmentu", dlatego jest tu trwale zapisany (w
   przeciwieństwie do tenant_icp_configs, gdzie max_score liczymy on-the-fly). Na tym etapie
   NIE obejmuje bramek (20) ani bonusów (10) — te zostają globalne (patrz plan V2). Gdy
   ETAP B przepnie realny scoring, do decyzji: czy max_score ma urosnąć o stałą część
   bramek/bonusów.';

CREATE TABLE IF NOT EXISTS tenant_icp_configs (
  tenant_id                UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  qualification_threshold  INT         NOT NULL DEFAULT 45 CHECK (qualification_threshold >= 0),
  current_version_id       UUID        REFERENCES tenant_icp_config_versions(id) ON DELETE SET NULL,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_icp_configs IS
  'Jeden wiersz per tenant — LIVE qualification_threshold + wskaźnik current_version_id na
   "oficjalnie aktualny" snapshot w tenant_icp_config_versions. Gates/bonusy/blacklist
   zostają globalne na tym etapie (patrz plan V2), więc nie mają tu jeszcze miejsca.';
COMMENT ON COLUMN tenant_icp_configs.current_version_id IS
  'Ustawiane atomowo w tej samej transakcji co insert nowej wersji przy KAŻDEJ mutacji
   configu (tenantIcpConfigService.js) — nigdy nie wskazuje na przeterminowaną wersję.';

ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS icp_config_version_id UUID
    REFERENCES tenant_icp_config_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prospect_companies_icp_config_version
  ON prospect_companies(icp_config_version_id);

COMMENT ON COLUMN prospect_companies.icp_config_version_id IS
  'Wg jakiej wersji configu ICP tenanta oceniono ten prospekt. NULL = enrichment sprzed
   wdrożenia wersjonowania (2026-09) — celowo NIE backfillowane do wersji 1, żeby nie
   sugerować precyzji, której nie mamy (te rekordy faktycznie powstały pod stare,
   hardkodowane ICP_SIGNALS, nie pod żaden zapisany snapshot).';

-- ── SEED: domyślny config CRMtree (8 sygnałów) jako LIVE config dla KAŻDEGO
-- istniejącego tenanta — 1:1 z ICP_SIGNALS w prospectEnrichmentService.js,
-- definicje skopiowane dosłownie z bloków SYSTEM_PROMPT (linie ~2906-3146).
-- Punkty/tier/kolejność identyczne jak dziś. ──────────────────────────────

INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, points, tier, sort_order)
SELECT t.id, v.key, v.label, v.ai_definition, v.points, v.tier, v.sort_order
FROM tenants t
CROSS JOIN (VALUES
  (
    'dzial_handlowy',
    'Dział handlowy',
    $fst$RÓWNOWAŻNE nazwy tej samej struktury — traktuj jako identyczny dowód, nie tylko dosłowne
"dział handlowy": "dział handlowy", "dział sprzedaży", "sales team", "sales department",
"zespół sprzedaży", "przedstawiciele handlowi" jako nazwana sekcja/nagłówek.
Główny dowód: jawnie nazwany dział/zespół sprzedażowy (nagłówek podstrony, sekcja "Nasz
zespół sprzedaży", nazwa działu w strukturze firmy, pod dowolną z powyższych równoważnych
nazw) — WYSTARCZA nawet przy JEDNEJ widocznej, nazwanej osobie pod tym nagłówkiem, bo
dowodem jest nazwana struktura organizacyjna, nie liczba osób. LUB: podstrona
zespołu/kontaktu BEZ nazwanego nagłówka działu, ale z co najmniej 2-3 nazwanymi osobami
pełniącymi role stricte handlowe (przedstawiciel handlowy, sprzedawca, account manager —
nie zarząd) — to alternatywny, słabszy dowód używany tylko gdy nagłówka działu brak.
NIE wystarcza: jedna nazwana osoba na stanowisku dyrektorskim ("Dyrektor Handlowy",
"Dyrektor ds. Handlowych", "Sales Director") BEZ nazwanego działu/zespołu obok niej i bez
innych wymienionych handlowców — to może być jedna osoba w zarządzie, nie dowód na
istnienie sformalizowanego działu.
Drugorzędne wsparcie: sam adres sprzedaz@/sales@ — może być zwykłą skrzynką ogólną.$fst$,
    15, 'wysoka', 1
  ),
  (
    'zlozony_proces_sprzedazy',
    'Złożony proces sprzedaży / indywidualna wycena',
    $cqp$Relacyjny, projektowy lub negocjacyjny model PROCESU SPRZEDAŻY, nie zakup impulsowy.
KLUCZOWA GRANICA: cena musi być ustalana INDYWIDUALNIE, PO stronie firmy, na podstawie
potrzeb/specyfikacji konkretnego klienta — nie może być z góry jawnie podana jako stała
kwota za standardowy produkt/usługę. Sam fakt sprzedaży B2B, posiadania formularza
kontaktowego lub możliwości "skontaktowania się ze sprzedażą" NIE wystarcza, jeśli nie
towarzyszy temu informacja, że wycena/oferta jest przygotowywana indywidualnie.
Główny dowód: fraza CTA LUB jej funkcjonalny odpowiednik (wszystkie równoważne) —
"zapytaj o ofertę", "poproś o wycenę", "przygotujemy ofertę", "indywidualna oferta",
"wycena indywidualna", "wyślij zapytanie ofertowe", "RFQ", "skontaktuj się z handlowcem",
LUB opis, że cena/oferta jest ustalana PO poznaniu potrzeb/specyfikacji klienta
(indywidualna kalkulacja), nie z góry określona, LUB firma AKTYWNIE DOBIERA/REKOMENDUJE
konkretny wariant/parametry/konfigurację na podstawie zgłoszonych potrzeb klienta (np.
"indywidualne dobranie [produktu] o niestandardowej pojemności/wielkości/zakresie") —
taki dobór ZAWSZE poprzedza indywidualną kalkulację ceny, więc liczy się nawet bez słowa
"wycena"/"oferta" wprost obok niego, LUB CTA sformułowane jako propozycja DOPASOWANA do
zgłoszenia klienta (np. "dowiedz się, jakie rozwiązania możemy Ci zaproponować",
"napisz do nas, przygotujemy coś dla Ciebie") — nie sam neutralny link "kontakt", ale
sformułowanie sugerujące, że odpowiedź będzie dopasowana do konkretnego zgłoszenia.
ZWRÓĆ FALSE:
  - jawna, stała cena konkretnego produktu/usługi (cennik, cena jednostkowa przy
    produkcie w sklepie/katalogu) — to standardowa sprzedaż, nie indywidualna wycena,
    NAWET jeśli produkt jest sprzedawany firmom;
  - format "od X zł" przy produkcie/usłudze/pokoju/pakiecie — to publiczny cennik z
    progami cenowymi, nie dowód indywidualnej kalkulacji dla konkretnego klienta;
  - standardowa, jawnie podana cena pokoju/usługi/pakietu (np. cennik hotelowy,
    konsumencki cennik pakietów) — nawet jeśli firma osobno obsługuje też klientów
    biznesowych, sam TEN dowód tego nie potwierdza. UWAGA: jeśli firma ma OSOBNY, jawny
    cennik dla JEDNEJ usługi (np. standardowy nocleg) ORAZ oddzielnie opisany proces
    ofertowy dla INNEJ, odrębnej usługi (np. eventy/konferencje B2B, zamówienia
    produkcyjne) — oceniaj dowód dla tej DRUGIEJ usługi niezależnie; jawny cennik jednej
    usługi nie dyskwalifikuje automatycznie dowodu dla innej;
  - sam kontakt do działu sprzedaży / formularz kontaktowy / "skontaktuj się z nami" BEZ
    jawnej informacji, że oferta/cena jest przygotowywana indywidualnie dla klienta —
    to zwykły kanał kontaktu, nie dowód procesu ofertowego.
Drugorzędne wsparcie (NIE wystarcza samo): sam brak jawnego cennika bez którejś z
powyższych fraz — brak ceny sam w sobie nie jest dowodem złożonego procesu sprzedaży.$cqp$,
    10, 'wysoka', 2
  ),
  (
    'konsultacja_demo',
    'Konsultacja, demo lub analiza potrzeb',
    $cdna$Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy
z jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach).
RÓWNOWAŻNE określenia tego samego etapu procesu — traktuj jako ten sam dowód: konsultacja,
demo, dobór rozwiązania, analiza potrzeb, dobór techniczny, doradztwo przedsprzedażowe,
projektowanie pod klienta/indywidualnego klienta.
Główny dowód (dosłowna fraza LUB funkcjonalny odpowiednik — oba liczą się tak samo):
  - dosłowne: "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania";
  - przypisany doradca/opiekun/dyrektor regionalny opisany jako doradztwo PRZEDSPRZEDAŻOWE,
    projektowe lub techniczne PRZY DOBORZE ROZWIĄZANIA (np. "Doradcy Twojego projektu"),
    nawet bez słowa "konsultacja";
  - formularz zbierający szczegółowe parametry rozwiązania/zamówienia (RFQ, zapytanie
    ofertowe z polami technicznymi), nie sam formularz kontaktowy ogólnego typu;
  - sprzedaż oparta na indywidualnym projekcie technicznym/architektonicznym/inżynierskim,
    gdzie analiza wymagań klienta jest jawnie opisanym etapem procesu (nie samym typem
    działalności — patrz zastrzeżenie niżej);
  - doradztwo opisane jako DOSTOSOWANE do indywidualnych wymagań klienta (np. "doradztwo
    w [obszarze]" połączone w tym samym opisie z "dostosowujemy usługi do indywidualnych
    wymagań klienta") — to funkcjonalny odpowiednik doradztwa przedsprzedażowego, nawet
    jeśli samo słowo "doradztwo" bez tego dopełnienia byłoby zbyt ogólne.
Drugorzędne wsparcie (nie wystarcza samo): ogólne hasło "indywidualne podejście do klienta"
bez opisu konkretnego procesu, etapu lub osoby.
NIE LICZY SIĘ (mimo słowa "doradca"/"konsultacja" w tekście):
  - doradca/opiekun ds. likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji — to
    obsługa posprzedażowa/roszczeniowa, nie doradztwo przy wyborze zakupu;
  - serwisant, doradca serwisowy/techniczny wsparcia posprzedażowego, opiekun serwisu —
    to wsparcie techniczne dla już kupionego produktu, nie etap sprzedaży;
  - ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada
    "na co zwrócić uwagę kupując X" bez odniesienia do konkretnej usługi/osoby/etapu w tej
    firmie) — to nie jest dowód konsultacji sprzedażowej, tylko treść informacyjna;
  - sama produkcja/wykonanie "na wymiar", "na życzenie klienta", "według
    dokumentacji/wytycznych/specyfikacji klienta" — to opis MOŻLIWOŚCI PRODUKCYJNYCH
    (elastyczność wytwarzania), NIE dowód rozmowy doradczej, i NIE liczy się automatycznie
    ani dla tego sygnału, ani dla custom_quote_process;
  - elastyczność produkcyjna i "możliwość personalizacji" produktu/usługi same w sobie —
    to opis ZDOLNOŚCI firmy, nie opis PROCESU rozmowy z klientem przed zakupem;
  - realizacja projektu/dokumentacji DOSTARCZONEJ JUŻ przez klienta (firma tylko wykonuje
    to, co klient sam zaprojektował/określił) — brak tu żadnego etapu doboru/doradztwa PO
    stronie badanej firmy;
  - fraza w stylu "uwzględniamy wymagania klienta w produkcji"/"od koncepcji, przez
    prototyp, aż po finalną produkcję"/"wspólnie stworzymy rozwiązania"/"projekt od
    pomysłu do realizacji" — to WCIĄŻ tylko opis zdolności produkcyjnej lub ogólne hasło
    o współpracy, dopóki nie jest OSOBNO opisany etap ROZMOWY/DORADZTWA/ANALIZY POTRZEB
    PRZED złożeniem zamówienia (kto, kiedy, w jakiej formie ustala z klientem właściwe
    rozwiązanie) — sam fakt, że produkt powstaje "pod klienta" lub hasło o wspólnej pracy
    nad projektem, nigdy nie wystarcza samo w sobie bez opisanego etapu doboru/doradztwa;
  - sam formularz kontaktowy ogólnego typu (imię, e-mail, wiadomość) — to nie jest dowód
    konsultacji/analizy potrzeb, nawet jeśli firma go używa jako jedynego kanału kontaktu.
ZASTRZEŻENIE: nie ustawiaj true wyłącznie na podstawie branży/typu działalności ani z
domysłu "każdy proces projektowy wymaga analizy potrzeb" — musi być konkretny tekstowy
sygnał z listy powyżej, nie sama inferencja z rodzaju firmy. Jeśli jedyny dostępny dowód
to opis elastyczności/personalizacji PRODUKCJI (bez osobno opisanego etapu rozmowy
doradczej przed zamówieniem), zwróć false.
Jeśli to ten sam fragment tekstu co dowód dla custom_quote_process, oceń oba sygnały
niezależnie, ale nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów.$cdna$,
    10, 'wysoka', 3
  ),
  (
    'opieka_nad_klientem',
    'Dedykowana opieka nad klientem B2B',
    $dccb$KLUCZOWA GRANICA: sygnał wymaga OSOBY (lub zespołu) PRZYPISANEJ NA STAŁE do konkretnego
klienta, konta lub segmentu i odpowiedzialnej za CIĄGŁĄ relację z nim — nie samego
istnienia działu/zespołu sprzedaży ani jednej rozmowy sprzedażowej. Rozstrzyga to, czy
tekst albo (a) używa słownictwa dedykowanej opieki ("opiekun", "KAM", "Key Account
Manager/Advisor", "account manager", "doradca ds. kluczowych klientów"), albo (b) wprost
opisuje osobę jako odpowiedzialną NA STAŁE za określony obszar/segment/konto klienta —
sama nazwa stanowiska sprzedażowego (bez żadnego z tych dwóch elementów) NIE wystarcza.
RÓWNOWAŻNE określenia — traktuj jako ten sam dowód: dedykowany opiekun, Key Account
Manager (KAM), account manager, customer success, opieka handlowa B2B, opiekun biznesowy.
Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager",
"account manager", "Customer Success", "obsługa posprzedażowa", "odnowienia umów",
"stała opieka nad klientem", LUB osoba jawnie opisana jako odpowiedzialna na stałe za
dany segment/branżę/konto klienta (np. "kontakt z konsultantem odpowiedzialnym za daną
branżę"), nawet bez słowa "opiekun"/"KAM" wprost.
Stanowiska/oferty pracy "Specjalista ds. klientów kluczowych", "Key Account Manager",
"opiekun klienta biznesowego" i ich jednoznaczne odpowiedniki to RÓWNIEŻ mocny dowód —
ogłoszenie o pracę na taką rolę liczy się tak samo jak opis usługi na stronie.
ZWRÓĆ FALSE:
  - samo Biuro Obsługi Klienta (BOK), sama infolinia, LUB nazwany kierownik/osoba
    zarządzająca BOK — to nadal ogólna, niezróżnicowana obsługa, nie opieka przypisana
    do konkretnego klienta/konta;
  - zwykły handlowiec/przedstawiciel handlowy przypisany do REGIONU/terytorium — to
    pozyskiwanie sprzedaży na obszarze, nie opieka nad już pozyskanym, konkretnym
    klientem — chyba że tekst wprost nazywa tę osobę opiekunem/KAM lub opisuje ją jako
    odpowiedzialną na stałe za konkretne konto (nie tylko za "sprzedaż w regionie X");
  - Kierownik/Dyrektor Działu Sprzedaży — to funkcja zarządcza zespołu sprzedaży, nie
    osobista, ciągła opieka nad klientem;
  - sam kontakt do działu sprzedaży (telefon/e-mail działu) bez informacji o stałej,
    przypisanej opiece nad konkretnym klientem/kontem.$dccb$,
    10, 'wysoka', 4
  ),
  (
    'przetargi',
    'Przetargi / dział ofertowania',
    $tbd$Firma SPRZEDAJE w przetargach jako wykonawca/dostawca — UWAGA, częsta pomyłka w obie
strony:
Dowód pozytywny (true): jawny język REALNEGO udziału w postępowaniu przetargowym JAKO
WYKONAWCA/OFERENT/DOSTAWCA — "realizujemy zamówienia publiczne", "oferta dla sektora
publicznego", "doświadczenie w przetargach", "specjalista ds. przetargów/ofertowania",
"startujemy w przetargach", "oferty przetargowe", "wygraliśmy przetarg", "wygraliśmy wiele
przetargów".
NIE WYSTARCZA samo posiadanie klientów/zamawiających publicznych w portfolio realizacji
(gmina, muzeum, biblioteka, urząd jako "Inwestor:" zrealizowanego projektu) — to dowód na
OBSŁUGĘ sektora publicznego, nie na SPOSÓB pozyskania tego kontraktu. Bez jawnego słowa
"przetarg"/"zamówienie publiczne"/"PZP" użytego w kontekście SPRZEDAŻY/WYGRANIA (nie
samego faktu posiadania takiego klienta), zwróć false.
NIE liczy się, nawet jeśli słowo "przetarg" występuje (to firma KUPUJĄCA, zwróć false):
"postępowania zakupowe", "zamówienia dla dostawców", "przetargi organizowane przez nas",
"profil nabywcy".$tbd$,
    10, 'wysoka', 5
  ),
  (
    'rozproszona_struktura',
    'Rozproszona struktura sprzedaży / wiele oddziałów',
    $dss$Zespół lub sieć sprzedaży fizycznie rozproszona terytorialnie, WYŁĄCZNIE WŁASNA (ten sam
podmiot/firma — nie osobne podmioty, nawet powiązane kapitałowo). Oddział/przedstawicielstwo
tej samej firmy ZA GRANICĄ nadal się liczy jako własne — to NIE jest automatycznie inny
podmiot tylko dlatego, że działa w innym kraju (nie wymagaj polskiego NIP/KRS, żeby uznać
zagraniczny oddział za "własny" — firma może mieć oddział/przedstawicielstwo bez odrębnej
polskiej rejestracji).
Główny dowód: oficjalne oddziały, biura regionalne lub placówki firmy w kilku miastach —
to WYSTARCZA samo w sobie, nawet bez podanych nazwisk osób przy adresach. Przypisani
regionalni handlowcy/przedstawiciele zwiększają pewność, ale NIE są warunkiem koniecznym.
JAK ODRÓŻNIĆ własny zagraniczny oddział od spółki z grupy (częsta pomyłka): oddział/
przedstawicielstwo TEJ SAMEJ firmy jest opisany jako część JEJ struktury (np. "Oddział
Niemcy", "przedstawicielstwo w Hiszpanii" pod tą samą nazwą firmy) — to liczy się jako
własne. Jeśli natomiast lokalizacja w innym kraju ma WŁASNĄ, ODRĘBNĄ nazwę firmy z lokalną
formą prawną (np. "[Nazwa]-Werk GmbH", "[Nazwa] Kft.", "[Nazwa] S.L.", "[Nazwa] AG", "[Nazwa]
Sp. z o.o." obok głównej "[Nazwa] S.A.") — to jest OSOBNY PODMIOT GRUPY KAPITAŁOWEJ, nie
własny oddział badanej spółki, NAWET jeśli działa pod tą samą marką/nazwą i jest wymieniony
na tej samej stronie kontaktowej. Sama przynależność do międzynarodowej grupy/sieci spółek
o wspólnej marce NIE wystarcza — lista krajów lub spółek grupy to nie własna sieć oddziałów
badanej firmy.
NIE liczy się (to nie własne oddziały tej firmy): lokalizacje realizacji/projektów u
klientów, siedziby klientów, adresy zewnętrznych partnerów/dealerów/niezależnych
dystrybutorów (nawet zagranicznych, nawet z "recognized distributor" w opisie), ani
spółki-siostry/spółki z tej samej grupy kapitałowej (to osobne podmioty prawne — rozpoznaj
je po odrębnej nazwie firmy/formie prawnej, patrz wyżej).$dss$,
    5, 'srednia', 6
  ),
  (
    'siec_partnerow',
    'Sieć partnerów / dealerów',
    $pdn$KLUCZOWY WARUNEK — KIERUNEK RELACJI: sygnał dotyczy WYŁĄCZNIE sytuacji, w której BADANA
FIRMA jest DOSTAWCĄ posiadającym/organizującym WŁASNĄ, zewnętrzną sieć sprzedaży —
niezależne podmioty (dealerzy, dystrybutorzy, resellerzy, partnerzy handlowi), które
ODSPRZEDAJĄ PRODUKTY LUB USŁUGI TEJ FIRMY. Zanim uznasz dowód za wystarczający, ustal kto
jest dostawcą, a kto odsprzedawcą w opisanej relacji — sam fakt użycia słowa
"partner"/"dealer"/"dystrybutor" NIE wystarcza, jeśli kierunek relacji jest inny albo
niesprzedażowy.
Główny dowód: "zostań partnerem", "sieć dealerska", "dla dystrybutorów", "strefa partnera"
w domenie firmy — w kontekście rekrutacji odsprzedawców JEJ WŁASNYCH produktów/usług —
LUB jawnie wymieniona lista niezależnych dystrybutorów/przedstawicieli na rynkach
zagranicznych, którzy sprzedają dalej produkty tej firmy.
ZASADA POZYTYWNA: jeżeli badana firma zaprasza inne firmy/sprzedawców do sprzedaży lub
dystrybucji JEJ WŁASNYCH produktów/usług i opisuje to jako współpracę z dystrybutorami,
dealerami, resellerami lub partnerami handlowymi — to jest to true, niezależnie od
dokładnego sformułowania. Przykład: "Sprzedajesz nasze produkty / produkty z naszej
kategorii? Rozpocznij z nami współpracę" połączone z informacją o modelu współpracy z
dystrybutorami — to true, bo badana firma jest tu DOSTAWCĄ/PRODUCENTEM, a zewnętrzny
podmiot ma sprzedawać JEJ ofertę.
ZWRÓĆ FALSE (częste pomyłki w obie strony):
  - firma SAMA jest dealerem/dystrybutorem/autoryzowanym partnerem CUDZEJ marki (np.
    "jesteśmy oficjalnym dystrybutorem [producenta X]") — to ONA jest odsprzedawcą, nie
    dostawcą budującym własną sieć; jej WŁASNY dział montażu/instalacji/serwisu również
    się nie liczy, to wewnętrzny zespół, nie zewnętrzna sieć;
  - firma REKRUTUJE przewoźników, podwykonawców lub dostawców do współpracy z NIĄ (np.
    "zostań naszym partnerem" skierowane do przewoźników/poddostawców, którzy będą
    świadczyć usługę DLA tej firmy) — to ona jest stroną KUPUJĄCĄ usługę/zdolność, nie
    buduje sieci odsprzedającej jej produkty;
  - "partner" oznacza partnera eventowego, marketingowego, lokalną atrakcję turystyczną
    lub inną współpracę niesprzedażową (patronat, cross-promocja, sponsoring);
  - ogólne, marketingowe użycie słowa "partner"/"partnerzy" oznaczające KLIENTÓW lub
    relacje biznesowe w ogóle (np. "budujemy długoterminowe relacje z partnerami na
    całym świecie", "dostarczamy naszym partnerom niezawodne produkty");
  - linki do spółek-sióstr/spółek z tej samej grupy kapitałowej — to nie sieć
    odsprzedawców, tylko wewnętrzna struktura grupy — chyba że tekst wprost opisuje je
    jako dealerów/dystrybutorów tej firmy, nie jako powiązane firmy.
Wymagany jest jawny kontekst NIEZALEŻNEGO podmiotu odsprzedającego/dystrybuującego
PRODUKTY/USŁUGI TEJ FIRMY (nie cudzej), nie samo słowo "partner" w dowolnym znaczeniu.$pdn$,
    5, 'srednia', 7
  )
) AS v(key, label, ai_definition, points, tier, sort_order);

-- ecommerce_b2b osobno — requires_any_of wymaga id sygnałów tego samego tenanta,
-- powstałych dopiero w insercie powyżej (korelowane po key, stabilnym i unikalnym per
-- tenant — nie po label, które admin będzie mógł zmieniać).
INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, points, tier, sort_order, requires_any_of)
SELECT
  t.id,
  'ecommerce_b2b',
  'Sprzedaż e-commerce (B2B)',
  $ecb$Realny sklep/panel zamówieniowy w domenie firmy skierowany do klientów BIZNESOWYCH, nie
zwykły sklep konsumencki (D2C) z możliwością wpisania NIP-u na fakturze.
Główny dowód: sklep lub panel logowania w domenie firmy z co najmniej jedną cechą B2B —
ceny netto/"dla firm", wymagana rejestracja firmy/NIP przy zakładaniu konta, rabaty
ilościowe/hurtowe dla stałych klientów biznesowych, jawna nazwa "sklep B2B"/"panel B2B"/
"strefa klienta firmowego" — POD WARUNKIEM że tekst potwierdza realną funkcję zamówieniową
(logowanie/konto/koszyk/składanie zamówień), nie tylko nazwę.
NIE wystarcza: zwykły sklep detaliczny (ceny brutto, zakupy bez konta firmowego) tylko
dlatego, że przy zamówieniu można podać NIP do faktury — to nadal sprzedaż D2C.
NIE wystarcza: sama etykieta menu/link "Platforma B2B"/"B2B" bez żadnego dalszego opisu w
dostępnym tekście, co ta platforma faktycznie robi (zamawianie, logowanie, konto) — nazwa
linku w nawigacji to nie potwierdzenie działania panelu, może to być np. osobny produkt
firmy (system/platforma techniczna), a nie sklep zamówieniowy.
Ten sygnał liczy się w scoringu TYLKO razem z dzial_handlowy lub dedicated_customer_care_b2b
(zależność ustawiona w kodzie, nie w tym prompcie) — oceniaj go niezależnie i uczciwie,
nie zaniżaj/zawyżaj z myślą o tej zależności.$ecb$,
  5, 'srednia', 8,
  ARRAY(
    SELECT id FROM tenant_icp_signals s
     WHERE s.tenant_id = t.id
       AND s.key IN ('dzial_handlowy', 'opieka_nad_klientem')
  )
FROM tenants t;

-- ── qualification_threshold + wersja 1 + current_version_id, atomowo per tenant.
-- Próg przenosi dzisiejszy per-tenant app_settings.prospect_lead_min_score (domyślnie 45,
-- jeśli tenant nigdy go nie zmieniał) — ten sam wzorzec ciągłości co reszta seeda.
WITH threshold AS (
  SELECT
    t.id AS tenant_id,
    COALESCE(
      (SELECT value::INT FROM app_settings WHERE tenant_id = t.id AND key = 'prospect_lead_min_score'),
      45
    ) AS qualification_threshold
  FROM tenants t
),
agg AS (
  SELECT
    s.tenant_id,
    COALESCE(SUM(s.points) FILTER (WHERE s.active), 0) AS max_score,
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'key', s.key,
        'label', s.label,
        'ai_definition', s.ai_definition,
        'points', s.points,
        'tier', s.tier,
        'active', s.active,
        'sort_order', s.sort_order,
        'requires_any_of', s.requires_any_of
      ) ORDER BY s.sort_order
    ) AS snapshot
  FROM tenant_icp_signals s
  GROUP BY s.tenant_id
),
ins_version AS (
  INSERT INTO tenant_icp_config_versions (tenant_id, version, qualification_threshold, max_score, snapshot)
  SELECT
    th.tenant_id,
    1,
    th.qualification_threshold,
    COALESCE(agg.max_score, 0),
    COALESCE(agg.snapshot, '[]'::jsonb)
  FROM threshold th
  LEFT JOIN agg ON agg.tenant_id = th.tenant_id
  ON CONFLICT (tenant_id, version) DO NOTHING
  RETURNING id, tenant_id, qualification_threshold
)
INSERT INTO tenant_icp_configs (tenant_id, qualification_threshold, current_version_id)
SELECT tenant_id, qualification_threshold, id
FROM ins_version
ON CONFLICT (tenant_id) DO NOTHING;
