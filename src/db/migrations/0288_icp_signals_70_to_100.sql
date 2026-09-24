-- Migration 0288: ICP signals — stary model (suma aktywnych = 70) → aktualny
-- model (suma aktywnych = 100, decyzja 2026-09-22).
--
-- DLACZEGO MIGRACJA, A NIE SKRYPT: 0285 zaseedował KAŻDEMU istniejącemu
-- tenantowi 8 sygnałów sumujących się do 70, a kod wymaga dokładnie
-- ICP_REQUIRED_SIGNALS_MAX_SCORE = 100 (prospectEnrichmentService.js) —
-- enrichOne() rzuca dla każdego prospekta tenanta, którego PUBLISHED snapshot
-- ma max_score = 70. Dotąd naprawiał to ręcznie uruchamiany
-- src/scripts/migrateIcpSignalsTo100.js, więc INT/PROD po deployu zostawały
-- z martwym enrichmentem do czasu, aż ktoś pamiętał ten skrypt odpalić.
-- Ta migracja robi to samo przez `npm run migrate`.
--
-- ZAKRES — wyłącznie tenanci z PRISTINE configiem. Tenant jest "pristine",
-- gdy KAŻDY jego wiersz w tenant_icp_signals ma (key, points, active) zgodne
-- albo ze starym seedem 0285, albo z docelowym schematem poniżej. Czyli:
--   * czysty seed 0285 (8 sygnałów, suma 70)            → migrowany,
--   * config już zmigrowany (9 sygnałów, suma 100)      → no-op (idempotencja),
--   * stan mieszany po częściowej migracji              → dokończony,
--   * JAKAKOLWIEK własna zmiana punktów/active tenanta  → POMIJANY, nietknięty,
--   * własny, dodatkowy sygnał tenanta (custom key)     → POMIJANY, nietknięty,
--   * brak wierszy (czysty fallback DEFAULT_SIGNALS)    → POMIJANY (kod i tak
--     poda 9 domyślnych sygnałów; materializacja nastąpi przy 1. edycji).
-- Nigdy nie zgadujemy nowych wag za tenanta, który sam sobie config dostroił —
-- taki tenant wymaga ręcznej decyzji admina (RAISE NOTICE na końcu wypisze go
-- w logu deployu).
--
-- CO ZMIENIA w ISTNIEJĄCYM wierszu: wyłącznie points/active/sort_order — czyli
-- techniczne minimum wymagane do przejścia 70 → 100. Dodatkowo uzupełnia
-- short_description TYLKO tam, gdzie jest NULL (kolumna doszła w 0287 i nigdy
-- nie była backfillowana, więc tooltip w Prospektach byłby pusty) — istniejącej,
-- niepustej wartości NIE nadpisuje.
-- CZEGO NIE RUSZA w istniejącym wierszu: label, ai_definition oraz niepuste
-- short_description. To są treści biznesowe, a konfiguracja ICP jest PER TENANT
-- — migracja techniczna nie ma prawa cofać ręcznych zmian admina (realny
-- przypadek: gold/nordic-solutions mają celowo skrócone nazwy w UI).
-- Nowo DODAWANY wiersz (KROK 2) dostaje oczywiście pełny komplet z defaults.

-- Jawny schemat pg_temp: te DROP-y istnieją po to, żeby migrację dało się
-- wykonać dwa razy w JEDNEJ transakcji (test idempotencji) — nigdy nie mogą
-- dotknąć zwykłej tabeli o tej samej nazwie.
DROP TABLE IF EXISTS pg_temp.icp_target_signals;
DROP TABLE IF EXISTS pg_temp.icp_old_default_signals;
DROP TABLE IF EXISTS pg_temp.icp_eligible_tenants;

