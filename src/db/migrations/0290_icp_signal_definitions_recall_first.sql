-- Migration 0290: ICP signal ai_definition — jednorazowa synchronizacja
-- recall-first przeredagowania promptu (decyzja biznesowa 2026-09-23,
-- patrz też PROMPT_STATIC_HEADER w prospectEnrichmentService.js — TA
-- migracja zmienia tylko per-sygnałowe ai_definition w bazie, wspólna
-- zasada w nagłówku promptu żyje wyłącznie w kodzie, nie w DB).
--
-- Cel: pracownicy CRM mają na prospektach pracować i dzwonić — koszt
-- pominiętego, realnego leada (false negative) jest wyższy niż koszt
-- zbędnego telefonu (false positive). Definicje 7 AKTYWNYCH sygnałów
-- zostały poluzowane: dopuszczają wiarygodną przesłankę biznesową bez
-- wymogu literalnej frazy, oceniają semantycznie, przy rozsądnej
-- niepewności preferują TRUE — ale nigdy bez ŻADNEJ konkretnej przesłanki
-- w tekście. Pełne uzasadnienie per sygnał: icpSignalPromptDefinitions.test.js.
--
-- NIE ZMIENIA: points, active, sort_order, label, short_description, tier,
-- requires_any_of, threshold, żadnej logiki scoringu — WYŁĄCZNIE
-- ai_definition (treść instrukcji dla AI).
--
-- BEZPIECZEŃSTWO (ten sam wzorzec co 0289 dla label): UPDATE dotyka
-- WYŁĄCZNIE wierszy, których ai_definition dokładnie odpowiada znanemu,
-- aktualnemu tekstowi domyślnemu (zapytanie do bazy przed napisaniem tej
-- migracji potwierdziło: każdy z 7 kluczy ma dziś 1-2 warianty w całej
-- bazie, wszystkie to kosmetyczne warianty tego samego domyślnego tekstu —
-- ŻADEN tenant nie ma dotąd realnie własnej, niestandardowej ai_definition
-- dla tych kluczy). Jeśli w przyszłości jakiś tenant ręcznie zmieni
-- ai_definition, ta migracja (uruchomiona ponownie / jednorazowo) go NIE
-- dotknie — dokładnie tak jak 0289 nie dotyka ręcznie zmienionych label.

DROP TABLE IF EXISTS pg_temp.icp_recall_first_definitions;

