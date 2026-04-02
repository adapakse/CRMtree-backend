-- Migration: 0111_crm_annual_turnover_online_pct (fixed)
-- Upraszcza pola finansowe w leadach i partnerach:
--   annual_turnover          = Obrót roczny (zastępuje arr + annual_revenue)
--   annual_turnover_currency = Waluta obrotu rocznego
--   online_pct               = % obrotu w kanale online (0,10,20...100)

-- ── PARTNERZY ─────────────────────────────────────────────────────────────────

-- Przemianuj arr → annual_turnover (tylko jeśli kolumna arr istnieje)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'crm_partners' AND column_name = 'arr'
  ) THEN
    ALTER TABLE crm_partners RENAME COLUMN arr TO annual_turnover;
  END IF;
END $$;

-- Usuń pole annual_revenue (dodane chwilowo, bez danych produkcyjnych)
ALTER TABLE crm_partners
  DROP COLUMN IF EXISTS annual_revenue;

-- Dodaj annual_turnover jeśli nie istnieje (gdy arr też nie istniało)
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS annual_turnover NUMERIC(14,2);

-- Dodaj walutę i % online
ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS annual_turnover_currency TEXT NOT NULL DEFAULT 'PLN',
  ADD COLUMN IF NOT EXISTS online_pct               INTEGER CHECK (
    online_pct IS NULL OR (online_pct >= 0 AND online_pct <= 100 AND online_pct % 10 = 0)
  );

-- ── LEADY ─────────────────────────────────────────────────────────────────────

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS annual_turnover          NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS annual_turnover_currency TEXT NOT NULL DEFAULT 'PLN',
  ADD COLUMN IF NOT EXISTS online_pct               INTEGER CHECK (
    online_pct IS NULL OR (online_pct >= 0 AND online_pct <= 100 AND online_pct % 10 = 0)
  );
