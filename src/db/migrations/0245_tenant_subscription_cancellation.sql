-- 0245_tenant_subscription_cancellation.sql
-- Billing module: own, unambiguous "subscription ended" state.
--
-- Deliberately NOT tenants.is_active — that flag is toggled by superadmins
-- for reasons unrelated to billing (e.g. suspension) and must not silently
-- stop invoice generation. cancelled_at is set only through the dedicated
-- PUT/DELETE .../subscription/cancel endpoints (admin-tenants.js).

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

COMMENT ON COLUMN tenant_subscriptions.cancelled_at IS
  'When set, the calendar period (month/year) this falls into is still billed in full (no proration, per the 2026-08 Lite/Standard rule), but billing-run generates nothing after it. NULL = active subscription. Cleared (reactivation) whenever a plan is (re)assigned via PUT /:id/subscription.';
