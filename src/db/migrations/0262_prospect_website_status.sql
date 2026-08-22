ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS website_status VARCHAR(20);
