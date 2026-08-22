-- Facebook Graph API data dla prospect_companies
ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS facebook_url  VARCHAR(500),
  ADD COLUMN IF NOT EXISTS fb_about      TEXT,
  ADD COLUMN IF NOT EXISTS fb_category   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS fb_fan_count  INTEGER;
