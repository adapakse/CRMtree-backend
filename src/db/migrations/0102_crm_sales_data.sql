-- Migration: 0102_crm_sales_data
-- Tabela danych sprzedażowych importowanych z zewnętrznych systemów

CREATE TABLE IF NOT EXISTS crm_sales_data (
  id              SERIAL PRIMARY KEY,
  period          CHAR(7)     NOT NULL,  -- FORMAT: YYYY-MM (np. "2025-03")
  revenue_pln     NUMERIC(14,2) NOT NULL DEFAULT 0,
  pipeline_pln    NUMERIC(14,2) NOT NULL DEFAULT 0,
  deals_won       INTEGER     NOT NULL DEFAULT 0,
  deals_lost      INTEGER     NOT NULL DEFAULT 0,
  new_leads       INTEGER     NOT NULL DEFAULT 0,
  conversion_rate NUMERIC(5,2) NOT NULL DEFAULT 0,   -- procent np. 23.50
  avg_deal_size   NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  imported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (period)   -- jeden rekord na miesiąc (upsert)
);

-- Log importów danych sprzedażowych
CREATE TABLE IF NOT EXISTS crm_sales_import_logs (
  id              SERIAL PRIMARY KEY,
  filename        TEXT        NOT NULL,
  rows_total      INTEGER     NOT NULL DEFAULT 0,
  rows_imported   INTEGER     NOT NULL DEFAULT 0,
  rows_skipped    INTEGER     NOT NULL DEFAULT 0,
  rows_error      INTEGER     NOT NULL DEFAULT 0,
  error_details   JSONB,
  status          TEXT        NOT NULL DEFAULT 'done' CHECK (status IN ('done','error')),
  imported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_sales_data_period ON crm_sales_data (period);
