-- Migration 0292: ICP signal ai_definition — TRZECIA TURA recall-first
-- (decyzja biznesowa 2026-09-23). Benchmark na 100 firmach po drugiej turze
-- (0291) pokazał: 63% wyników miało dokładnie ten sam tercet dzial_handlowy +
-- zlozony_proces_sprzedazy + konsultacja_demo, a 81% przekraczało próg 45 —
-- za dużo jak na losowy import. Ręczny przegląd reasoning znalazł konkretne
-- miękkie miejsca: sam Dyrektor Handlowy w zarządzie (Energokessel), sekcja
-- "Dla biznesu" (Telbeskid), "obsługa zleceń" (Budrem), "przedstawimy ofertę"
-- jako dowód konsultacji (Tank Mark), jedno "biuro projektowe" zapalające
-- jednocześnie dwa sygnały (Izoserwis), ogólne "doradztwo techniczno-
-- handlowe" bez struktury (Posadzki Przemysłowe).
--
-- Ta migracja dotyka WYŁĄCZNIE dzial_handlowy i konsultacja_demo — reszta
-- (zlozony_proces_sprzedazy, opieka_nad_klientem, przetargi, siec_partnerow,
-- cykliczna_obsluga_klienta_odnowienia) zostaje jawnie NIETKNIĘTA, zgodnie z
-- poleceniem. Globalna filozofia recall-first (PROMPT_STATIC_HEADER) też
-- zostaje — dostała tylko nową, współdzieloną ZASADĘ NIEZALEŻNOŚCI DOWODU
-- (jeden fakt zapala kilka sygnałów tylko przy osobnym sensie biznesowym dla
-- każdego), która żyje wyłącznie w kodzie, nie w DB.
--
-- NIE ZMIENIA: points, active, sort_order, label, short_description, tier,
-- requires_any_of, threshold, liczby sygnałów, żadnej logiki scoringu —
-- WYŁĄCZNIE ai_definition (treść instrukcji dla AI) tych 2 kluczy.
--
-- BEZPIECZEŃSTWO (ten sam wzorzec co 0289/0290/0291): UPDATE dotyka
-- WYŁĄCZNIE wierszy, których ai_definition dokładnie odpowiada znanemu,
-- aktualnemu (druga tura, 0291) tekstowi — TARGETED. Tenant z własną, ręcznie
-- zmienioną ai_definition dla dzial_handlowy/konsultacja_demo zostaje
-- NIETKNIĘTY.

DROP TABLE IF EXISTS pg_temp.icp_sales_function_definitions;

