-- Migration: 0109_crm_partner_activities_opportunity
-- Dodaje pola szansy sprzedaży do tabeli aktywności partnerów

ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS opp_value    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS opp_currency VARCHAR(10) DEFAULT 'PLN',
  ADD COLUMN IF NOT EXISTS opp_status   VARCHAR(20)
    CHECK (opp_status IS NULL OR opp_status IN ('new','in_progress','closed')),
  ADD COLUMN IF NOT EXISTS opp_due_date DATE;
