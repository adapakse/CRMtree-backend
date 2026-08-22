-- Kolumna przechowująca pełny log z procesu enrichmentu
-- Pozwala śledzić skąd pochodzi każde pole i dlaczego AI ustawiło dany sygnał
ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS enrichment_log JSONB;
