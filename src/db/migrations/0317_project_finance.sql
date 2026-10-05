-- 0317_project_finance.sql
-- Project finance, stage 1: cost categories, project budget, cost and revenue
-- items, plus a global table of NBP exchange rates.
--
-- This is project controlling, not accounting: net amounts only, no VAT, one
-- currency per project. The tenant switch lives in app_settings
-- (key 'projects_finance_enabled'; no row = off). Default cost categories are
-- seeded lazily by projectConfigService, not here.

-- ── NBP table A mid rates (global, not per tenant) ───────────────────────
CREATE TABLE IF NOT EXISTS nbp_exchange_rates (
  currency    CHAR(3)        NOT NULL,
  rate_date   DATE           NOT NULL,
  mid_rate    NUMERIC(18,8)  NOT NULL CHECK (mid_rate > 0),
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_nbp_exchange_rates_date ON nbp_exchange_rates(rate_date);

COMMENT ON TABLE nbp_exchange_rates IS
  'PLN price of one unit of a currency as published by NBP (table A, mid rate) on rate_date.
   There is no row for PLN and none for days without a table (weekends, holidays).';

-- ── Cost categories (tenant dictionary) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS project_cost_categories (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(80)  NOT NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- ── Per-project finance settings ─────────────────────────────────────────
-- Kept out of `projects` on purpose: that table is read with SELECT * by code
-- that answers every project member, including external participants.
CREATE TABLE IF NOT EXISTS project_finance (
  project_id                  UUID          PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id                   UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  currency                    CHAR(3)       NOT NULL DEFAULT 'PLN',
  planned_revenue             NUMERIC(14,2) CHECK (planned_revenue >= 0),
  participants_can_add_costs  BOOLEAN       NOT NULL DEFAULT FALSE,
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE project_finance IS
  'One optional row per project; a project without a row uses the defaults (PLN, no planned
   revenue, participants may not add costs).';
COMMENT ON COLUMN project_finance.participants_can_add_costs IS
  'Set by the PM: internal participants may add cost items to tasks they are assigned to.';

CREATE TABLE IF NOT EXISTS project_category_budgets (
  project_id    UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id   UUID          NOT NULL REFERENCES project_cost_categories(id),
  tenant_id     UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  planned_cost  NUMERIC(14,2) NOT NULL CHECK (planned_cost >= 0),
  PRIMARY KEY (project_id, category_id)
);

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS planned_cost NUMERIC(14,2) CHECK (planned_cost >= 0);

COMMENT ON COLUMN project_tasks.planned_cost IS
  'Optional planned cost of the task in the project currency. Reported next to the category
   budgets, never added to them.';

-- ── Cost items (actuals) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_cost_items (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id          UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id             UUID          REFERENCES project_tasks(id) ON DELETE SET NULL,
  category_id         UUID          NOT NULL REFERENCES project_cost_categories(id),
  cost_date           DATE          NOT NULL,
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description         TEXT,
  supplier_name       VARCHAR(200),
  document_number     VARCHAR(100),
  status              VARCHAR(10)   NOT NULL DEFAULT 'incurred' CHECK (status IN ('planned', 'incurred')),
  original_amount     NUMERIC(14,2) CHECK (original_amount > 0),
  original_currency   CHAR(3),
  exchange_rate       NUMERIC(18,8),
  exchange_rate_date  DATE,
  created_by          UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_cost_items_project ON project_cost_items(project_id);
CREATE INDEX IF NOT EXISTS idx_project_cost_items_task ON project_cost_items(task_id);

COMMENT ON COLUMN project_cost_items.amount IS 'Net amount in the project currency.';
COMMENT ON COLUMN project_cost_items.original_amount IS
  'Amount as entered when the cost was in another currency; NULL otherwise.';
COMMENT ON COLUMN project_cost_items.exchange_rate IS
  'Project-currency price of one unit of original_currency, filled only when amount was
   computed from the NBP rate published on exchange_rate_date.';

-- ── Revenue items (per project, never per task) ──────────────────────────
CREATE TABLE IF NOT EXISTS project_revenue_items (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revenue_date  DATE          NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description   TEXT,
  status        VARCHAR(10)   NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'invoiced', 'paid')),
  created_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_revenue_items_project ON project_revenue_items(project_id);