CREATE TEMP TABLE icp_sales_function_definitions (
  key            VARCHAR(64) PRIMARY KEY,
  old_variants   TEXT[] NOT NULL,
  new_definition TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO icp_sales_function_definitions (key, old_variants, new_definition) VALUES (
  'dzial_handlowy',
  ARRAY[
    $old1_0$RÓWNOWAŻNE nazwy tej samej struktury — traktuj jako identyczny dowód, nie tylko dosłowne "dział handlowy": "dział handlowy", "dział sprzedaży", "sales team", "sales department", "zespół sprzedaży", "przedstawiciele handlowi", a także dowolny inny opis wskazujący, że ktoś w firmie zajmuje się pozyskiwaniem/obsługą sprzedaży — nie musi paść dosłowna nazwa. Główny dowód: jawnie nazwany dział/zespół sprzedażowy (nagłówek podstrony, sekcja "Nasz zespół sprzedaży", nazwa działu w strukturze firmy, pod dowolną z powyższych równoważnych nazw) — WYSTARCZA nawet przy JEDNEJ widocznej, nazwanej osobie pod tym nagłówkiem, bo dowodem jest nazwana struktura organizacyjna, nie liczba osób. LUB: co najmniej JEDNA nazwana osoba, dla której KONTEKST na stronie (tytuł stanowiska, opis roli, nagłówek sekcji) wskazuje, że realnie zajmuje się sprzedażą/ofertowaniem (przedstawiciel handlowy, sprzedawca, account manager, dyrektor/kierownik handlowy lub sprzedaży) — wystarcza sama, nawet bez nagłówka działu i bez innych wymienionych handlowców obok niej. NIE WYSTARCZA (poprawka 23.09, druga tura): sama wizytówka/dane kontaktowe osoby bez żadnego opisu jej roli — samo imię i nazwisko z telefonem/e-mailem w sekcji "Kontakt", bez tytułu ani opisu wskazującego na sprzedaż, to za mało; musi być choć minimalny kontekst, że ta osoba realnie prowadzi sprzedaż/ofertowanie. Drugorzędne wsparcie, WYSTARCZAJĄCE SAMODZIELNIE: aktywna oferta pracy na stanowisko handlowe, LUB dowolna wzmianka o "dziale sprzedaży"/"zespole handlowym" w opisie firmy lub ofercie, nawet bez dalszych szczegółów. Drugorzędne wsparcie, NIE WYSTARCZAJĄCE SAMODZIELNIE (poprawka 23.09, druga tura): sam dedykowany adres sprzedaz@/sales@ (lub odpowiednik) — to może być zwykła ogólna skrzynka; liczy się dopiero razem z jakąkolwiek inną, choćby słabą wzmianką o sprzedaży obok siebie. ZWRÓĆ FALSE tylko gdy strona nie zawiera ŻADNEJ wzmianki o osobie/dziale/procesie sprzedażowym — np. wyłącznie katalog produktów bez jakiegokolwiek śladu obsługi handlowej.$old1_0$
  ],
  $new1$TRUE oznacza REALNĄ funkcję sprzedażową — nie dowolny ślad biznesowy (poprawka 23.09, trzecia tura). Interpretuj semantycznie, nie wymagaj dosłownego zwrotu "dział handlowy": "dział sprzedaży", "sales team", "sales department", "zespół sprzedaży", "przedstawiciele handlowi" i ich funkcjonalne odpowiedniki liczą się tak samo. Główny dowód, dowolne z poniższych: (a) jawnie nazwany dział/zespół sprzedaży lub handlowy (nagłówek podstrony, sekcja, nazwa w strukturze firmy) — wystarcza nawet przy jednej widocznej osobie pod tym nagłówkiem, bo dowodem jest nazwana struktura, nie liczba osób; (b) co najmniej DWÓCH nazwanych handlowców/przedstawicieli/account managerów, nawet bez nagłówka działu; (c) POJEDYNCZA osoba sprzedażowa, JEŚLI kontekst (opis roli, zakres obowiązków, sposób przedstawienia — nie sam tytuł) pokazuje, że REALNIE prowadzi sprzedaż/ ofertowanie/pozyskiwanie klientów; (d) struktura funkcjonalnie pełniąca rolę sprzedaży mimo innej nazwy, jeśli jest OSOBNO opisana jako odpowiedzialna za pozyskiwanie/finalizowanie zamówień klientów (nie tylko nazwana podobnie z nazwy). NIE WYSTARCZA SAMODZIELNIE, nawet jeśli to jedyny dostępny ślad (poprawka 23.09, trzecia tura): sama osoba "Dyrektor Handlowy"/"Dyrektor ds. Handlowych" wymieniona np. w składzie zarządu, BEZ żadnego opisu, że realnie prowadzi sprzedaż — sam tytuł członka zarządu bez opisu roli to za mało, mogła objąć funkcję czysto nadzorczą; sekcja/strona "Dla firm"/"Dla biznesu" (to oferta kierowana do biznesu, nie dowód na istnienie działu sprzedaży); sam formularz kontaktowy lub formularz wyceny; sam adres sprzedaz@/sales@ (może być zwykłą ogólną skrzynką); ogólne "biuro"/"obsługa zleceń" (to może być administracja/logistyka, nie sprzedaż); samo Biuro Obsługi Klienta (BOK); samo biuro projektowe/dział B+R/dział techniczny (to zdolność projektowo-inżynierska, nie sprzedażowa); ogólne hasło "doradztwo techniczno- handlowe" BEZ wskazania konkretnych ludzi lub struktury odpowiedzialnej za sprzedaż. Powyższe wykluczenia mogą się WZAJEMNIE WSPIERAĆ tylko jeśli razem opisują TĘ SAMĄ, realną funkcję sprzedażową (np. "dział handlowy: sprzedaz@firma.pl" — dział już nazwany, adres to tylko dodatkowy kontakt do niego) — żadne z nich osobno nie zastępuje głównego dowodu, i nie sumuj kilku wykluczeń w nadzieję, że razem złożą się na dowód, jeśli żadne nie opisuje realnej sprzedaży. ZWRÓĆ FALSE, gdy jedyne dostępne ślady to wyłącznie pozycje z listy wykluczeń, bez żadnego głównego dowodu obok nich.$new1$
);

INSERT INTO icp_sales_function_definitions (key, old_variants, new_definition) VALUES (
  'konsultacja_demo',
  ARRAY[
    $old2_0$Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy z jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach). RÓWNOWAŻNE określenia tego samego etapu procesu — traktuj jako ten sam dowód: konsultacja, demo, dobór rozwiązania, analiza potrzeb, dobór techniczny, doradztwo przedsprzedażowe, projektowanie pod klienta/indywidualnego klienta, a także dowolny inny opis wskazujący, że przed zakupem ktoś z firmy rozmawia z klientem o jego potrzebach — nie wymagaj dosłownej frazy z listy niżej. Główny dowód (dosłowna fraza LUB semantyczny odpowiednik — oba liczą się tak samo): "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania"; przypisany doradca/opiekun/dyrektor regionalny opisany jako wspierający wybór rozwiązania, nawet bez słowa "konsultacja"; formularz zbierający parametry zamówienia (RFQ, zapytanie z polami technicznymi); sprzedaż oparta na indywidualnym projekcie technicznym/architektonicznym, gdzie analiza wymagań klienta jest choćby pośrednio wskazanym etapem procesu. GRANICA (poprawka 23.09, druga tura — wcześniejsze pełne złagodzenie cofało już wcześniej sprawdzoną poprawkę): produkcja/usługa "na wymiar", "pod klienta", "na życzenie klienta" NIE WYSTARCZA SAMA jako opis samej zdolności produkcyjnej — musi towarzyszyć jej choć przesłanka INTERAKCJI z klientem przed realizacją (np. "ustalamy z klientem", "po konsultacji", "na podstawie zgłoszonych wymagań", "dobieramy rozwiązanie", "analizujemy potrzeby klienta") — wtedy liczy się nawet bez opisanego wprost odrębnego „etapu rozmowy”. Sam fakt, że produkt "powstaje pod klienta", bez żadnej takiej przesłanki interakcji, to za mało. NIE LICZY SIĘ (to inny etap obsługi, nie sprzedażowy): doradca/opiekun ds. likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji, serwisant, doradca serwisowy wsparcia posprzedażowego — to obsługa PO zakupie, nie etap decyzji o zakupie; ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada niezwiązana z konkretną usługą/osobą w tej firmie). ZASTRZEŻENIE: nie ustawiaj true wyłącznie z samej nazwy branży bez żadnego punktu zaczepienia w tekście — ale gdy tekst opisuje choćby zarys procesu doboru/dopasowania rozwiązania do klienta, przy niepewności wybieraj true. Jeśli to ten sam fragment tekstu co dowód dla zlozony_proces_sprzedazy, oceń oba sygnały niezależnie — nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów, ale oba mogą wyjść true z tego samego opisu, jeśli faktycznie potwierdza oba zjawiska.$old2_0$
  ],
  $new2$TRUE wymaga choć JEDNEJ realnej interakcji przedsprzedażowej z klientem — rozmowy/analizy/ doboru PRZED złożeniem zamówienia, nie samej możliwości kontaktu (poprawka 23.09, trzecia tura). Interpretuj semantycznie: jeśli kontekst rzeczywiście opisuje interakcję i dopasowywanie rozwiązania do klienta, wybieraj TRUE nawet bez słowa "konsultacja" — ale sama możliwość kontaktu, bez opisu, że ktoś faktycznie analizuje/dobiera rozwiązanie, to za mało. Główny dowód (dosłowna fraza LUB semantyczny odpowiednik): analiza potrzeb klienta; dobór rozwiązania/produktu do wymagań klienta; konsultacja (płatna lub bezpłatna); doradztwo przy wyborze; wizja lokalna przed realizacją; demo/prezentacja produktu; wspólne projektowanie/ ustalanie rozwiązania z klientem; kontakt ze specjalistą/doradcą W CELU dobrania rozwiązania (nie ogólny kontakt handlowy); przypisany doradca/opiekun/dyrektor regionalny opisany jako wspierający wybór rozwiązania, nawet bez słowa "konsultacja"; formularz zbierający SZCZEGÓŁOWE parametry techniczne zamówienia (RFQ) — nie sam ogólny formularz kontaktowy. NIE WYSTARCZA SAMODZIELNIE, nawet jeśli to jedyny dostępny ślad (poprawka 23.09, trzecia tura): samo "skontaktuj się z nami"/"przedstawimy ofertę"/"zapytaj o ofertę" — to zaproszenie do kontaktu, nie dowód analizy/doboru; sam formularz kontaktowy lub ofertowy bez opisu, że ktoś po drugiej stronie faktycznie analizuje/dobiera rozwiązanie; samo istnienie biura projektowego (to zdolność projektowa, nie opisany etap rozmowy z klientem — chyba że tekst OSOBNO opisuje, że biuro projektowe prowadzi rozmowę/analizę z klientem przed realizacją, nie tylko projektuje); sam produkt "na wymiar"/"pod klienta" bez opisanej interakcji (patrz GRANICA niżej); ogólne marketingowe hasło "indywidualne podejście do klienta" bez opisu konkretnego etapu/osoby/procesu. GRANICA (produkcja na wymiar): produkcja/usługa "na wymiar", "pod klienta", "na życzenie klienta" NIE WYSTARCZA SAMA jako opis samej zdolności produkcyjnej — musi towarzyszyć jej choć przesłanka INTERAKCJI z klientem przed realizacją (np. "ustalamy z klientem", "po konsultacji", "na podstawie zgłoszonych wymagań", "dobieramy rozwiązanie", "analizujemy potrzeby klienta") — wtedy liczy się nawet bez opisanego wprost odrębnego „etapu rozmowy”. NIE LICZY SIĘ (to inny etap obsługi, nie sprzedażowy): doradca/opiekun ds. likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji, serwisant, doradca serwisowy wsparcia posprzedażowego — to obsługa PO zakupie, nie etap decyzji o zakupie; ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada niezwiązana z konkretną usługą/osobą w tej firmie). ZASTRZEŻENIE: nie ustawiaj true wyłącznie z samej nazwy branży bez żadnego punktu zaczepienia w tekście. Jeśli to ten sam fragment tekstu co dowód dla zlozony_proces_sprzedazy lub dzial_handlowy, oceń każdy sygnał NIEZALEŻNIE — licz go dla więcej niż jednego sygnału TYLKO jeśli fragment faktycznie opisuje osobne zjawiska biznesowe dla każdego z nich; sama ogólna wzmianka o biurze projektowym/obsłudze klienta/doradztwie nie może automatycznie zapalać kilku sygnałów naraz.$new2$
);

-- ── Zastosuj: tylko wiersze, których ai_definition jest DOKŁADNIE jednym
-- ze znanych, aktualnych wariantów (druga tura) ────────────────────────────
UPDATE tenant_icp_signals s
   SET ai_definition = d.new_definition,
       updated_at    = now()
  FROM icp_sales_function_definitions d
 WHERE s.key = d.key
   AND s.ai_definition = ANY(d.old_variants)
   AND EXISTS (SELECT 1 FROM tenants tn WHERE tn.id = s.tenant_id AND tn.deleted_at IS NULL);

-- ── Opublikuj nową wersję tam, gdzie ai_definition w LIVE różni się od
-- ostatniego PUBLISHED snapshotu ───────────────────────────────────────────
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
    JOIN icp_sales_function_definitions d ON d.key = s.key
   WHERE s.ai_definition = d.new_definition;
  RAISE NOTICE 'ICP trzecia tura (dzial_handlowy/konsultacja_demo): % wierszy ma juz nowa definicje', updated_rows;
END
$report$;
