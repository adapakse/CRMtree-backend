-- 0234_tenant_subscriptions.sql
-- Billing module (M1): one active subscription per tenant.
-- No plan-change history table — not requested; superadmin overwrites the
-- current row, `updated_at`/`updated_by` is enough for now.

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  tenant_id     UUID               PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id       UUID               NOT NULL REFERENCES billing_plans(id),
  billing_cycle billing_cycle_type NOT NULL DEFAULT 'monthly',
  started_at    DATE               NOT NULL DEFAULT CURRENT_DATE,
  updated_at    TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_by    UUID               REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE tenant_subscriptions IS 'Current billing plan + cycle assigned to a tenant by a super admin.';
COMMENT ON COLUMN tenant_subscriptions.started_at IS 'Anchors the annual billing anniversary date for this tenant.';
