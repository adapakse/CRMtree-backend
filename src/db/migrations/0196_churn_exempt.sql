-- 0196_churn_exempt.sql
-- Flaga wykluczenia partnera z modelu churn scoring.
ALTER TABLE crm_partners ADD COLUMN IF NOT EXISTS churn_exempt BOOLEAN NOT NULL DEFAULT FALSE;
