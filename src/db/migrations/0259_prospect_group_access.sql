ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS imported_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS group_id    UUID REFERENCES group_profiles(id);
