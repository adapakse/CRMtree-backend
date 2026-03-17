-- Migration: 0103_crm_sales_transactions
-- Dane sprzedażowe row-level: partner × produkt × miesiąc
-- Handlowiec wynika z JOIN crm_partners.manager_id → users.display_name

DROP TABLE IF EXISTS crm_sales_data CASCADE;
DROP TABLE IF EXISTS crm_sales_import_logs CASCADE;
DROP TABLE IF EXISTS crm_sales_transactions CASCADE;

CREATE TABLE crm_sales_transactions (
  id                  SERIAL PRIMARY KEY,

  -- Wymiary
  period              CHAR(7)       NOT NULL,  -- YYYY-MM
  partner_name        TEXT          NOT NULL,  -- musi pasować do crm_partners.company
  product_type        TEXT          NOT NULL DEFAULT 'other',
    -- hotel | transport_flight | transport_train | transport_bus |
    -- transport_ferry | car_rental | transfer | travel_insurance | visa | other

  -- Finansowe (PLN)
  gross_turnover_pln  NUMERIC(14,2) NOT NULL DEFAULT 0,  -- obrót brutto
  net_turnover_pln    NUMERIC(14,2) NOT NULL DEFAULT 0,  -- obrót netto
  fees_pln            NUMERIC(14,2) NOT NULL DEFAULT 0,  -- fees / prowizje
  revenue_pln         NUMERIC(14,2) NOT NULL DEFAULT 0,  -- przychód (marża)

  -- Operacyjne
  transactions_count  INTEGER       NOT NULL DEFAULT 0,
  pax_count           INTEGER       NOT NULL DEFAULT 0,

  notes               TEXT,
  imported_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (period, partner_name, product_type)
);

CREATE INDEX idx_cst_period       ON crm_sales_transactions (period);
CREATE INDEX idx_cst_partner_name ON crm_sales_transactions (partner_name);
CREATE INDEX idx_cst_product_type ON crm_sales_transactions (product_type);
