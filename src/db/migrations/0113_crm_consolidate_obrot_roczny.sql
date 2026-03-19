-- Migration: 0113_crm_consolidate_obrót_roczny
-- Konsoliduje pola finansowe partnerów:
-- "Obrót roczny" = contract_value + annual_turnover_currency
-- Usuwa zbędne pole annual_turnover

-- 1. Przenieś dane z annual_turnover do contract_value jeśli contract_value jest puste
UPDATE crm_partners
SET contract_value = annual_turnover
WHERE contract_value IS NULL
  AND annual_turnover IS NOT NULL;

-- 2. Usuń kolumnę annual_turnover
ALTER TABLE crm_partners
  DROP COLUMN IF EXISTS annual_turnover;

-- 3. Upewnij się że annual_turnover_currency istnieje (waluta dla contract_value)
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS annual_turnover_currency TEXT NOT NULL DEFAULT 'PLN';

-- 4. Analogicznie dla leadów — usuń annual_turnover (obrót roczny = value_pln + annual_turnover_currency)
ALTER TABLE crm_leads
  DROP COLUMN IF EXISTS annual_turnover;

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS annual_turnover_currency TEXT NOT NULL DEFAULT 'PLN';
