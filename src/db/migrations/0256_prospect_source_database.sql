-- Baza źródłowa z importu CSV (wymagane pole — kolumna "BAZA" w pliku importu)
ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS source_database VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_prospect_source_db ON prospect_companies(source_database);
