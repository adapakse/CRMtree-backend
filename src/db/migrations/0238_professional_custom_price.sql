-- 0238_professional_custom_price.sql
-- Billing module (M2): per-tenant custom quote for the Professional plan.
--
-- Professional stays excluded from per-user pricing (billing_plans.professional
-- keeps price_monthly_eur/price_annual_eur NULL, is_custom_pricing true) — the
-- quoted amount is per-TENANT, not per-plan-catalog, so it can't live on
-- billing_plans. It lives on tenant_subscriptions (current value) and on
-- tenant_subscription_history (so billing-run can resolve the amount that
-- was in effect for an already-closed period, same as plan_id/billing_cycle).

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS custom_price_eur NUMERIC(10,2)
    CHECK (custom_price_eur IS NULL OR custom_price_eur > 0);

ALTER TABLE tenant_subscription_history
  ADD COLUMN IF NOT EXISTS custom_price_eur NUMERIC(10,2)
    CHECK (custom_price_eur IS NULL OR custom_price_eur > 0);

COMMENT ON COLUMN tenant_subscriptions.custom_price_eur IS
  'Flat per-tenant quote for custom-pricing plans (Professional) — billed as-is per period, NOT multiplied by active_user_count. NULL for Lite/Standard.';
COMMENT ON COLUMN tenant_subscription_history.custom_price_eur IS
  'Snapshot of tenant_subscriptions.custom_price_eur at the time this history row was opened — lets billing-run price an already-closed period correctly even if the quote changes later.';
