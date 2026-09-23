-- Migration 0293: ICP signal ai_definition — CZWARTA TURA, wyłącznie
-- opieka_nad_klientem (decyzja biznesowa 2026-09-23).
--
-- Benchmark 100 firm po trzeciej turze (0292) pokazał, że ten jeden sygnał ma
-- najwyższy odsetek miękkich TRUE ze wszystkich siedmiu (~38%, 5 z 13):
--   * Pharma Nord      — "Przedstawiciel handlowy przypisany do regionu"
--   * Top Promotion    — "Dedykowany partner biznesowy, stała współpraca"
--   * Lacroix          — "trusted partner, tailored support"
--   * Polski Transport — "Opieka dyspozytorów nad pojazdem" (rola operacyjna)
--   * Nuuxe Radioton   — "Osoba odpowiedzialna za testowanie" (rola techniczna)
--
-- ŹRÓDŁO BŁĘDU: lista RÓWNOWAŻNYCH określeń zawierała "opiekun regionalny/
-- terytorialny", co było wprost sprzeczne z wykluczeniem przypisania do
-- regionu dodanym w drugiej turze — model miał w jednym bloku dwie sprzeczne
-- instrukcje na ten sam wzorzec. Sprzeczność usunięta.
--
-- ZAKRES: ta migracja dotyka WYŁĄCZNIE opieka_nad_klientem. Pozostałe 6
-- sygnałów, wagi, próg 45, scoring, blacklista oraz globalna zasada
-- recall-first (PROMPT_STATIC_HEADER) zostają jawnie NIETKNIĘTE.
--
-- NIE ZMIENIA: points, active, sort_order, label, short_description, tier,
-- requires_any_of, threshold, liczby sygnałów, żadnej logiki scoringu —
-- WYŁĄCZNIE ai_definition (treść instrukcji dla AI) tego jednego klucza.
--
-- BEZPIECZEŃSTWO (ten sam wzorzec co 0289-0292): UPDATE dotyka WYŁĄCZNIE
-- wierszy, których ai_definition dokładnie odpowiada znanemu, aktualnemu
-- (trzecia tura) tekstowi — TARGETED. Tenant z własną, ręcznie zmienioną
-- ai_definition dla opieka_nad_klientem zostaje NIETKNIĘTY.

DROP TABLE IF EXISTS pg_temp.icp_opieka_definitions;