CREATE TEMP TABLE icp_recall_first_definitions (
  key            VARCHAR(64) PRIMARY KEY,
  old_variants   TEXT[] NOT NULL,
  new_definition TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'dzial_handlowy',
  ARRAY[
    $old1_0$RÓWNOWAŻNE nazwy tej samej struktury — traktuj jako identyczny dowód, nie tylko dosłowne
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
Drugorzędne wsparcie: sam adres sprzedaz@/sales@ — może być zwykłą skrzynką ogólną.$old1_0$
  ],
  $new1$RÓWNOWAŻNE nazwy tej samej struktury — traktuj jako identyczny dowód, nie tylko dosłowne "dział handlowy": "dział handlowy", "dział sprzedaży", "sales team", "sales department", "zespół sprzedaży", "przedstawiciele handlowi", a także dowolny inny opis wskazujący, że ktoś w firmie zajmuje się pozyskiwaniem/obsługą sprzedaży — nie musi paść dosłowna nazwa. Główny dowód: jawnie nazwany dział/zespół sprzedażowy (nagłówek podstrony, sekcja "Nasz zespół sprzedaży", nazwa działu w strukturze firmy, pod dowolną z powyższych równoważnych nazw) — WYSTARCZA nawet przy JEDNEJ widocznej, nazwanej osobie pod tym nagłówkiem, bo dowodem jest nazwana struktura organizacyjna, nie liczba osób. LUB: co najmniej JEDNA nazwana osoba pełniąca rolę stricte handlową (przedstawiciel handlowy, sprzedawca, account manager, dyrektor/kierownik handlowy lub sprzedaży) — wystarcza sama, nawet bez nagłówka działu i bez innych wymienionych handlowców obok niej; sam fakt, że ktoś konkretny w firmie jest wskazany jako odpowiedzialny za sprzedaż, to realny, wystarczający sygnał — nie wymagaj dodatkowo dowodu na istnienie sformalizowanego, wieloosobowego działu. Drugorzędne, ale SAMODZIELNIE WYSTARCZAJĄCE wsparcie: dedykowany adres sprzedaz@/sales@ (lub odpowiednik), aktywna oferta pracy na stanowisko handlowe, dowolna wzmianka o "dziale sprzedaży"/"zespole handlowym" w opisie firmy lub ofercie, nawet bez dalszych szczegółów. ZWRÓĆ FALSE tylko gdy strona nie zawiera ŻADNEJ wzmianki o osobie/dziale/procesie sprzedażowym — np. wyłącznie katalog produktów bez jakiegokolwiek śladu obsługi handlowej.$new1$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'zlozony_proces_sprzedazy',
  ARRAY[
    $old2_0$Relacyjny, projektowy lub negocjacyjny model PROCESU SPRZEDAŻY, nie zakup impulsowy. KLUCZOWA GRANICA: cena musi być ustalana INDYWIDUALNIE, PO stronie firmy, na podstawie potrzeb/specyfikacji konkretnego klienta — nie może być z góry jawnie podana jako stała kwota za standardowy produkt/usługę. Sam fakt sprzedaży B2B, posiadania formularza kontaktowego lub możliwości "skontaktowania się ze sprzedażą" NIE wystarcza, jeśli nie towarzyszy temu informacja, że wycena/oferta jest przygotowywana indywidualnie. Główny dowód — wymagany KONKRETNY dowód PROCESU OFERTOWEGO, jedno z poniższych: indywidualna oferta; indywidualna wycena; przygotowanie oferty PO poznaniu wymagań klienta (indywidualna kalkulacja); RFQ / zapytanie ofertowe PROWADZĄCE DO przygotowania oferty; negocjowanie indywidualnych warunków/ceny; frazy CTA równoważne powyższym — "zapytaj o ofertę", "poproś o wycenę", "przygotujemy ofertę", "wycena indywidualna", "wyślij zapytanie ofertowe". NIE WYSTARCZA (to osobne sygnały, nie ten): sama konsultacja, sam dobór/ rekomendacja rozwiązania czy konfiguracji pod potrzeby klienta bez wzmianki o etapie oferty/wyceny (to dowód dla konsultacja_demo, nie tego sygnału — dobór rozwiązania SAM W SOBIE nie implikuje indywidualnej kalkulacji ceny); sam projekt "pod klienta"; sam brak jawnego cennika bez żadnej z powyższych fraz. ZWRÓĆ FALSE: jawna, stała cena konkretnego produktu/usługi (cennik, cena jednostkowa przy produkcie w sklepie/katalogu) — to standardowa sprzedaż, nie indywidualna wycena, NAWET jeśli produkt jest sprzedawany firmom; format "od X zł" przy produkcie/usłudze/pokoju/pakiecie — to publiczny cennik z progami cenowymi, nie dowód indywidualnej kalkulacji dla konkretnego klienta; standardowa, jawnie podana cena pokoju/usługi/pakietu (np. cennik hotelowy, konsumencki cennik pakietów) — nawet jeśli firma osobno obsługuje też klientów biznesowych, sam TEN dowód tego nie potwierdza. UWAGA: jeśli firma ma OSOBNY, jawny cennik dla JEDNEJ usługi (np. standardowy nocleg) ORAZ oddzielnie opisany proces ofertowy dla INNEJ, odrębnej usługi (np. eventy/konferencje B2B, zamówienia produkcyjne) — oceniaj dowód dla tej DRUGIEJ usługi niezależnie; jawny cennik jednej usługi nie dyskwalifikuje automatycznie dowodu dla innej; sam kontakt do działu sprzedaży / formularz kontaktowy / "skontaktuj się z nami" BEZ jawnej informacji, że oferta/cena jest przygotowywana indywidualnie dla klienta — to zwykły kanał kontaktu, nie dowód procesu ofertowego. Drugorzędne wsparcie (NIE wystarcza samo): sam brak jawnego cennika bez którejś z powyższych fraz — brak ceny sam w sobie nie jest dowodem złożonego procesu sprzedaży.$old2_0$
  ],
  $new2$Relacyjny, projektowy lub negocjacyjny model PROCESU SPRZEDAŻY, nie zakup impulsowy. GRANICA (interpretuj semantycznie, nie tylko dosłownie): cena/oferta jest ustalana w jakimś stopniu INDYWIDUALNIE, na podstawie potrzeb/specyfikacji konkretnego klienta — nie musi być to jawnie nazwane "wyceną indywidualną", wystarczy wiarygodny opis wskazujący na ten sam mechanizm innymi słowami. Główny dowód, dowolne z poniższych LUB semantyczny odpowiednik: indywidualna oferta/wycena; przygotowanie oferty po poznaniu wymagań klienta; RFQ/zapytanie ofertowe prowadzące do oferty; negocjowanie warunków/ceny; elastyczne/dostosowywane do klienta warunki współpracy, umowy "szyte na miarę"; frazy CTA typu "zapytaj o ofertę", "poproś o wycenę", "przygotujemy ofertę", "wycena indywidualna", "wyślij zapytanie ofertowe" — TO PRZYKŁADY, nie zamknięta lista: dowolny kontakt do działu sprzedaży/ofert w kontekście przygotowania propozycji dla konkretnego klienta liczy się tak samo (np. "skontaktuj się w sprawie oferty/wyceny", "zapytaj o warunki współpracy" i semantycznie podobne). Jeśli jedyny dostępny dowód to sam dobór/rekomendacja rozwiązania bez ŻADNEJ wzmianki o etapie oferty/ceny — to wciąż przede wszystkim dowód dla konsultacja_demo; ale gdy tekst łączy dobór rozwiązania Z choćby pośrednią wzmianką o dalszym etapie wyceny/umowy, licz to też tutaj. ZWRÓĆ FALSE: jawna, stała cena KONKRETNEGO produktu/usługi (cennik, cena jednostkowa w sklepie/katalogu) — to nadal standardowa sprzedaż, NAWET jeśli produkt jest sprzedawany firmom, chyba że firma OSOBNO opisuje proces ofertowy dla innej usługi (wtedy oceniaj tę drugą niezależnie). Przy braku jawnego cennika ORAZ przy braku jakiejkolwiek wzmianki o procesie ofertowym — przechyl się w stronę TRUE, jeśli firma jednoznacznie sprzedaje B2B produkty/usługi o charakterze projektowym, złożonym lub wymagającym dopasowania (nie dla prostych, jednorodnych produktów/usług o oczywistej standardowej cenie).$new2$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'konsultacja_demo',
  ARRAY[
    $old3_0$Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy
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
niezależnie, ale nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów.$old3_0$
  ],
  $new3$Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy z jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach). RÓWNOWAŻNE określenia tego samego etapu procesu — traktuj jako ten sam dowód: konsultacja, demo, dobór rozwiązania, analiza potrzeb, dobór techniczny, doradztwo przedsprzedażowe, projektowanie pod klienta/indywidualnego klienta, a także dowolny inny opis wskazujący, że przed zakupem ktoś z firmy rozmawia z klientem o jego potrzebach — nie wymagaj dosłownej frazy z listy niżej. Główny dowód (dosłowna fraza LUB semantyczny odpowiednik — oba liczą się tak samo): "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania"; przypisany doradca/opiekun/dyrektor regionalny opisany jako wspierający wybór rozwiązania, nawet bez słowa "konsultacja"; formularz zbierający parametry zamówienia (RFQ, zapytanie z polami technicznymi); sprzedaż oparta na indywidualnym projekcie technicznym/architektonicznym, gdzie analiza wymagań klienta jest choćby pośrednio wskazanym etapem procesu; produkcja/ usługa "na wymiar", "pod klienta", "na życzenie klienta" opisana jako WYNIK współpracy z klientem (nie tylko jako zdolność produkcyjna) — traktuj to jako wiarygodną przesłankę, że jakaś forma ustalania rozwiązania z klientem musiała zajść, nawet bez opisanego wprost „etapu rozmowy”. NIE LICZY SIĘ (to inny etap obsługi, nie sprzedażowy): doradca/opiekun ds. likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji, serwisant, doradca serwisowy wsparcia posprzedażowego — to obsługa PO zakupie, nie etap decyzji o zakupie; ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada niezwiązana z konkretną usługą/osobą w tej firmie). ZASTRZEŻENIE: nie ustawiaj true wyłącznie z samej nazwy branży bez żadnego punktu zaczepienia w tekście — ale gdy tekst opisuje choćby zarys procesu doboru/dopasowania rozwiązania do klienta, przy niepewności wybieraj true. Jeśli to ten sam fragment tekstu co dowód dla zlozony_proces_sprzedazy, oceń oba sygnały niezależnie — nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów, ale oba mogą wyjść true z tego samego opisu, jeśli faktycznie potwierdza oba zjawiska.$new3$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'opieka_nad_klientem',
  ARRAY[
    $old4_0$KLUCZOWA GRANICA: sygnał wymaga OSOBY (lub zespołu) PRZYPISANEJ NA STAŁE do konkretnego klienta, konta lub segmentu i odpowiedzialnej za CIĄGŁĄ relację z nim — nie samego istnienia działu/zespołu sprzedaży ani jednej rozmowy sprzedażowej. Rozstrzyga to, czy tekst albo (a) używa słownictwa dedykowanej opieki ("opiekun", "KAM", "Key Account Manager/Advisor", "account manager", "doradca ds. kluczowych klientów"), albo (b) wprost opisuje osobę jako odpowiedzialną NA STAŁE za określony obszar/segment/konto klienta — sama nazwa stanowiska sprzedażowego (bez żadnego z tych dwóch elementów) NIE wystarcza. RÓWNOWAŻNE określenia — traktuj jako ten sam dowód: dedykowany opiekun, Key Account Manager (KAM), account manager, customer success, opieka handlowa B2B, opiekun biznesowy. Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager", "account manager", "Customer Success", "stała opieka nad klientem", LUB osoba jawnie opisana jako odpowiedzialna na stałe za dany segment/branżę/konto klienta (np. "kontakt z konsultantem odpowiedzialnym za daną branżę"), nawet bez słowa "opiekun"/"KAM" wprost. Stanowiska/oferty pracy "Specjalista ds. klientów kluczowych", "Key Account Manager", "opiekun klienta biznesowego" i ich jednoznaczne odpowiedniki to RÓWNIEŻ mocny dowód — ogłoszenie o pracę na taką rolę liczy się tak samo jak opis usługi na stronie. ZWRÓĆ FALSE: samo Biuro Obsługi Klienta (BOK), sama infolinia, LUB nazwany kierownik/osoba zarządzająca BOK — to nadal ogólna, niezróżnicowana obsługa, nie opieka przypisana do konkretnego klienta/konta; zwykły handlowiec/przedstawiciel handlowy przypisany do REGIONU/terytorium — to pozyskiwanie sprzedaży na obszarze, nie opieka nad już pozyskanym, konkretnym klientem — chyba że tekst wprost nazywa tę osobę opiekunem/KAM lub opisuje ją jako odpowiedzialną na stałe za konkretne konto (nie tylko za "sprzedaż w regionie X"); Kierownik/Dyrektor Działu Sprzedaży — to funkcja zarządcza zespołu sprzedaży, nie osobista, ciągła opieka nad klientem; sam kontakt do działu sprzedaży (telefon/e-mail działu) bez informacji o stałej, przypisanej opiece nad konkretnym klientem/kontem; sama opieka powdrożeniowa, serwis, utrzymanie, aktualizacje, przeglądy czy odnowienia umów/usług BEZ wzmianki o przypisanym opiekunie/KAM — to dowód dla cykliczna_obsluga_klienta_odnowienia (CO się powtarzalnie dzieje z klientem), nie dla tego sygnału (KTO jest za niego stale odpowiedzialny) — oceniaj oba sygnały niezależnie.$old4_0$
  ],
  $new4$GRANICA (interpretuj semantycznie): sygnał dotyczy OSOBY (lub zespołu) odpowiedzialnej za relację z klientem/kontem/segmentem w sposób choćby trochę bardziej trwały niż jednorazowa rozmowa sprzedażowa — nie wymagaj dosłownego słowa "opiekun"/"KAM", wystarczy wiarygodny opis pełniący tę samą funkcję. RÓWNOWAŻNE określenia — traktuj jako ten sam dowód: dedykowany opiekun, Key Account Manager (KAM), account manager, customer success, opieka handlowa B2B, opiekun biznesowy, opiekun regionalny/terytorialny, konsultant przypisany do klienta/branży. Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager", "account manager", "Customer Success", "stała opieka nad klientem", LUB jakakolwiek osoba/rola opisana jako punkt kontaktu dla klienta w dłuższej relacji (np. "kontakt z konsultantem odpowiedzialnym za daną branżę", handlowiec/przedstawiciel przypisany do regionu lub konta, nawet bez słowa "opiekun"/"KAM" wprost) — sam fakt, że klient ma jedną, wskazaną osobę do kontaktu, a nie tylko ogólną infolinię, to wystarczający sygnał. Oferty pracy na takie role liczą się tak samo jak opis usługi na stronie. ZWRÓĆ FALSE: wyłącznie ogólne, niezróżnicowane Biuro Obsługi Klienta/infolinia BEZ ŻADNEJ wzmianki o przypisanej osobie/koncie/segmencie — jeśli jest choćby cień wzmianki o osobie przypisanej do klienta/branży/regionu, przechyl się w stronę true. Sama opieka powdrożeniowa/serwis/odnowienia BEZ żadnej wzmianki o osobie odpowiedzialnej to przede wszystkim dowód dla cykliczna_obsluga_klienta_odnowienia (CO się dzieje), nie dla tego sygnału (KTO jest odpowiedzialny) — oceniaj oba niezależnie, ale gdy tekst łączy oba wątki, oba mogą wyjść true.$new4$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'przetargi',
  ARRAY[
    $old5_0$Firma SPRZEDAJE w przetargach jako wykonawca/dostawca — UWAGA, częsta pomyłka w obie
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
"profil nabywcy".$old5_0$
  ],
  $new5$Firma SPRZEDAJE w przetargach jako wykonawca/dostawca — UWAGA, częsta pomyłka w obie strony (KIERUNEK jest tu logiczną sprzecznością, nie kwestią interpretacji — nie zmieniaj go mimo ogólnej zasady recall-first). Dowód pozytywny (true): jawny lub semantycznie równoważny opis REALNEGO udziału w postępowaniu przetargowym JAKO WYKONAWCA/OFERENT/ DOSTAWCA — "realizujemy zamówienia publiczne", "oferta dla sektora publicznego", "doświadczenie w przetargach", "specjalista ds. przetargów/ofertowania", "startujemy w przetargach", "oferty przetargowe", "wygraliśmy przetarg", a także mocne pośrednie wskazówki jak lista licznych zamawiających publicznych (gminy, urzędy, spółki Skarbu Państwa) opisana jako REALIZACJE/klienci firmy — przy większej liczbie takich referencji przechyl się w stronę true nawet bez dosłownego słowa "przetarg", bo taka skala zwykle oznacza pozyskiwanie kontraktów w trybie zamówień publicznych. Pojedynczy klient publiczny w portfolio bez innych wskazówek to wciąż za mało. NIE liczy się, nawet jeśli słowo "przetarg" występuje (to firma KUPUJĄCA, zwróć false): "postępowania zakupowe", "zamówienia dla dostawców", "przetargi organizowane przez nas", "profil nabywcy".$new5$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'siec_partnerow',
  ARRAY[
    $old6_0$KLUCZOWY WARUNEK — KIERUNEK RELACJI: sygnał dotyczy WYŁĄCZNIE sytuacji, w której BADANA
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
PRODUKTY/USŁUGI TEJ FIRMY (nie cudzej), nie samo słowo "partner" w dowolnym znaczeniu.$old6_0$
  ],
  $new6$KLUCZOWY WARUNEK — KIERUNEK RELACJI (to logiczna sprzeczność, nie kwestia interpretacji — nie zmieniaj tego mimo ogólnej zasady recall-first): sygnał dotyczy WYŁĄCZNIE sytuacji, w której BADANA FIRMA jest DOSTAWCĄ posiadającym/organizującym WŁASNĄ, zewnętrzną sieć sprzedaży — niezależne podmioty (dealerzy, dystrybutorzy, resellerzy, partnerzy handlowi), które ODSPRZEDAJĄ PRODUKTY LUB USŁUGI TEJ FIRMY. Zanim uznasz dowód za wystarczający, ustal kto jest dostawcą, a kto odsprzedawcą w opisanej relacji — sam fakt użycia słowa "partner"/ "dealer"/"dystrybutor" NIE wystarcza, jeśli kierunek relacji jest inny albo niesprzedażowy. Poza tym warunkiem kierunku, resztę oceniaj semantycznie i liberalnie — nie wymagaj dosłownych fraz z listy niżej, wystarczy wiarygodny opis tego samego mechanizmu. Główny dowód: "zostań partnerem", "sieć dealerska", "dla dystrybutorów", "strefa partnera" w domenie firmy — w kontekście rekrutacji odsprzedawców JEJ WŁASNYCH produktów/usług — LUB jawnie wymieniona lista niezależnych dystrybutorów/przedstawicieli na rynkach zagranicznych, którzy sprzedają dalej produkty tej firmy. ZASADA POZYTYWNA: jeżeli badana firma zaprasza inne firmy/sprzedawców do sprzedaży lub dystrybucji JEJ WŁASNYCH produktów/usług i opisuje to jako współpracę z dystrybutorami, dealerami, resellerami lub partnerami handlowymi — to jest to true, niezależnie od dokładnego sformułowania. Przykład: "Sprzedajesz nasze produkty / produkty z naszej kategorii? Rozpocznij z nami współpracę" połączone z informacją o modelu współpracy z dystrybutorami — to true, bo badana firma jest tu DOSTAWCĄ/PRODUCENTEM, a zewnętrzny podmiot ma sprzedawać JEJ ofertę. ZWRÓĆ FALSE (częste pomyłki w obie strony): firma SAMA jest dealerem/dystrybutorem/autoryzowanym partnerem CUDZEJ marki (np. "jesteśmy oficjalnym dystrybutorem [producenta X]") — to ONA jest odsprzedawcą, nie dostawcą budującym własną sieć; jej WŁASNY dział montażu/instalacji/serwisu również się nie liczy, to wewnętrzny zespół, nie zewnętrzna sieć; firma REKRUTUJE przewoźników, podwykonawców lub dostawców do współpracy z NIĄ (np. "zostań naszym partnerem" skierowane do przewoźników/poddostawców, którzy będą świadczyć usługę DLA tej firmy) — to ona jest stroną KUPUJĄCĄ usługę/zdolność, nie buduje sieci odsprzedającej jej produkty; "partner" oznacza partnera eventowego, marketingowego, lokalną atrakcję turystyczną lub inną współpracę niesprzedażową (patronat, cross-promocja, sponsoring); ogólne, marketingowe użycie słowa "partner"/"partnerzy" oznaczające KLIENTÓW lub relacje biznesowe w ogóle (np. "budujemy długoterminowe relacje z partnerami na całym świecie", "dostarczamy naszym partnerom niezawodne produkty"); linki do spółek-sióstr/spółek z tej samej grupy kapitałowej — to nie sieć odsprzedawców, tylko wewnętrzna struktura grupy — chyba że tekst wprost opisuje je jako dealerów/dystrybutorów tej firmy, nie jako powiązane firmy. Wymagany jest jawny kontekst NIEZALEŻNEGO podmiotu odsprzedającego/dystrybuującego PRODUKTY/USŁUGI TEJ FIRMY (nie cudzej), nie samo słowo "partner" w dowolnym znaczeniu.$new6$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'cykliczna_obsluga_klienta_odnowienia',
  ARRAY[
    $old7_0$Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i występują kolejne zaplanowane zdarzenia wymagające obsługi.

TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole albo inne powtarzalne działania dotyczące tego samego klienta.

Nie wystarcza sama możliwość ponownego zakupu, newsletter, program lojalnościowy, automatyczny abonament ani ogólne hasło „serwis". Musi istnieć realna, powtarzalna obsługa relacji z klientem.$old7_0$,
    $old7_1$Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i występują kolejne zaplanowane zdarzenia wymagające obsługi.

TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole albo inne powtarzalne działania dotyczące tego samego klienta.

Nie wystarcza sama możliwość ponownego zakupu, newsletter, program lojalnościowy, automatyczny abonament ani ogólne hasło „serwis”. Musi istnieć realna, powtarzalna obsługa relacji z klientem.$old7_1$
  ],
  $new7$Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i występują kolejne zaplanowane zdarzenia wymagające obsługi — interpretuj semantycznie, nie wymagaj dosłownych fraz z listy niżej.

TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole, gwarancję z obowiązkowymi przeglądami, wsparcie posprzedażowe opisane jako ciągłe/długoterminowe, albo inne wiarygodnie powtarzalne działania dotyczące tego samego klienta — także gdy wynika to tylko pośrednio z charakteru usługi (np. serwis urządzeń/instalacji zwykle wymaga okresowych przeglądów, nawet bez wprost opisanego harmonogramu).

Nie wystarcza sama możliwość ponownego zakupu, newsletter lub program lojalnościowy bez żadnego innego śladu ciągłej obsługi. Automatyczny abonament oraz ogólne hasło „serwis" TEŻ się liczą, jeśli towarzyszy im choćby minimalny opis powtarzalności — przy niepewności wybieraj true, o ile jest jakikolwiek konkretny punkt zaczepienia w tekście.$new7$
);

-- ── Zastosuj: tylko wiersze, których ai_definition jest DOKŁADNIE jednym
-- ze znanych, aktualnych wariantów domyślnych ──────────────────────────────
UPDATE tenant_icp_signals s
   SET ai_definition = d.new_definition,
       updated_at    = now()
  FROM icp_recall_first_definitions d
 WHERE s.key = d.key
   AND s.ai_definition = ANY(d.old_variants)
   AND EXISTS (SELECT 1 FROM tenants tn WHERE tn.id = s.tenant_id AND tn.deleted_at IS NULL);

