-- 0237_tenant_subscription_history.sql
-- Billing module (M1 fix): track subscription plan/cycle changes over time
-- so billing-run can bill the plan+price that was in effect during a given
-- period instead of whatever tenant_subscriptions currently holds when the
-- batch happens to run.

CREATE TABLE IF NOT EXISTS tenant_subscription_history (
  id             UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID               NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id        UUID               NOT NULL REFERENCES billing_plans(id),
  billing_cycle  billing_cycle_type NOT NULL,
  effective_from TIMESTAMPTZ        NOT NULL DEFAULT now(),
  effective_to   TIMESTAMPTZ,
  changed_by     UUID               REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_subscription_history_tenant
  ON tenant_subscription_history(tenant_id, effective_from);

COMMENT ON TABLE tenant_subscription_history IS 'Append-only log of tenant_subscriptions changes. billing-run resolves the plan/cycle effective at each invoiced period from here instead of the current tenant_subscriptions row.';
COMMENT ON COLUMN tenant_subscription_history.effective_to IS 'NULL = still current. Closed by admin-tenants.js PUT /:id/subscription when superseded by a new row.';

-- Backfill one open-ended history row per existing subscription, anchored at
-- started_at, so tenants whose subscription predates this migration still
-- resolve a plan for any already-due-but-unbilled period.
INSERT INTO tenant_subscription_history (tenant_id, plan_id, billing_cycle, effective_from, changed_by)
SELECT ts.tenant_id, ts.plan_id, ts.billing_cycle, ts.started_at::timestamptz, ts.updated_by
FROM tenant_subscriptions ts
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_subscription_history h WHERE h.tenant_id = ts.tenant_id
);
