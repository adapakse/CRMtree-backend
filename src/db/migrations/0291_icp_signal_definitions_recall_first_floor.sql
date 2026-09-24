-- Migration 0291: ICP signal ai_definition — DRUGA TURA recall-first
-- (decyzja biznesowa 2026-09-23). Pierwsza tura (0290) poluzowała 7
-- aktywnych sygnałów tak mocno, że kilka pojedynczych, bardzo słabych
-- faktów mogło samodzielnie zapalać wysokopunktowe sygnały (np. sam alias
-- sprzedaz@/sales@ → 30 pkt dzial_handlowy; sama funkcja Dyrektora Sprzedaży
-- → 10 pkt opieka_nad_klientem; samo duże portfolio klientów publicznych →
-- przetargi bez żadnej wzmianki o trybie zamówienia). Ta migracja przywraca
-- wymóg choć minimalnego kontekstu/interakcji obok samego faktu dla 6 z 7
-- sygnałów — globalna filozofia recall-first (PROMPT_STATIC_HEADER w
-- prospectEnrichmentService.js) ZOSTAJE, cofnięte są tylko te konkretne
-- miejsca. siec_partnerow celowo pominięty — bez analogicznego problemu.
--
-- NIE ZMIENIA: points, active, sort_order, label, short_description, tier,
-- requires_any_of, threshold, liczby sygnałów, żadnej logiki scoringu —
-- WYŁĄCZNIE ai_definition (treść instrukcji dla AI) tych 6 kluczy.
--
-- BEZPIECZEŃSTWO (ten sam wzorzec co 0289/0290): UPDATE dotyka WYŁĄCZNIE
-- wierszy, których ai_definition dokładnie odpowiada znanemu, aktualnemu
-- (pierwsza tura, 0290) tekstowi — TARGETED, nie "wszystkie wiersze o tym
-- kluczu". Tenant z własną, ręcznie zmienioną ai_definition dla któregoś z
-- tych kluczy zostaje NIETKNIĘTY, dokładnie tak jak 0289 nie dotyka ręcznie
-- zmienionych label.

DROP TABLE IF EXISTS pg_temp.icp_recall_first_definitions;