-- ── Docelowy schemat (1:1 z DEFAULT_SIGNALS w tenantIcpConfigService.js) ────
-- Suma aktywnych: 30+25+15+10+5+5+10 = 100.
CREATE TEMP TABLE icp_target_signals (
  key               VARCHAR(64) PRIMARY KEY,
  label             VARCHAR(255) NOT NULL,
  ai_definition     TEXT,
  short_description VARCHAR(500),
  points            INT     NOT NULL,
  tier              VARCHAR(32),
  active            BOOLEAN NOT NULL,
  sort_order        INT     NOT NULL
) ON COMMIT DROP;

-- label i short_description służą tu WYŁĄCZNIE do wstawiania nowych wierszy
-- (KROK 2) oraz do uzupełnienia short_description tam, gdzie jest NULL.
-- Istniejących nazw NIE wyrównujemy — tenanci mają celowo różne skróty
-- (np. gold/nordic-solutions "Indywidualna wycena" vs pełna nazwa z kodu), a
-- config ICP jest per tenant. ai_definition wypełnione TYLKO dla sygnału,
-- którego seed 0285 w ogóle nie zawierał (dodawanego niżej jako nowy wiersz)
-- — treści promptu AI istniejących wierszy NIE ruszamy.
INSERT INTO icp_target_signals (key, label, ai_definition, short_description, points, tier, active, sort_order) VALUES
  ('dzial_handlowy',                       'Dział handlowy',                                  NULL,
   'Jawnie nazwany dział/zespół sprzedaży albo kilka konkretnych osób pełniących role handlowe.',       30, 'wysoka',  true,  1),
  ('zlozony_proces_sprzedazy',             'Złożony proces sprzedaży / indywidualna wycena',  NULL,
   'Firma przygotowuje ofertę, wycenę lub warunki indywidualnie dla konkretnego klienta.',              25, 'wysoka',  true,  2),
  ('konsultacja_demo',                     'Konsultacja, demo lub analiza potrzeb',           NULL,
   'Przed zakupem występuje realny etap doradztwa, analizy potrzeb, doboru rozwiązania lub demo.',      15, 'wysoka',  true,  3),
  ('opieka_nad_klientem',                  'Dedykowana opieka nad klientem B2B',              NULL,
   'Konkretny opiekun/KAM/osoba lub zespół jest stale odpowiedzialny za klienta, konto albo segment.',  10, 'wysoka',  true,  4),
  ('przetargi',                            'Przetargi / dział ofertowania',                   NULL,
   'Firma występuje jako wykonawca/dostawca w przetargach, nie jako zamawiający.',                       5, 'wysoka',  true,  5),
  ('rozproszona_struktura',                'Rozproszona struktura sprzedaży / wiele oddziałów', NULL,
   'Firma ma własne, fizycznie rozproszone oddziały lub przedstawicieli terytorialnych.',                5, 'srednia', false, 6),
  ('siec_partnerow',                       'Sieć partnerów / dealerów',                       NULL,
   'Niezależni dealerzy/resellerzy/partnerzy sprzedają ofertę badanej firmy.',                           5, 'srednia', true,  7),
  ('ecommerce_b2b',                        'Sprzedaż e-commerce (B2B)',                       NULL,
   'Firma ma sklep/platformę zamówieniową B2B z realną obsługą zamówień online.',                        5, 'srednia', false, 8),
  (
    'cykliczna_obsluga_klienta_odnowienia',
    'Cykliczna obsługa klienta / odnowienia',
    $icp$Firma utrzymuje z klientem relację po pierwszej sprzedaży lub wykonaniu usługi i występują kolejne zaplanowane zdarzenia wymagające obsługi.

TRUE, gdy strona wskazuje np. regularne przeglądy, cykliczny serwis, stałą obsługę, kolejne wizyty, odnawianie lub przedłużanie umów/usług, okresowe kontrole albo inne powtarzalne działania dotyczące tego samego klienta.

Nie wystarcza sama możliwość ponownego zakupu, newsletter, program lojalnościowy, automatyczny abonament ani ogólne hasło „serwis". Musi istnieć realna, powtarzalna obsługa relacji z klientem.$icp$,
    'Po sprzedaży występują powtarzalne zdarzenia: przeglądy, serwis, odnowienia, kolejne wizyty itp.',
    10, NULL, true, 9
  );

