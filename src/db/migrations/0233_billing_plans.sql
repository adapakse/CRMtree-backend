-- 0233_billing_plans.sql
-- Billing module (M1): subscription plans catalog.
-- Pricing confirmed 2026-08-05 (Adam): Lite/Standard per active user/month or year,
-- Professional is custom-quoted and excluded from automatic invoicing for now.

DO $$ BEGIN
  CREATE TYPE billing_cycle_type AS ENUM ('monthly', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS billing_plans (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code               VARCHAR(32)  NOT NULL UNIQUE,   -- 'lite' | 'standard' | 'professional'
  name               VARCHAR(100) NOT NULL,
  price_monthly_eur  NUMERIC(10,2),                  -- NULL = no automatic pricing (custom quote)
  price_annual_eur   NUMERIC(10,2),
  is_custom_pricing  BOOLEAN      NOT NULL DEFAULT false,
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_plans IS 'Subscription plan catalog for tenant billing. Prices are EUR per active user.';
COMMENT ON COLUMN billing_plans.is_custom_pricing IS 'true = Professional: excluded from the automatic billing batch, invoiced manually.';

INSERT INTO billing_plans (code, name, price_monthly_eur, price_annual_eur, is_custom_pricing)
VALUES
  ('lite',         'Lite',         28.00, 228.00, false),
  ('standard',     'Standard',     36.00, 336.00, false),
  ('professional', 'Professional', NULL,  NULL,   true)
ON CONFLICT (code) DO NOTHING;