CREATE TEMP TABLE icp_opieka_definitions (
  key            VARCHAR(64) PRIMARY KEY,
  old_variants   TEXT[] NOT NULL,
  new_definition TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO icp_opieka_definitions (key, old_variants, new_definition) VALUES (
  'opieka_nad_klientem',
  ARRAY[
    $old1_0$GRANICA (interpretuj semantycznie): sygnał dotyczy OSOBY (lub zespołu) odpowiedzialnej za relację z klientem/kontem/segmentem w sposób choćby trochę bardziej trwały niż jednorazowa rozmowa sprzedażowa — nie wymagaj dosłownego słowa "opiekun"/"KAM", wystarczy wiarygodny opis pełniący tę samą funkcję. RÓWNOWAŻNE określenia — traktuj jako ten sam dowód: dedykowany opiekun, Key Account Manager (KAM), account manager, customer success, opieka handlowa B2B, opiekun biznesowy, opiekun regionalny/terytorialny, konsultant przypisany do klienta/branży. Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager", "account manager", "Customer Success", "stała opieka nad klientem", LUB osoba/rola opisana jako TRWALE odpowiedzialna za KONKRETNEGO klienta/konto/segment (np. "kontakt z konsultantem odpowiedzialnym za daną branżę"), nawet bez słowa "opiekun"/"KAM" wprost. NIE WYSTARCZA (poprawka 23.09, druga tura): samo przypisanie handlowca/przedstawiciela do REGIONU/terytorium — to pozyskiwanie sprzedaży na obszarze, nie trwała odpowiedzialność za już pozyskanego, konkretnego klienta; ani sama funkcja Kierownika/Dyrektora Sprzedaży — to zarządzanie zespołem, nie osobista, ciągła relacja z klientem. W obu przypadkach liczy się DOPIERO gdy tekst dodatkowo wskazuje na trwałą odpowiedzialność za konkretne konto/segment, nie tylko na ogólną funkcję/terytorium. Oferty pracy na role z głównego dowodu liczą się tak samo jak opis usługi na stronie. ZWRÓĆ FALSE: ogólne, niezróżnicowane Biuro Obsługi Klienta/infolinia BEZ ŻADNEJ wzmianki o przypisanej osobie/koncie/segmencie — jeśli jest choćby cień wzmianki o TRWAŁEJ odpowiedzialności za konkretnego klienta/konto/segment (nie samą funkcję/terytorium), przechyl się w stronę true. Sama opieka powdrożeniowa/serwis/odnowienia BEZ żadnej wzmianki o osobie odpowiedzialnej to przede wszystkim dowód dla cykliczna_obsluga_klienta_odnowienia (CO się dzieje), nie dla tego sygnału (KTO jest odpowiedzialny) — oceniaj oba niezależnie, ale gdy tekst łączy oba wątki, oba mogą wyjść true.$old1_0$
  ],
  $new1$TRUE oznacza REALNĄ, TRWAŁĄ odpowiedzialność za KONKRETNEGO klienta/konto/relację — nie dowolną formę kontaktu z klientem (poprawka 23.09, czwarta tura). Interpretuj semantycznie: nie wymagaj dosłownego słowa "opiekun"/"KAM", wystarczy wiarygodny opis pełniący tę samą funkcję — ale musi z niego wynikać, że ktoś POZOSTAJE odpowiedzialny za danego klienta, a nie tylko z nim rozmawia, sprzedaje mu albo obsługuje jego zlecenie. Główny dowód (dowolne z poniższych, także bez słowa "opiekun"): "dedykowany opiekun", "opiekun biznesowy", "opiekun klienta", Key Account Manager (KAM), account manager, "Specjalista ds. Kluczowych Klientów", Customer Success, "stała opieka nad klientem", opieka handlowa B2B; osoba prowadząca konto klienta; dedykowany/stały kontakt przypisany do konkretnego klienta; specjalista/konsultant PRZYPISANY do konkretnego klienta lub jego branży (np. "kontakt z konsultantem odpowiedzialnym za daną branżę"). NIE WYSTARCZA SAMODZIELNIE (poprawka 23.09, czwarta tura — każdy z tych przypadków realnie wystąpił w benchmarku jako fałszywe TRUE): przypisanie przedstawiciela/handlowca TYLKO do REGIONU/terytorium/województwa — to podział rynku dla pozyskiwania sprzedaży, nie trwała odpowiedzialność za już pozyskanego klienta (dotyczy to także osoby nazwanej "opiekunem regionalnym"/"terytorialnym" — liczy się dopiero, gdy z tekstu OSOBNO wynika opieka nad KLIENTEM, nie nad obszarem); ogólne hasło "stała współpraca"/"wieloletnia współpraca" bez wskazania osoby lub roli odpowiedzialnej za klienta; "partner biznesowy"/"dedykowany partner"/"trusted partner" bez informacji, kto i w jakiej formie opiekuje się konkretnym klientem; rola OPERACYJNA (dyspozytor, koordynator transportu, planista, obsługa zleceń) — to prowadzenie procesu/zlecenia, nie relacji z klientem; rola TECHNICZNA (serwisant, wdrożeniowiec, tester, inżynier wsparcia) — to obsługa produktu, nie konta klienta; zwykły handlowiec/sprzedawca BEZ żadnej przesłanki, że pozostaje odpowiedzialny za klienta PO pozyskaniu; sama funkcja Kierownika/Dyrektora Sprzedaży — to zarządzanie zespołem. Każdy z powyższych liczy się DOPIERO wtedy, gdy tekst DODATKOWO wskazuje na ciągłą odpowiedzialność za konkretnego klienta/konto. Oferty pracy na role z głównego dowodu liczą się tak samo jak opis usługi na stronie. ZWRÓĆ FALSE: ogólne, niezróżnicowane Biuro Obsługi Klienta/infolinia BEZ wzmianki o przypisanej osobie/koncie. Sama opieka powdrożeniowa/serwis/odnowienia BEZ żadnej wzmianki o osobie odpowiedzialnej to przede wszystkim dowód dla cykliczna_obsluga_klienta_odnowienia (CO się dzieje), nie dla tego sygnału (KTO jest odpowiedzialny) — oceniaj oba niezależnie, ale gdy tekst łączy oba wątki, oba mogą wyjść true.$new1$
);

-- ── Zastosuj: tylko wiersze, których ai_definition jest DOKŁADNIE jednym
-- ze znanych, aktualnych wariantów (druga tura) ────────────────────────────
UPDATE tenant_icp_signals s
   SET ai_definition = d.new_definition,
       updated_at    = now()
  FROM icp_opieka_definitions d
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
    JOIN icp_opieka_definitions d ON d.key = s.key
   WHERE s.ai_definition = d.new_definition;
  RAISE NOTICE 'ICP trzecia tura (dzial_handlowy/konsultacja_demo): % wierszy ma juz nowa definicje', updated_rows;
END
$report$;