CREATE TEMP TABLE icp_recall_first_definitions (
  key            VARCHAR(64) PRIMARY KEY,
  old_variants   TEXT[] NOT NULL,
  new_definition TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'dzial_handlowy',
  ARRAY[
    $old1_0$RÓWNOWAŻNE nazwy tej samej struktury — traktuj jako identyczny dowód, nie tylko dosłowne "dział handlowy": "dział handlowy", "dział sprzedaży", "sales team", "sales department", "zespół sprzedaży", "przedstawiciele handlowi", a także dowolny inny opis wskazujący, że ktoś w firmie zajmuje się pozyskiwaniem/obsługą sprzedaży — nie musi paść dosłowna nazwa. Główny dowód: jawnie nazwany dział/zespół sprzedażowy (nagłówek podstrony, sekcja "Nasz zespół sprzedaży", nazwa działu w strukturze firmy, pod dowolną z powyższych równoważnych nazw) — WYSTARCZA nawet przy JEDNEJ widocznej, nazwanej osobie pod tym nagłówkiem, bo dowodem jest nazwana struktura organizacyjna, nie liczba osób. LUB: co najmniej JEDNA nazwana osoba pełniąca rolę stricte handlową (przedstawiciel handlowy, sprzedawca, account manager, dyrektor/kierownik handlowy lub sprzedaży) — wystarcza sama, nawet bez nagłówka działu i bez innych wymienionych handlowców obok niej; sam fakt, że ktoś konkretny w firmie jest wskazany jako odpowiedzialny za sprzedaż, to realny, wystarczający sygnał — nie wymagaj dodatkowo dowodu na istnienie sformalizowanego, wieloosobowego działu. Drugorzędne, ale SAMODZIELNIE WYSTARCZAJĄCE wsparcie: dedykowany adres sprzedaz@/sales@ (lub odpowiednik), aktywna oferta pracy na stanowisko handlowe, dowolna wzmianka o "dziale sprzedaży"/"zespole handlowym" w opisie firmy lub ofercie, nawet bez dalszych szczegółów. ZWRÓĆ FALSE tylko gdy strona nie zawiera ŻADNEJ wzmianki o osobie/dziale/procesie sprzedażowym — np. wyłącznie katalog produktów bez jakiegokolwiek śladu obsługi handlowej.$old1_0$
  ],
  $new1$RÓWNOWAŻNE nazwy tej samej struktury — traktuj jako identyczny dowód, nie tylko dosłowne "dział handlowy": "dział handlowy", "dział sprzedaży", "sales team", "sales department", "zespół sprzedaży", "przedstawiciele handlowi", a także dowolny inny opis wskazujący, że ktoś w firmie zajmuje się pozyskiwaniem/obsługą sprzedaży — nie musi paść dosłowna nazwa. Główny dowód: jawnie nazwany dział/zespół sprzedażowy (nagłówek podstrony, sekcja "Nasz zespół sprzedaży", nazwa działu w strukturze firmy, pod dowolną z powyższych równoważnych nazw) — WYSTARCZA nawet przy JEDNEJ widocznej, nazwanej osobie pod tym nagłówkiem, bo dowodem jest nazwana struktura organizacyjna, nie liczba osób. LUB: co najmniej JEDNA nazwana osoba, dla której KONTEKST na stronie (tytuł stanowiska, opis roli, nagłówek sekcji) wskazuje, że realnie zajmuje się sprzedażą/ofertowaniem (przedstawiciel handlowy, sprzedawca, account manager, dyrektor/kierownik handlowy lub sprzedaży) — wystarcza sama, nawet bez nagłówka działu i bez innych wymienionych handlowców obok niej. NIE WYSTARCZA (poprawka 23.09, druga tura): sama wizytówka/dane kontaktowe osoby bez żadnego opisu jej roli — samo imię i nazwisko z telefonem/e-mailem w sekcji "Kontakt", bez tytułu ani opisu wskazującego na sprzedaż, to za mało; musi być choć minimalny kontekst, że ta osoba realnie prowadzi sprzedaż/ofertowanie. Drugorzędne wsparcie, WYSTARCZAJĄCE SAMODZIELNIE: aktywna oferta pracy na stanowisko handlowe, LUB dowolna wzmianka o "dziale sprzedaży"/"zespole handlowym" w opisie firmy lub ofercie, nawet bez dalszych szczegółów. Drugorzędne wsparcie, NIE WYSTARCZAJĄCE SAMODZIELNIE (poprawka 23.09, druga tura): sam dedykowany adres sprzedaz@/sales@ (lub odpowiednik) — to może być zwykła ogólna skrzynka; liczy się dopiero razem z jakąkolwiek inną, choćby słabą wzmianką o sprzedaży obok siebie. ZWRÓĆ FALSE tylko gdy strona nie zawiera ŻADNEJ wzmianki o osobie/dziale/procesie sprzedażowym — np. wyłącznie katalog produktów bez jakiegokolwiek śladu obsługi handlowej.$new1$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'zlozony_proces_sprzedazy',
  ARRAY[
    $old2_0$Relacyjny, projektowy lub negocjacyjny model PROCESU SPRZEDAŻY, nie zakup impulsowy. GRANICA (interpretuj semantycznie, nie tylko dosłownie): cena/oferta jest ustalana w jakimś stopniu INDYWIDUALNIE, na podstawie potrzeb/specyfikacji konkretnego klienta — nie musi być to jawnie nazwane "wyceną indywidualną", wystarczy wiarygodny opis wskazujący na ten sam mechanizm innymi słowami. Główny dowód, dowolne z poniższych LUB semantyczny odpowiednik: indywidualna oferta/wycena; przygotowanie oferty po poznaniu wymagań klienta; RFQ/zapytanie ofertowe prowadzące do oferty; negocjowanie warunków/ceny; elastyczne/dostosowywane do klienta warunki współpracy, umowy "szyte na miarę"; frazy CTA typu "zapytaj o ofertę", "poproś o wycenę", "przygotujemy ofertę", "wycena indywidualna", "wyślij zapytanie ofertowe" — TO PRZYKŁADY, nie zamknięta lista: dowolny kontakt do działu sprzedaży/ofert w kontekście przygotowania propozycji dla konkretnego klienta liczy się tak samo (np. "skontaktuj się w sprawie oferty/wyceny", "zapytaj o warunki współpracy" i semantycznie podobne). Jeśli jedyny dostępny dowód to sam dobór/rekomendacja rozwiązania bez ŻADNEJ wzmianki o etapie oferty/ceny — to wciąż przede wszystkim dowód dla konsultacja_demo; ale gdy tekst łączy dobór rozwiązania Z choćby pośrednią wzmianką o dalszym etapie wyceny/umowy, licz to też tutaj. ZWRÓĆ FALSE: jawna, stała cena KONKRETNEGO produktu/usługi (cennik, cena jednostkowa w sklepie/katalogu) — to nadal standardowa sprzedaż, NAWET jeśli produkt jest sprzedawany firmom, chyba że firma OSOBNO opisuje proces ofertowy dla innej usługi (wtedy oceniaj tę drugą niezależnie). Przy braku jawnego cennika ORAZ przy braku jakiejkolwiek wzmianki o procesie ofertowym — przechyl się w stronę TRUE, jeśli firma jednoznacznie sprzedaje B2B produkty/usługi o charakterze projektowym, złożonym lub wymagającym dopasowania (nie dla prostych, jednorodnych produktów/usług o oczywistej standardowej cenie).$old2_0$
  ],
  $new2$Relacyjny, projektowy lub negocjacyjny model PROCESU SPRZEDAŻY, nie zakup impulsowy. GRANICA (interpretuj semantycznie, nie tylko dosłownie): cena/oferta jest ustalana w jakimś stopniu INDYWIDUALNIE, na podstawie potrzeb/specyfikacji konkretnego klienta — nie musi być to jawnie nazwane "wyceną indywidualną", wystarczy wiarygodny opis wskazujący na ten sam mechanizm innymi słowami. Główny dowód (wystarcza sam), dowolne z poniższych LUB semantyczny odpowiednik: indywidualna oferta/wycena; przygotowanie oferty po poznaniu wymagań klienta; RFQ/zapytanie ofertowe prowadzące do oferty; negocjowanie warunków/ceny; elastyczne/dostosowywane do klienta warunki współpracy, umowy "szyte na miarę". Drugorzędne wsparcie (poprawka 23.09, druga tura — NIE wystarcza samo, potrzebuje obok siebie choć śladu, że oferta/cena faktycznie jest przygotowywana indywidualnie, nie standardowo): generyczne frazy CTA typu "zapytaj o ofertę", "poproś o wycenę", "przygotujemy ofertę", "skontaktuj się w sprawie oferty/wyceny", "zapytaj o warunki współpracy", sam kontakt do działu sprzedaży/ofert bez dalszego kontekstu — te wskazują na kanał kontaktu, ale same nie potwierdzają, że wycena jest indywidualna, a nie standardowa odpowiedź na zapytanie. Jeśli jedyny dostępny dowód to sam dobór/rekomendacja rozwiązania bez ŻADNEJ wzmianki o etapie oferty/ceny — to wciąż przede wszystkim dowód dla konsultacja_demo; ale gdy tekst łączy dobór rozwiązania Z choćby pośrednią wzmianką o dalszym etapie wyceny/umowy, licz to też tutaj. ZWRÓĆ FALSE: jawna, stała cena KONKRETNEGO produktu/usługi (cennik, cena jednostkowa w sklepie/katalogu) — to nadal standardowa sprzedaż, NAWET jeśli produkt jest sprzedawany firmom, chyba że firma OSOBNO opisuje proces ofertowy dla innej usługi (wtedy oceniaj tę drugą niezależnie). Przy braku jawnego cennika ORAZ przy braku jakiejkolwiek wzmianki o procesie ofertowym — przechyl się w stronę TRUE, jeśli firma jednoznacznie sprzedaje B2B produkty/usługi o charakterze projektowym, złożonym lub wymagającym dopasowania (nie dla prostych, jednorodnych produktów/usług o oczywistej standardowej cenie).$new2$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'konsultacja_demo',
  ARRAY[
    $old3_0$Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy z jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach). RÓWNOWAŻNE określenia tego samego etapu procesu — traktuj jako ten sam dowód: konsultacja, demo, dobór rozwiązania, analiza potrzeb, dobór techniczny, doradztwo przedsprzedażowe, projektowanie pod klienta/indywidualnego klienta, a także dowolny inny opis wskazujący, że przed zakupem ktoś z firmy rozmawia z klientem o jego potrzebach — nie wymagaj dosłownej frazy z listy niżej. Główny dowód (dosłowna fraza LUB semantyczny odpowiednik — oba liczą się tak samo): "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania"; przypisany doradca/opiekun/dyrektor regionalny opisany jako wspierający wybór rozwiązania, nawet bez słowa "konsultacja"; formularz zbierający parametry zamówienia (RFQ, zapytanie z polami technicznymi); sprzedaż oparta na indywidualnym projekcie technicznym/architektonicznym, gdzie analiza wymagań klienta jest choćby pośrednio wskazanym etapem procesu; produkcja/ usługa "na wymiar", "pod klienta", "na życzenie klienta" opisana jako WYNIK współpracy z klientem (nie tylko jako zdolność produkcyjna) — traktuj to jako wiarygodną przesłankę, że jakaś forma ustalania rozwiązania z klientem musiała zajść, nawet bez opisanego wprost „etapu rozmowy”. NIE LICZY SIĘ (to inny etap obsługi, nie sprzedażowy): doradca/opiekun ds. likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji, serwisant, doradca serwisowy wsparcia posprzedażowego — to obsługa PO zakupie, nie etap decyzji o zakupie; ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada niezwiązana z konkretną usługą/osobą w tej firmie). ZASTRZEŻENIE: nie ustawiaj true wyłącznie z samej nazwy branży bez żadnego punktu zaczepienia w tekście — ale gdy tekst opisuje choćby zarys procesu doboru/dopasowania rozwiązania do klienta, przy niepewności wybieraj true. Jeśli to ten sam fragment tekstu co dowód dla zlozony_proces_sprzedazy, oceń oba sygnały niezależnie — nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów, ale oba mogą wyjść true z tego samego opisu, jeśli faktycznie potwierdza oba zjawiska.$old3_0$
  ],
  $new3$Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy z jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach). RÓWNOWAŻNE określenia tego samego etapu procesu — traktuj jako ten sam dowód: konsultacja, demo, dobór rozwiązania, analiza potrzeb, dobór techniczny, doradztwo przedsprzedażowe, projektowanie pod klienta/indywidualnego klienta, a także dowolny inny opis wskazujący, że przed zakupem ktoś z firmy rozmawia z klientem o jego potrzebach — nie wymagaj dosłownej frazy z listy niżej. Główny dowód (dosłowna fraza LUB semantyczny odpowiednik — oba liczą się tak samo): "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania"; przypisany doradca/opiekun/dyrektor regionalny opisany jako wspierający wybór rozwiązania, nawet bez słowa "konsultacja"; formularz zbierający parametry zamówienia (RFQ, zapytanie z polami technicznymi); sprzedaż oparta na indywidualnym projekcie technicznym/architektonicznym, gdzie analiza wymagań klienta jest choćby pośrednio wskazanym etapem procesu. GRANICA (poprawka 23.09, druga tura — wcześniejsze pełne złagodzenie cofało już wcześniej sprawdzoną poprawkę): produkcja/usługa "na wymiar", "pod klienta", "na życzenie klienta" NIE WYSTARCZA SAMA jako opis samej zdolności produkcyjnej — musi towarzyszyć jej choć przesłanka INTERAKCJI z klientem przed realizacją (np. "ustalamy z klientem", "po konsultacji", "na podstawie zgłoszonych wymagań", "dobieramy rozwiązanie", "analizujemy potrzeby klienta") — wtedy liczy się nawet bez opisanego wprost odrębnego „etapu rozmowy”. Sam fakt, że produkt "powstaje pod klienta", bez żadnej takiej przesłanki interakcji, to za mało. NIE LICZY SIĘ (to inny etap obsługi, nie sprzedażowy): doradca/opiekun ds. likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji, serwisant, doradca serwisowy wsparcia posprzedażowego — to obsługa PO zakupie, nie etap decyzji o zakupie; ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada niezwiązana z konkretną usługą/osobą w tej firmie). ZASTRZEŻENIE: nie ustawiaj true wyłącznie z samej nazwy branży bez żadnego punktu zaczepienia w tekście — ale gdy tekst opisuje choćby zarys procesu doboru/dopasowania rozwiązania do klienta, przy niepewności wybieraj true. Jeśli to ten sam fragment tekstu co dowód dla zlozony_proces_sprzedazy, oceń oba sygnały niezależnie — nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów, ale oba mogą wyjść true z tego samego opisu, jeśli faktycznie potwierdza oba zjawiska.$new3$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'opieka_nad_klientem',
  ARRAY[
    $old4_0$GRANICA (interpretuj semantycznie): sygnał dotyczy OSOBY (lub zespołu) odpowiedzialnej za relację z klientem/kontem/segmentem w sposób choćby trochę bardziej trwały niż jednorazowa rozmowa sprzedażowa — nie wymagaj dosłownego słowa "opiekun"/"KAM", wystarczy wiarygodny opis pełniący tę samą funkcję. RÓWNOWAŻNE określenia — traktuj jako ten sam dowód: dedykowany opiekun, Key Account Manager (KAM), account manager, customer success, opieka handlowa B2B, opiekun biznesowy, opiekun regionalny/terytorialny, konsultant przypisany do klienta/branży. Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager", "account manager", "Customer Success", "stała opieka nad klientem", LUB jakakolwiek osoba/rola opisana jako punkt kontaktu dla klienta w dłuższej relacji (np. "kontakt z konsultantem odpowiedzialnym za daną branżę", handlowiec/przedstawiciel przypisany do regionu lub konta, nawet bez słowa "opiekun"/"KAM" wprost) — sam fakt, że klient ma jedną, wskazaną osobę do kontaktu, a nie tylko ogólną infolinię, to wystarczający sygnał. Oferty pracy na takie role liczą się tak samo jak opis usługi na stronie. ZWRÓĆ FALSE: wyłącznie ogólne, niezróżnicowane Biuro Obsługi Klienta/infolinia BEZ ŻADNEJ wzmianki o przypisanej osobie/koncie/segmencie — jeśli jest choćby cień wzmianki o osobie przypisanej do klienta/branży/regionu, przechyl się w stronę true. Sama opieka powdrożeniowa/serwis/odnowienia BEZ żadnej wzmianki o osobie odpowiedzialnej to przede wszystkim dowód dla cykliczna_obsluga_klienta_odnowienia (CO się dzieje), nie dla tego sygnału (KTO jest odpowiedzialny) — oceniaj oba niezależnie, ale gdy tekst łączy oba wątki, oba mogą wyjść true.$old4_0$
  ],
  $new4$GRANICA (interpretuj semantycznie): sygnał dotyczy OSOBY (lub zespołu) odpowiedzialnej za relację z klientem/kontem/segmentem w sposób choćby trochę bardziej trwały niż jednorazowa rozmowa sprzedażowa — nie wymagaj dosłownego słowa "opiekun"/"KAM", wystarczy wiarygodny opis pełniący tę samą funkcję. RÓWNOWAŻNE określenia — traktuj jako ten sam dowód: dedykowany opiekun, Key Account Manager (KAM), account manager, customer success, opieka handlowa B2B, opiekun biznesowy, opiekun regionalny/terytorialny, konsultant przypisany do klienta/branży. Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager", "account manager", "Customer Success", "stała opieka nad klientem", LUB osoba/rola opisana jako TRWALE odpowiedzialna za KONKRETNEGO klienta/konto/segment (np. "kontakt z konsultantem odpowiedzialnym za daną branżę"), nawet bez słowa "opiekun"/"KAM" wprost. NIE WYSTARCZA (poprawka 23.09, druga tura): samo przypisanie handlowca/przedstawiciela do REGIONU/terytorium — to pozyskiwanie sprzedaży na obszarze, nie trwała odpowiedzialność za już pozyskanego, konkretnego klienta; ani sama funkcja Kierownika/Dyrektora Sprzedaży — to zarządzanie zespołem, nie osobista, ciągła relacja z klientem. W obu przypadkach liczy się DOPIERO gdy tekst dodatkowo wskazuje na trwałą odpowiedzialność za konkretne konto/segment, nie tylko na ogólną funkcję/terytorium. Oferty pracy na role z głównego dowodu liczą się tak samo jak opis usługi na stronie. ZWRÓĆ FALSE: ogólne, niezróżnicowane Biuro Obsługi Klienta/infolinia BEZ ŻADNEJ wzmianki o przypisanej osobie/koncie/segmencie — jeśli jest choćby cień wzmianki o TRWAŁEJ odpowiedzialności za konkretnego klienta/konto/segment (nie samą funkcję/terytorium), przechyl się w stronę true. Sama opieka powdrożeniowa/serwis/odnowienia BEZ żadnej wzmianki o osobie odpowiedzialnej to przede wszystkim dowód dla cykliczna_obsluga_klienta_odnowienia (CO się dzieje), nie dla tego sygnału (KTO jest odpowiedzialny) — oceniaj oba niezależnie, ale gdy tekst łączy oba wątki, oba mogą wyjść true.$new4$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'przetargi',
  ARRAY[
    $old5_0$Firma SPRZEDAJE w przetargach jako wykonawca/dostawca — UWAGA, częsta pomyłka w obie strony (KIERUNEK jest tu logiczną sprzecznością, nie kwestią interpretacji — nie zmieniaj go mimo ogólnej zasady recall-first). Dowód pozytywny (true): jawny lub semantycznie równoważny opis REALNEGO udziału w postępowaniu przetargowym JAKO WYKONAWCA/OFERENT/ DOSTAWCA — "realizujemy zamówienia publiczne", "oferta dla sektora publicznego", "doświadczenie w przetargach", "specjalista ds. przetargów/ofertowania", "startujemy w przetargach", "oferty przetargowe", "wygraliśmy przetarg", a także mocne pośrednie wskazówki jak lista licznych zamawiających publicznych (gminy, urzędy, spółki Skarbu Państwa) opisana jako REALIZACJE/klienci firmy — przy większej liczbie takich referencji przechyl się w stronę true nawet bez dosłownego słowa "przetarg", bo taka skala zwykle oznacza pozyskiwanie kontraktów w trybie zamówień publicznych. Pojedynczy klient publiczny w portfolio bez innych wskazówek to wciąż za mało. NIE liczy się, nawet jeśli słowo "przetarg" występuje (to firma KUPUJĄCA, zwróć false): "postępowania zakupowe", "zamówienia dla dostawców", "przetargi organizowane przez nas", "profil nabywcy".$old5_0$
  ],
  $new5$Firma SPRZEDAJE w przetargach jako wykonawca/dostawca — UWAGA, częsta pomyłka w obie strony (KIERUNEK jest tu logiczną sprzecznością, nie kwestią interpretacji — nie zmieniaj go mimo ogólnej zasady recall-first). Dowód pozytywny (true): jawny lub semantycznie równoważny opis REALNEGO udziału w postępowaniu przetargowym JAKO WYKONAWCA/OFERENT/ DOSTAWCA — "realizujemy zamówienia publiczne", "oferta dla sektora publicznego", "doświadczenie w przetargach", "specjalista ds. przetargów/ofertowania", "startujemy w przetargach", "oferty przetargowe", "wygraliśmy przetarg" — nie wymagaj dosłownie słowa "przetarg", ale wymagaj choć POŚREDNIEJ wzmianki o trybie postępowania/zamówienia/konkursu ofert (np. "wygrany konkurs ofert", "zamówienie w trybie ustawy PZP", "postępowanie o udzielenie zamówienia"). NIE WYSTARCZA (poprawka 23.09, druga tura): samo duże/liczne portfolio klientów/ zamawiających publicznych (gminy, urzędy, spółki Skarbu Państwa) BEZ ŻADNEJ wzmianki o trybie pozyskania kontraktu — to nadal dowód na OBSŁUGĘ sektora publicznego, nie na SPOSÓB jego pozyskania, niezależnie od liczby takich klientów; firma mogła ich zdobyć bez żadnego przetargu. NIE liczy się, nawet jeśli słowo "przetarg" występuje (to firma KUPUJĄCA, zwróć false): "postępowania zakupowe", "zamówienia dla dostawców", "przetargi organizowane przez nas", "profil nabywcy".$new5$
);

