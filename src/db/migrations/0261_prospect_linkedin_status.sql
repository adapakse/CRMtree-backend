ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS linkedin_status VARCHAR(20);
