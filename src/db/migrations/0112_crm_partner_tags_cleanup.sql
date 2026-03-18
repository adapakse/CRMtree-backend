-- Migration: 0112_crm_partner_tags_cleanup
-- 1. Dodaje pole tags do crm_partners
-- 2. Usuwa pole annual_turnover z crm_leads (obrót to value_pln + annual_turnover_currency)
-- 3. Upewnia się że annual_turnover_currency i online_pct istnieją na obu tabelach

-- Tagi partnerów
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- Na leadach: annual_turnover było dodane wcześniej — usuwamy, bo value_pln pełni tę rolę
ALTER TABLE crm_leads
  DROP COLUMN IF EXISTS annual_turnover;

-- Upewnij się że currency i online_pct istnieją (mogą już być z 0111)
ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS annual_turnover_currency TEXT NOT NULL DEFAULT 'PLN',
  ADD COLUMN IF NOT EXISTS online_pct INTEGER CHECK (online_pct IS NULL OR (online_pct >= 0 AND online_pct <= 100));

ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS annual_turnover_currency TEXT NOT NULL DEFAULT 'PLN',
  ADD COLUMN IF NOT EXISTS online_pct INTEGER CHECK (online_pct IS NULL OR (online_pct >= 0 AND online_pct <= 100));
