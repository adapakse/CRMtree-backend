-- GUS REGON enrichment fields on prospect_companies
-- Pominięte w Fazie 1 — plik źródłowy 0239_gus_fields.sql w worktrips-doc nie
-- pasował do wzorca nazw plików prospektowych użytego przy pierwszym przeglądzie.
ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS gus_regon    VARCHAR(14),
  ADD COLUMN IF NOT EXISTS gus_pkd_main VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_prospect_companies_gus_regon
  ON prospect_companies (gus_regon);
