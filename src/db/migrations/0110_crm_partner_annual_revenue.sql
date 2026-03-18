-- Migration: 0110_crm_partner_annual_revenue
-- Dodaje pole Przychód roczny do tabeli partnerów
-- arr = Obrót roczny (GTV) — łączna wartość transakcji
-- annual_revenue = Przychód roczny — fees + marże które zostają u nas

ALTER TABLE crm_partners
  ADD COLUMN IF NOT EXISTS annual_revenue NUMERIC(14,2);
