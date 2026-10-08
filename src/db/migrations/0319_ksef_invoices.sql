-- 0319_ksef_invoices.sql
-- Project finance, stage 3: purchase invoices pulled from KSeF (the Polish
-- national e-invoice system) and their links to project cost items.
--
-- The tenant admin registers companies (the tenant's own NIPs, each with a KSeF
-- token); a periodic job copies their purchase invoices here. A cost item MAY
-- point at one of those invoices. The number of days the first sync goes back
-- lives in app_settings (key 'ksef_initial_sync_days'; no row = 30).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_view_ksef_invoices BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.can_view_ksef_invoices IS
  'Granted by the tenant admin: the user may browse KSeF invoices and link them to project
   costs. The tenant admin has this right without the flag.';

-- ── Companies whose purchase invoices are synced ─────────────────────────
CREATE TABLE IF NOT EXISTS ksef_companies (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nip              CHAR(10)      NOT NULL,
  name             VARCHAR(200),
  token_encrypted  TEXT          NOT NULL,
  token_hint       VARCHAR(4)    NOT NULL,
  status           VARCHAR(10)   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid', 'error')),
  last_error       TEXT,
  sync_from        TIMESTAMPTZ   NOT NULL,
  last_attempt_at  TIMESTAMPTZ,
  last_synced_at   TIMESTAMPTZ,
  created_by       UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nip)
);

COMMENT ON COLUMN ksef_companies.token_encrypted IS
  'KSeF token, AES-256-GCM (src/utils/encrypt.js). Never returned by the API.';
COMMENT ON COLUMN ksef_companies.status IS
  'active; invalid = KSeF rejected the token, no periodic sync until it is replaced;
   error = the last sync failed for another reason and is retried on the next run.';
COMMENT ON COLUMN ksef_companies.sync_from IS
  'Cursor on the KSeF permanent-storage date: the next export starts here. Only moves forward.';

-- ── Local copy of purchase invoices ──────────────────────────────────────
-- company_id is nulled when the company is removed: synced invoices stay.
CREATE TABLE IF NOT EXISTS ksef_invoices (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id              UUID          REFERENCES ksef_companies(id) ON DELETE SET NULL,
  ksef_number             VARCHAR(60)   NOT NULL,
  invoice_number          VARCHAR(256),
  invoice_type            VARCHAR(20),
  issue_date              DATE          NOT NULL,
  sale_date               DATE,
  seller_nip              VARCHAR(20),
  seller_name             TEXT,
  seller_address          TEXT,
  buyer_nip               VARCHAR(20),
  buyer_name              TEXT,
  buyer_address           TEXT,
  net_amount              NUMERIC(14,2),
  vat_amount              NUMERIC(14,2),
  gross_amount            NUMERIC(14,2),
  currency                CHAR(3)       NOT NULL DEFAULT 'PLN',
  payment_due_date        DATE,
  bank_account            VARCHAR(64),
  is_paid                 BOOLEAN,
  payment_date            DATE,
  amount_due              NUMERIC(14,2),
  payment                 JSONB,
  lines                   JSONB         NOT NULL DEFAULT '[]'::jsonb,
  permanent_storage_date  TIMESTAMPTZ,
  metadata                JSONB,
  raw_xml                 TEXT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ksef_number)
);

CREATE INDEX IF NOT EXISTS idx_ksef_invoices_tenant_issue_date ON ksef_invoices(tenant_id, issue_date DESC);

COMMENT ON COLUMN ksef_invoices.vat_amount IS
  'In the invoice currency. KSeF reports VAT of a foreign-currency invoice in PLN, so for those
   it is stored as gross - net.';
COMMENT ON COLUMN ksef_invoices.payment IS
  'Payment details read from the XML that have no column of their own: every due date, payment
   form, every bank account, the partial-payment flag.';
COMMENT ON COLUMN ksef_invoices.is_paid IS
  'TRUE when the XML marks the invoice as paid; NULL when it says nothing.';

-- ── Link from a cost item to an invoice ──────────────────────────────────
-- No uniqueness on purpose: one invoice may be linked many times, to several
-- tasks and projects, even twice to the same one.
ALTER TABLE project_cost_items
  ADD COLUMN IF NOT EXISTS ksef_invoice_id UUID REFERENCES ksef_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ksef_linked_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ksef_linked_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_cost_items_ksef_invoice
  ON project_cost_items(ksef_invoice_id) WHERE ksef_invoice_id IS NOT NULL;
