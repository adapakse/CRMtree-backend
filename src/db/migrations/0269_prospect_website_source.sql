-- 0269_prospect_website_source.sql
-- Rozdziela pochodzenie website_url (dotąd zlewane w website_method='manual'
-- na każdym re-enrichmencie) na 4 trwałe kategorie — patrz decyzja 20.08
-- (root-cause: KZN/Wagner-service/Dach Centrum-unex traciły potwierdzony URL
-- na kolejnych re-enrichmentach, bo nic nie odróżniało "URL z importu CSV"
-- od "URL już potwierdzony w poprzednim przebiegu").

ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS website_source VARCHAR(20)
    CHECK (website_source IN ('csv_import', 'manual_correction', 'resolver', 'legacy_unknown'));

COMMENT ON COLUMN prospect_companies.website_source IS
  'Trwałe pochodzenie website_url — NIGDY nie nadpisywane przy ponownym enrichmencie,
   tylko przy faktycznej nowej rezolucji/korekcie. csv_import = z importu, manual_correction
   = ręczna korekta admina (ufana bez weryfikacji tożsamości), resolver = automatyczne
   wyszukiwanie (heuristic/google_cse/bing/duckduckgo/serper — szczegół w website_method),
   legacy_unknown = dane sprzed tej kolumny, nie da się wiarygodnie odróżnić importu od
   zapamiętanego wyniku resolvera z przeszłości.';

-- Backfill best-effort z enrichment_log->website->method (nie ma osobnej kolumny
-- website_method — metoda żyła dotąd tylko w JSON logu) — patrz komentarz kolumny,
-- nie da się w 100% odróżnić prawdziwego CSV importu od dawnego 'manual'.
UPDATE prospect_companies
SET website_source = CASE
  WHEN enrichment_log #>> '{website,method}' IN ('heuristic', 'google_cse', 'bing', 'duckduckgo', 'serper', 'krs') THEN 'resolver'
  WHEN website_url IS NOT NULL THEN 'legacy_unknown'
  ELSE NULL
END
WHERE website_source IS NULL;
