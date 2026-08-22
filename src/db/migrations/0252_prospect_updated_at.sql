-- Migration 0252: add updated_at to prospect_companies
-- Needed for status change tracking (hold, archived, re-process)

ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE prospect_companies SET updated_at = imported_at WHERE updated_at IS NULL;

ALTER TABLE prospect_companies
  ALTER COLUMN updated_at SET DEFAULT NOW();
