-- Migration 0251: add key_contacts JSONB to prospect_companies
-- Format: [{name, title, email, phone}]

ALTER TABLE prospect_companies
  ADD COLUMN IF NOT EXISTS key_contacts JSONB;
