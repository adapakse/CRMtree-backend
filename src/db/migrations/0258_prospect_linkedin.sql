ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS linkedin_url            VARCHAR(500),
  ADD COLUMN IF NOT EXISTS decision_maker_linkedin  VARCHAR(500),
  ADD COLUMN IF NOT EXISTS decision_maker_facebook  VARCHAR(500);