INSERT INTO icp_recall_first_definitions (key, old_variants, new_definition) VALUES (
  'cykliczna_obsluga_klienta_odnowienia',
  ARRAY[
    $old6_0$Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i występują kolejne zaplanowane zdarzenia wymagające obsługi — interpretuj semantycznie, nie wymagaj dosłownych fraz z listy niżej.

TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole, gwarancję z obowiązkowymi przeglądami, wsparcie posprzedażowe opisane jako ciągłe/długoterminowe, albo inne wiarygodnie powtarzalne działania dotyczące tego samego klienta — także gdy wynika to tylko pośrednio z charakteru usługi (np. serwis urządzeń/instalacji zwykle wymaga okresowych przeglądów, nawet bez wprost opisanego harmonogramu).

Nie wystarcza sama możliwość ponownego zakupu, newsletter lub program lojalnościowy bez żadnego innego śladu ciągłej obsługi. Automatyczny abonament oraz ogólne hasło „serwis" TEŻ się liczą, jeśli towarzyszy im choćby minimalny opis powtarzalności — przy niepewności wybieraj true, o ile jest jakikolwiek konkretny punkt zaczepienia w tekście.$old6_0$
  ],
  $new6$Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i występują kolejne zaplanowane zdarzenia wymagające obsługi — interpretuj semantycznie, nie wymagaj dosłownych fraz z listy niżej.

TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole, gwarancję z obowiązkowymi przeglądami, wsparcie posprzedażowe opisane jako ciągłe/długoterminowe, albo inne wiarygodnie powtarzalne działania dotyczące tego samego klienta — także gdy wynika to tylko pośrednio z charakteru usługi (np. serwis urządzeń/instalacji zwykle wymaga okresowych przeglądów, nawet bez wprost opisanego harmonogramu).

Nie wystarcza sama możliwość ponownego zakupu, newsletter, program lojalnościowy ani samo ogólne hasło „serwis" BEZ żadnego wskazania powtarzalności (poprawka 23.09, druga tura). Automatyczny abonament oraz hasło „serwis" liczą się TYLKO gdy towarzyszy im choć jedno konkretne słowo/fraza wskazująca powtarzalność (np. "cykliczny", "regularny", "okresowy", "odnowienie", "umowa serwisowa", "przegląd co [okres]", "kolejne wizyty") — sam bierny opis "oferujemy serwis" bez takiego wskaźnika to za mało. Przy niepewności, gdy jakiś wskaźnik powtarzalności jest obecny (choćby słaby), wybieraj true.$new6$
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
  RAISE NOTICE 'ICP recall-first (druga tura): % wierszy tenant_icp_signals ma juz nowa definicje', updated_rows;
END
$report$;
