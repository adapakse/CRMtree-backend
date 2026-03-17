-- Migration: 0104_crm_partner_number
-- Dodaje numer_partnera jako klucz łączący crm_partners z systemem transakcyjnym

-- 1. Dodaj kolumnę do tabeli partnerów
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS partner_number TEXT UNIQUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_partners_partner_number
  ON crm_partners (partner_number)
  WHERE partner_number IS NOT NULL;

-- 2. Dodaj kolumnę do tabeli transakcji sprzedażowych
ALTER TABLE crm_sales_transactions
  ADD COLUMN IF NOT EXISTS partner_number TEXT;

CREATE INDEX IF NOT EXISTS idx_cst_partner_number
  ON crm_sales_transactions (partner_number);

-- 3. Zmień klucz unikalny transakcji: dodaj partner_number do constraint
--    (period, partner_number, product_type) gdy partner_number jest uzupełniony
--    Stary constraint (period, partner_name, product_type) pozostaje jako fallback
