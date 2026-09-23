-- Migration 0289: ICP signal labels — jednorazowe, świadome ujednolicenie
-- WSZYSTKICH tenantów do krótkich nazw jako nowy standardowy default (decyzja
-- produktowa 23.09, po incydencie z 0288 — patrz jej nagłówek/historia).
--
-- Od TEJ migracji label jest zwykłym ustawieniem per tenant, dokładnie jak
-- points/active. To jest OSTATNI raz, kiedy jakikolwiek proces techniczny
-- (migracja, seed, restart, DEFAULT_SIGNALS) nadpisuje label tenanta wbrew
-- temu, co ma zapisane — nawet jeśli to, co ma zapisane, jest właśnie
-- niedawnym efektem 0288. Po tej migracji: Tenant A zmienia sobie label →
-- Tenant B go nie widzi i nie traci własnego; żaden kolejny deploy nie cofa
-- A z powrotem do defaultu.
--
-- CELOWO nie ograniczamy się do "pristine"/eligible tenantów jak 0288 —
-- to jest świadomy, jednorazowy reset nazewnictwa całej bazy, nie techniczne
-- domykanie 70→100. Nadpisujemy zarówno stare pełne nazwy z kodu, jak i
-- wcześniejsze ręczne skróty (np. te, które 0288 przypadkiem nadpisało u
-- gold/nordic-solutions) — wszyscy dostają JEDEN, ten sam punkt startowy.
--
-- NIE ZMIENIA: points, active, sort_order, ai_definition, short_description,
-- tier, requires_any_of, threshold (prospect_lead_min_score w app_settings —
-- ta migracja go nie czyta poza odczytem do snapshotu), żadnej logiki
-- scoringu. Tenant z własnym, DODATKOWYM sygnałem (inny key niż te 9) ma go
-- nietkniętego — WHERE poniżej dotyczy wyłącznie tych 9 znanych kluczy.
-- NIE dotyka prospect_companies — to migracja nazewnictwa w UI, nie scoringu,
-- historyczne wyniki enrichmentu (icp_score, icp_signals, enrichment_log)
-- zostają dokładnie takie, jakie są.
-- NIE edytuje istniejących wierszy tenant_icp_config_versions (append-only,
-- jak zawsze) — publikuje nową wersję tylko tam, gdzie label faktycznie się
-- zmienił.

DROP TABLE IF EXISTS pg_temp.icp_short_labels;

CREATE TEMP TABLE icp_short_labels (
  key   VARCHAR(64) PRIMARY KEY,
  label VARCHAR(255) NOT NULL
) ON COMMIT DROP;

INSERT INTO icp_short_labels (key, label) VALUES
  ('dzial_handlowy',                       'Dział handlowy'),
  ('zlozony_proces_sprzedazy',             'Indywidualna wycena'),
  ('konsultacja_demo',                     'Konsultacja / demo'),
  ('opieka_nad_klientem',                  'Dedykowana opieka'),
  ('przetargi',                            'Przetargi'),
  ('rozproszona_struktura',                'Rozproszona struktura'),
  ('siec_partnerow',                       'Sieć partnerów'),
  ('ecommerce_b2b',                        'E-commerce B2B'),
  ('cykliczna_obsluga_klienta_odnowienia', 'Cykliczna obsługa');

-- ── KROK 1: ustaw label dla tych 9 kluczy u WSZYSTKICH tenantów ────────────
-- IS DISTINCT FROM => idempotentne: drugie uruchomienie dotyka 0 wierszy.
UPDATE tenant_icp_signals s
   SET label      = t.label,
       updated_at = now()
  FROM icp_short_labels t
 WHERE t.key = s.key
   AND s.label IS DISTINCT FROM t.label
   AND EXISTS (SELECT 1 FROM tenants tn WHERE tn.id = s.tenant_id AND tn.deleted_at IS NULL);

-- ── KROK 2: opublikuj nową wersję tam, gdzie label w LIVE różni się od tego,
-- co jest w ostatnim PUBLISHED snapshocie ─────────────────────────────────
-- Publikujemy WYŁĄCZNIE dla tenantów, których LIVE i ostatni PUBLISHED mają
-- już poprawną sumę 100 (ta sama zasada co w 0288/bumpRevisionAndMaybePublish
-- — migracja nazewnictwa nigdy nie publikuje configu w trakcie edycji/
-- niekompletnego). Odcisk porównuje CELOWO tylko (key, label) — to jedyne
-- pole, które ta migracja rusza, więc jest jedynym powodem do republikacji.
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
    jsonb_agg(jsonb_build_array(s.key, s.label) ORDER BY s.key) AS label_fingerprint
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
     AND l.label_fingerprint IS DISTINCT FROM (
           SELECT jsonb_agg(jsonb_build_array(e->>'key', e->>'label') ORDER BY e->>'key')
             FROM jsonb_array_elements(cv.snapshot) e
         )
),
ins_version AS (
  INSERT INTO tenant_icp_config_versions (tenant_id, version, qualification_threshold, max_score, snapshot)
  SELECT
    np.tenant_id,
    COALESCE((SELECT MAX(v.version) FROM tenant_icp_config_versions v WHERE v.tenant_id = np.tenant_id), 0) + 1,
    -- Jedyne źródło prawdy dla progu (patrz getTenantQualificationThreshold w
    -- tenantIcpConfigService.js) — app_settings.prospect_lead_min_score, NIE
    -- martwa kolumna tenant_icp_configs.qualification_threshold.
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
  updated_labels INT;
BEGIN
  SELECT COUNT(*) INTO updated_labels
    FROM tenant_icp_signals s
    JOIN icp_short_labels t ON t.key = s.key
   WHERE s.label = t.label;
  RAISE NOTICE 'ICP krotkie labelki: % wierszy tenant_icp_signals ma juz docelowa nazwe (po tym uruchomieniu)', updated_labels;
END
$report$;
