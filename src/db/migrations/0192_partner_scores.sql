-- Migration 0192: Partner scores table (churn + health)
-- Przechowuje przeliczone wskaźniki per partner, per tenant.
-- Wypełniany przez POST /api/crm/churn/compute.

CREATE TABLE IF NOT EXISTS crm_partner_scores (
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  partner_id       UUID NOT NULL REFERENCES crm_partners(id) ON DELETE CASCADE,

  -- Churn
  churn_score      SMALLINT     NOT NULL DEFAULT 0,
  churn_level      TEXT         NOT NULL DEFAULT 'none',
  days_since_order SMALLINT,
  sales_m1         NUMERIC(14,2),
  sales_m2         NUMERIC(14,2),
  sales_drop_pct   NUMERIC(6,1),

  -- Health
  activity_score   SMALLINT     NOT NULL DEFAULT 0,
  growth_score     SMALLINT     NOT NULL DEFAULT 0,
  health_score     SMALLINT     NOT NULL DEFAULT 0,
  health_level     TEXT         NOT NULL DEFAULT 'risk',

  computed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (tenant_id, partner_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_partner_scores_tenant
  ON crm_partner_scores (tenant_id);