-- ── Opublikuj nową wersję tam, gdzie ai_definition w LIVE różni się od
-- ostatniego PUBLISHED snapshotu (ten sam wzorzec co 0289, ale odcisk po
-- (key, ai_definition) zamiast (key, label)) ───────────────────────────────
WITH live AS (
  SELECT
    s.tenant_id,
    COALESCE(SUM(s.points) FILTER (WHERE s.active), 0) AS max_score,
    jsonb_agg(
      jsonb_build_object(
        'id',                s.id,
        'key',               s.key,
        'label',             s.label,
        'ai_definition',     s.ai_definition,
        'short_description', s.short_description,
        'points',            s.points,
        'tier',              s.tier,
        'active',            s.active,
        'sort_order',        s.sort_order,
        'requires_any_of',   s.requires_any_of
      ) ORDER BY s.sort_order
    ) AS snapshot,
    jsonb_agg(jsonb_build_array(s.key, s.ai_definition) ORDER BY s.key) AS definition_fingerprint
  FROM tenant_icp_signals s
  JOIN tenants t ON t.id = s.tenant_id AND t.deleted_at IS NULL
  GROUP BY s.tenant_id
),
needs_publish AS (
  SELECT l.*
    FROM live l
    JOIN tenant_icp_configs c ON c.tenant_id = l.tenant_id
    JOIN tenant_icp_config_versions cv ON cv.id = c.current_version_id
   WHERE l.max_score = 100
     AND cv.max_score = 100
     AND l.definition_fingerprint IS DISTINCT FROM (
           SELECT jsonb_agg(jsonb_build_array(e->>'key', e->>'ai_definition') ORDER BY e->>'key')
             FROM jsonb_array_elements(cv.snapshot) e
         )
),
ins_version AS (
  INSERT INTO tenant_icp_config_versions (tenant_id, version, qualification_threshold, max_score, snapshot)
  SELECT
    np.tenant_id,
    COALESCE((SELECT MAX(v.version) FROM tenant_icp_config_versions v WHERE v.tenant_id = np.tenant_id), 0) + 1,
    COALESCE(
      (SELECT a.value::INT FROM app_settings a
        WHERE a.tenant_id = np.tenant_id AND a.key = 'prospect_lead_min_score'
          AND a.value ~ '^[0-9]+$'),
      45
    ),
    np.max_score,
    np.snapshot
  FROM needs_publish np
  RETURNING id, tenant_id
)
INSERT INTO tenant_icp_configs (tenant_id, current_version_id, config_revision, updated_at)
SELECT iv.tenant_id, iv.id, 1, now()
  FROM ins_version iv
ON CONFLICT (tenant_id) DO UPDATE
  SET current_version_id = EXCLUDED.current_version_id,
      config_revision    = tenant_icp_configs.config_revision + 1,
      updated_at         = now();

-- ── Raport do logu deployu ─────────────────────────────────────────────────
DO $report$
DECLARE
  updated_rows INT;
BEGIN
  SELECT COUNT(*) INTO updated_rows
    FROM tenant_icp_signals s
    JOIN icp_recall_first_definitions d ON d.key = s.key
   WHERE s.ai_definition = d.new_definition;
  RAISE NOTICE 'ICP recall-first: % wierszy tenant_icp_signals ma juz nowa (recall-first) definicje', updated_rows;
END
$report$;
