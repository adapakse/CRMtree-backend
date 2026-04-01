-- Migration: 0117_lead_logo_and_website
-- 1) Pole website (domena) na crm_leads
-- 2) Pole logo_url (sciezka blob) na crm_leads i crm_partners

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS website   TEXT,
  ADD COLUMN IF NOT EXISTS logo_url  TEXT;

ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS logo_url  TEXT;
