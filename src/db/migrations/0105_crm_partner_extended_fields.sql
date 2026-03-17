-- Migration: 0105_crm_partner_extended_fields
-- Dodaje pola:
--   1. Kontakt do spraw rozliczeń (wymagane)
--   2. Kontakt do spraw umowy — pola już istnieją (contact_name/title/email/phone)
--      wymagalność egzekwowana na poziomie aplikacji
--   3. Limit kredytowy (kwota + waluta)
--   4. Kwota depozytu (kwota + waluta + data wpłaty + data zwrotu)
--   5. Prowizja WT/TM (wartość + podstawa)

ALTER TABLE crm_partners
  -- Kontakt do spraw rozliczeń
  ADD COLUMN IF NOT EXISTS billing_contact_name  TEXT,
  ADD COLUMN IF NOT EXISTS billing_contact_title TEXT,
  ADD COLUMN IF NOT EXISTS billing_email         TEXT,
  ADD COLUMN IF NOT EXISTS billing_phone         TEXT,

  -- Limit kredytowy
  ADD COLUMN IF NOT EXISTS credit_limit_value    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS credit_limit_currency TEXT NOT NULL DEFAULT 'PLN',

  -- Kwota depozytu
  ADD COLUMN IF NOT EXISTS deposit_value         NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS deposit_currency      TEXT NOT NULL DEFAULT 'PLN',
  ADD COLUMN IF NOT EXISTS deposit_date_in       DATE,
  ADD COLUMN IF NOT EXISTS deposit_date_out      DATE,

  -- Prowizja WT/TM
  ADD COLUMN IF NOT EXISTS commission_value      NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS commission_basis      TEXT NOT NULL DEFAULT 'nie_dotyczy';
  -- commission_basis: segmenty | rezerwacje | progi_obrotowe | nie_dotyczy