-- ── Stary seed 0285 (suma aktywnych = 70) ──────────────────────────────────
CREATE TEMP TABLE icp_old_default_signals (
  key    VARCHAR(64) PRIMARY KEY,
  points INT     NOT NULL,
  active BOOLEAN NOT NULL
) ON COMMIT DROP;

INSERT INTO icp_old_default_signals (key, points, active) VALUES
  ('dzial_handlowy',           15, true),
  ('zlozony_proces_sprzedazy', 10, true),
  ('konsultacja_demo',         10, true),
  ('opieka_nad_klientem',      10, true),
  ('przetargi',                10, true),
  ('rozproszona_struktura',     5, true),
  ('siec_partnerow',            5, true),
  ('ecommerce_b2b',             5, true);

-- ── Kto kwalifikuje się do automatycznej migracji ──────────────────────────
-- Zbiór liczony RAZ, przed jakąkolwiek zmianą — dalsze kroki już go tylko
-- czytają, więc nie ma ryzyka, że tenant "wpadnie" do zbioru w trakcie.
CREATE TEMP TABLE icp_eligible_tenants ON COMMIT DROP AS
WITH signal_match AS (
  SELECT
    s.tenant_id,
    (
      EXISTS (SELECT 1 FROM icp_target_signals n
               WHERE n.key = s.key AND n.points = s.points AND n.active = s.active)
      OR
      EXISTS (SELECT 1 FROM icp_old_default_signals o
               WHERE o.key = s.key AND o.points = s.points AND o.active = s.active)
    ) AS is_pristine_row
  FROM tenant_icp_signals s
  JOIN tenants t ON t.id = s.tenant_id AND t.deleted_at IS NULL
)
SELECT tenant_id
  FROM signal_match
 GROUP BY tenant_id
HAVING bool_and(is_pristine_row);

-- ── KROK 1: wyrównaj punkty/aktywność/kolejność istniejących sygnałów ──────
-- label i ai_definition zostają NIETKNIĘTE (treść biznesowa per tenant).
-- short_description uzupełniane wyłącznie gdy jest NULL — COALESCE gwarantuje,
-- że istniejąca, ręcznie ustawiona wartość nigdy nie zostanie nadpisana.
UPDATE tenant_icp_signals s
   SET points            = n.points,
       active            = n.active,
       sort_order        = n.sort_order,
       short_description = COALESCE(s.short_description, n.short_description),
       updated_at        = now()
  FROM icp_target_signals n, icp_eligible_tenants e
 WHERE s.tenant_id = e.tenant_id
   AND n.key = s.key
   AND (s.points <> n.points
        OR s.active <> n.active
        OR s.sort_order <> n.sort_order
        OR (s.short_description IS NULL AND n.short_description IS NOT NULL));

