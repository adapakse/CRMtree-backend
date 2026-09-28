-- 0298_prospect_discovery.sql
-- "Znajdź konkurencję" — port mechanizmu z worktrips-doc.
--
-- Zasady działania (limity, cache, stronicowanie) są takie same jak w
-- worktrips-doc i siedzą w kodzie serwisu, nie w bazie — stąd ta migracja
-- robi tylko jedno.
--
-- website_source ma CHECK ograniczający do znanych źródeł. Dokładamy
-- 'ai_discovery', żeby dało się mierzyć jakość adresów pochodzących z AI
-- osobno od importu CSV i od resolvera (audyt 24.09: 51% błędnych domen
-- pochodziło z csv_import — bez osobnej wartości nie odróżnimy, czy AI
-- jest lepsze czy gorsze).

ALTER TABLE prospect_companies DROP CONSTRAINT IF EXISTS prospect_companies_website_source_check;
ALTER TABLE prospect_companies ADD CONSTRAINT prospect_companies_website_source_check
  CHECK (website_source IN ('csv_import', 'manual_correction', 'resolver', 'legacy_unknown', 'ai_discovery'));
