-- ═══════════════════════════════════════════════════════════════════
-- Migration: 0100_crm_module.sql
-- CRM Module — wszystkie tabele, rozszerzenie users, app_settings
-- Wymaga: tabela users (id UUID), tabela app_settings
-- ═══════════════════════════════════════════════════════════════════

-- ── Rozszerzenie tabeli users o rolę CRM ────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS crm_role VARCHAR(30)
    CHECK (crm_role IN ('salesperson','sales_manager') OR crm_role IS NULL);

-- ── Grupy Partnerów ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_partner_groups (
  id          SERIAL        PRIMARY KEY,
  name        VARCHAR(200)  NOT NULL,
  industry    VARCHAR(100),
  description TEXT,
  manager_id  UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_by  UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── Leady sprzedażowe ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_leads (
  id              SERIAL        PRIMARY KEY,
  company         VARCHAR(200)  NOT NULL,
  contact_name    VARCHAR(150),
  contact_title   VARCHAR(100),
  email           VARCHAR(200),
  phone           VARCHAR(50),
  source          VARCHAR(80),
  -- new | qualification | presentation | offer | negotiation | closed_won | closed_lost
  stage           VARCHAR(60)   NOT NULL DEFAULT 'new',
  value_pln       NUMERIC(14,2),
  probability     SMALLINT      CHECK (probability BETWEEN 0 AND 100),
  close_date      DATE,
  industry        VARCHAR(100),
  assigned_to     UUID          REFERENCES users(id) ON DELETE SET NULL,
  tags            TEXT[]        NOT NULL DEFAULT '{}',
  notes           TEXT,
  hot             BOOLEAN       NOT NULL DEFAULT false,
  converted_at    TIMESTAMPTZ,
  lost_reason     VARCHAR(200),
  created_by      UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_leads_assigned  ON crm_leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_leads_stage     ON crm_leads(stage);
CREATE INDEX IF NOT EXISTS idx_crm_leads_converted ON crm_leads(converted_at);

-- ── Aktywności na Leadach ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_lead_activities (
  id            SERIAL        PRIMARY KEY,
  lead_id       INTEGER       NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  -- call | email | meeting | note | doc_sent
  type          VARCHAR(40)   NOT NULL,
  title         VARCHAR(300)  NOT NULL,
  body          TEXT,
  activity_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  duration_min  SMALLINT,
  participants  TEXT,
  doc_id        INTEGER,
  created_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_lead_act_lead ON crm_lead_activities(lead_id);

-- ── Powiązania Lead ↔ Dokument ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_lead_documents (
  id          SERIAL        PRIMARY KEY,
  lead_id     INTEGER       NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  document_id INTEGER       NOT NULL,
  doc_role    VARCHAR(80),
  linked_by   UUID          REFERENCES users(id) ON DELETE SET NULL,
  linked_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE(lead_id, document_id)
);

-- ── Partnerzy ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_partners (
  id               SERIAL        PRIMARY KEY,
  company          VARCHAR(200)  NOT NULL,
  nip              VARCHAR(20),
  address          VARCHAR(300),
  contact_name     VARCHAR(150),
  contact_title    VARCHAR(100),
  email            VARCHAR(200),
  phone            VARCHAR(50),
  industry         VARCHAR(100),
  group_id         INTEGER       REFERENCES crm_partner_groups(id) ON DELETE SET NULL,
  lead_id          INTEGER       REFERENCES crm_leads(id) ON DELETE SET NULL,  -- nullable
  manager_id       UUID          REFERENCES users(id) ON DELETE SET NULL,
  contract_doc_id  INTEGER,
  contract_signed  DATE,
  contract_expires DATE,
  contract_value   NUMERIC(14,2),
  -- onboarding | active | inactive | churned
  status           VARCHAR(40)   NOT NULL DEFAULT 'onboarding',
  arr              NUMERIC(14,2),
  license_count    INTEGER,
  active_users     INTEGER,
  onboarding_step  SMALLINT      NOT NULL DEFAULT 0 CHECK (onboarding_step BETWEEN 0 AND 3),
  notes            TEXT,
  created_by       UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_partners_manager ON crm_partners(manager_id);
CREATE INDEX IF NOT EXISTS idx_crm_partners_group   ON crm_partners(group_id);
CREATE INDEX IF NOT EXISTS idx_crm_partners_status  ON crm_partners(status);

-- ── Aktywności na Partnerach ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_partner_activities (
  id            SERIAL        PRIMARY KEY,
  partner_id    INTEGER       NOT NULL REFERENCES crm_partners(id) ON DELETE CASCADE,
  -- call | email | meeting | note | doc_sent | training | qbr
  type          VARCHAR(40)   NOT NULL,
  title         VARCHAR(300)  NOT NULL,
  body          TEXT,
  activity_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  duration_min  SMALLINT,
  participants  TEXT,
  doc_id        INTEGER,
  created_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_partner_act_partner ON crm_partner_activities(partner_id);

-- ── Powiązania Partner ↔ Dokument ────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_partner_documents (
  id          SERIAL        PRIMARY KEY,
  partner_id  INTEGER       NOT NULL REFERENCES crm_partners(id) ON DELETE CASCADE,
  document_id INTEGER       NOT NULL,
  doc_role    VARCHAR(80),
  linked_by   UUID          REFERENCES users(id) ON DELETE SET NULL,
  linked_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE(partner_id, document_id)
);

-- ── Transakcje (z platformy) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_transactions (
  id               SERIAL        PRIMARY KEY,
  partner_id       INTEGER       REFERENCES crm_partners(id) ON DELETE SET NULL,
  external_id      VARCHAR(100)  UNIQUE,
  booking_ref      VARCHAR(100),
  transaction_date TIMESTAMPTZ   NOT NULL,
  traveler_name    VARCHAR(200),
  traveler_email   VARCHAR(200),
  total_net        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_gross      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_commission NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_margin     NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency         CHAR(3)       NOT NULL DEFAULT 'PLN',
  -- confirmed | cancelled | refunded
  status           VARCHAR(40)   NOT NULL DEFAULT 'confirmed',
  raw_payload      JSONB,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_txn_partner ON crm_transactions(partner_id);
CREATE INDEX IF NOT EXISTS idx_crm_txn_date    ON crm_transactions(transaction_date);

-- ── Produkty transakcji ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_transaction_products (
  id                  SERIAL        PRIMARY KEY,
  transaction_id      INTEGER       NOT NULL REFERENCES crm_transactions(id) ON DELETE CASCADE,
  -- hotel | transport_flight | transport_train | transport_bus | transport_ferry
  -- car_rental | transfer | travel_insurance | visa | other
  product_type        VARCHAR(40)   NOT NULL,
  product_name        VARCHAR(300),
  supplier            VARCHAR(200),
  booking_ref         VARCHAR(100),
  -- Czas i miejsce
  departure_at        TIMESTAMPTZ,
  arrival_at          TIMESTAMPTZ,
  origin_city         VARCHAR(150),
  origin_country      CHAR(2),
  destination_city    VARCHAR(150),
  destination_country CHAR(2),
  duration_nights     SMALLINT,
  -- Hotel
  hotel_name          VARCHAR(200),
  hotel_stars         SMALLINT      CHECK (hotel_stars BETWEEN 1 AND 5),
  room_type           VARCHAR(100),
  check_in            DATE,
  check_out           DATE,
  -- Transport lotniczy
  flight_number       VARCHAR(20),
  airline             VARCHAR(100),
  cabin_class         VARCHAR(30),   -- economy | premium_economy | business | first
  seat                VARCHAR(10),
  -- Wynajem auta
  car_category        VARCHAR(80),
  pickup_location     VARCHAR(200),
  dropoff_location    VARCHAR(200),
  -- Koszty (wymagane)
  net_cost            NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_cost          NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission_pct      NUMERIC(6,4),   -- np. 0.1200 = 12%
  commission_amt      NUMERIC(14,2),
  margin_amt          NUMERIC(14,2),
  currency            CHAR(3)       NOT NULL DEFAULT 'PLN',
  pax_count           SMALLINT      NOT NULL DEFAULT 1,
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_crm_txn_prod_txn  ON crm_transaction_products(transaction_id);
CREATE INDEX IF NOT EXISTS idx_crm_txn_prod_type ON crm_transaction_products(product_type);

-- ── Szanse sprzedaży (upsell/cross-sell) ────────────────────────────
CREATE TABLE IF NOT EXISTS crm_opportunities (
  id            SERIAL        PRIMARY KEY,
  partner_id    INTEGER       NOT NULL REFERENCES crm_partners(id) ON DELETE CASCADE,
  -- upsell | crosssell
  type          VARCHAR(20)   NOT NULL,
  title         VARCHAR(300)  NOT NULL,
  description   TEXT,
  value_pln     NUMERIC(14,2),
  -- open | in_progress | won | snoozed | dismissed
  status        VARCHAR(30)   NOT NULL DEFAULT 'open',
  snooze_until  DATE,
  assigned_to   UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── Log importów CSV ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_import_logs (
  id            SERIAL        PRIMARY KEY,
  import_type   VARCHAR(30)   NOT NULL,   -- leads | partners
  filename      VARCHAR(300),
  rows_total    INTEGER       NOT NULL DEFAULT 0,
  rows_imported INTEGER       NOT NULL DEFAULT 0,
  rows_skipped  INTEGER       NOT NULL DEFAULT 0,
  rows_error    INTEGER       NOT NULL DEFAULT 0,
  error_details JSONB,
  -- processing | done | error
  status        VARCHAR(20)   NOT NULL DEFAULT 'processing',
  imported_by   UUID          REFERENCES users(id) ON DELETE SET NULL,
  started_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

-- ── Klucze API dla platformy transakcyjnej ───────────────────────────
CREATE TABLE IF NOT EXISTS crm_api_keys (
  id          SERIAL        PRIMARY KEY,
  name        VARCHAR(100)  NOT NULL,
  key_hash    TEXT          NOT NULL,     -- bcrypt hash klucza
  active      BOOLEAN       NOT NULL DEFAULT true,
  created_by  UUID          REFERENCES users(id) ON DELETE SET NULL,
  last_used   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── App Settings dla CRM ─────────────────────────────────────────────
INSERT INTO app_settings (key, value, label, description) VALUES
  ('crm_hot_lead_days',        '7',    'Dni bez kontaktu (zimny lead)',      'Dni bez kontaktu → lead oznaczyć jako zimny'),
  ('crm_renewal_warning_days', '90',   'Alert wygaśnięcia umowy (dni)',      'Alert X dni przed wygaśnięciem umowy'),
  ('crm_adoption_target_pct',  '75',   'Cel adopcji użytkowników (%)',       'Docelowy % aktywnych użytkowników u partnera'),
  ('crm_csv_max_rows',         '5000', 'Limit wierszy importu CSV',          'Limit wierszy w pojedynczym imporcie CSV'),
  ('crm_platform_api_key',     '',     'Klucz API platformy transakcyjnej', 'Klucz API platformy transakcyjnej (plain, zmień po wdrożeniu)')
ON CONFLICT (key) DO NOTHING;
