-- Migration: 0115_crm_agent_lead_sources
-- 1) Dane Agenta na Leadzie i Partnerze
-- 2) Słownik Źródeł Leadów w app_settings (value_type = 'string', parsowany jako JSON)
-- 3) UNIQUE constraints na tabelach powiązań dokumentów CRM

-- ── Pola Agenta na Leadzie ────────────────────────────────────────
ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS agent_name  TEXT,
  ADD COLUMN IF NOT EXISTS agent_email TEXT,
  ADD COLUMN IF NOT EXISTS agent_phone TEXT;

-- ── Pola Agenta na Partnerze ──────────────────────────────────────
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS agent_name  TEXT,
  ADD COLUMN IF NOT EXISTS agent_email TEXT,
  ADD COLUMN IF NOT EXISTS agent_phone TEXT;

-- ── UNIQUE constraints wymagane przez ON CONFLICT w INSERT ────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_lead_docs_unique'
  ) THEN
    ALTER TABLE crm_lead_documents
      ADD CONSTRAINT crm_lead_docs_unique UNIQUE (lead_id, document_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_partner_docs_unique'
  ) THEN
    ALTER TABLE crm_partner_documents
      ADD CONSTRAINT crm_partner_docs_unique UNIQUE (partner_id, document_id);
  END IF;
END $$;

-- ── Słownik Źródeł Leadów w App Settings ─────────────────────────
-- UWAGA: value_type = 'string' bo constraint CHECK nie zawiera 'json'
-- Backend parsuje wartość przez JSON.parse() niezależnie od value_type
INSERT INTO app_settings (key, value, label, description, value_type, category)
VALUES (
  'crm_lead_sources',
  '["strona_www","polecenie","cold_call","linkedin","targi","partner","agent","kampania","inbound","inne"]',
  'Slownik Zrodel Leadow',
  'Lista kluczy dostepnych w polu Zrodlo na Leadzie',
  'string',
  'crm'
) ON CONFLICT (key) DO NOTHING;