-- ── KROK 2: dodaj sygnały docelowego schematu, których tenant nie ma ───────
-- Tylko te, dla których znamy pełną treść (ai_definition NOT NULL) — czyli
-- sygnały spoza seedu 0285. UNIQUE (tenant_id, key) + NOT EXISTS = brak
-- duplikatów przy ponownym uruchomieniu.
INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
SELECT e.tenant_id, n.key, n.label, n.ai_definition, n.short_description, n.points, n.tier, n.active, n.sort_order
  FROM icp_eligible_tenants e
  CROSS JOIN icp_target_signals n
 WHERE n.ai_definition IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM tenant_icp_signals s
      WHERE s.tenant_id = e.tenant_id AND s.key = n.key
   )
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ── KROK 3: opublikuj nową wersję configu ──────────────────────────────────
-- Tylko dla tenantów, których PUBLISHED snapshot nie jest jeszcze poprawny
-- (brak wersji albo max_score <> 100) — dzięki temu drugie uruchomienie
-- migracji nie tworzy kolejnej, identycznej wersji.
-- 100 jest tu zapisane wprost: to wartość ICP_REQUIRED_SIGNALS_MAX_SCORE w
-- momencie tej migracji i zarazem suma punktów aktywnych sygnałów wyżej.
WITH live AS (
  SELECT
    e.tenant_id,
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
    -- Odcisk stanu LIVE do porównania z opublikowanym snapshotem. Celowo BEZ
    -- label: migracja nazw nie zmienia, więc różnica w samej nazwie (tenant ma
    -- własną) nie może wymuszać nowej wersji PUBLISHED — inaczej tenant już
    -- poprawny (100 pkt), lecz z własnymi nazwami, dostawałby nową wersję przy
    -- każdym uruchomieniu i migracja nie byłaby prawdziwym no-opem.
    -- short_description zostaje w odcisku, bo KROK 1 może je uzupełnić z NULL.
    jsonb_agg(
      jsonb_build_array(s.key, s.short_description, s.points, s.active, s.sort_order)
      ORDER BY s.key
    ) AS fingerprint
  FROM icp_eligible_tenants e
  JOIN tenant_icp_signals s ON s.tenant_id = e.tenant_id
  GROUP BY e.tenant_id
),
needs_publish AS (
  SELECT l.*
    FROM live l
    LEFT JOIN tenant_icp_configs c ON c.tenant_id = l.tenant_id
    LEFT JOIN tenant_icp_config_versions cv ON cv.id = c.current_version_id
   WHERE l.max_score = 100
     AND (
       cv.id IS NULL
       OR cv.max_score <> 100
       OR l.fingerprint IS DISTINCT FROM (
            SELECT jsonb_agg(
                     jsonb_build_array(
                       e2->>'key', e2->>'short_description',
                       (e2->>'points')::int, (e2->>'active')::boolean, (e2->>'sort_order')::int
                     ) ORDER BY e2->>'key'
                   )
              FROM jsonb_array_elements(cv.snapshot) e2
          )
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
  migrated   INT;
  skipped    TEXT;
BEGIN
  SELECT COUNT(*) INTO migrated FROM icp_eligible_tenants;

  SELECT string_agg(t.name || ' (' || t.slug || ')', ', ' ORDER BY t.name) INTO skipped
    FROM tenants t
   WHERE t.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM tenant_icp_signals s WHERE s.tenant_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM icp_eligible_tenants e WHERE e.tenant_id = t.id);

  RAISE NOTICE 'ICP 70->100: tenantow z pristine configiem: %', migrated;
  IF skipped IS NOT NULL THEN
    RAISE NOTICE 'ICP 70->100: POMINIETO (wlasny config, wymaga recznej decyzji admina): %', skipped;
  END IF;
END
$report$;

-- ── Sprostowanie komentarza z 0285 ─────────────────────────────────────────
-- 0285 opisywał requires_any_of jako "egzekwowane w backendowym scoringu
-- (ETAP B)". Po decyzji 2026-09-22 calcIcpScore() już go NIE egzekwuje —
-- pole zostaje jako inertna relacja (nadal czyszczona przy deleteSignal).
-- Sam komentarz prostujemy tutaj, zamiast edytować zaaplikowaną migrację 0285.
COMMENT ON COLUMN tenant_icp_signals.requires_any_of IS
  'Opcjonalna zależność: lista id innych sygnałów TEGO SAMEGO tenanta. UWAGA (2026-09-22):
   pole NIE jest już egzekwowane w scoringu — calcIcpScore() nalicza punkty sygnału
   niezależnie od requires_any_of. Zostaje jako inertna relacja opisowa; backend
   (deleteSignal) nadal czyści referencje przy usuwaniu sygnału. Brak FK na elementy tablicy.';
