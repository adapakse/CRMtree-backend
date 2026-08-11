-- 0239_invoice_legal_data.sql
-- Real seller/buyer legal data for invoices, so the PDF can stop being a
-- permanent "DOKUMENT TESTOWY" and become a normal Polish business invoice
-- once an admin fills in the required fields. Nothing here is hardcoded —
-- these are configuration tables an admin fills in through the UI; the
-- invoice PDF renders "brak danych" placeholders until they do.

-- ── CRMtree's own seller data — platform-wide, not per-tenant, so it does
--    NOT fit app_settings (tenant_id there is NOT NULL). Singleton row.
CREATE TABLE IF NOT EXISTS billing_seller_config (
  id                  SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name        VARCHAR(255),
  nip                 VARCHAR(20),
  address             TEXT,
  bank_account_number VARCHAR(64),
  bank_name           VARCHAR(255),
  payment_term_days   INTEGER      NOT NULL DEFAULT 14,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by          UUID
);
INSERT INTO billing_seller_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE billing_seller_config IS 'Singleton (id=1) — CRMtree''s own legal/seller data for invoice PDFs. Filled in by a superadmin, never hardcoded.';

-- ── Per-tenant legal buyer data — same 1:1-with-tenant pattern as
--    tenant_whatsapp_config / tenant_subscriptions, not raw columns on tenants.
CREATE TABLE IF NOT EXISTS tenant_billing_details (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  company_name  VARCHAR(255),
  nip           VARCHAR(20),
  address       TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID
);

COMMENT ON TABLE tenant_billing_details IS 'Legal buyer data (company name/NIP/address) for invoice PDFs — separate from tenants.name, which is just the CRM display name.';

-- ── Freeze seller/buyer legal data + due date onto each invoice at
--    generation time — an already-issued invoice must keep showing what was
--    true when it was issued, even if the tenant's NIP or CRMtree's bank
--    account changes later. Same reasoning as tenant_subscription_history.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS due_date            DATE,
  ADD COLUMN IF NOT EXISTS seller_name         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS seller_nip          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS seller_address      TEXT,
  ADD COLUMN IF NOT EXISTS seller_bank_account VARCHAR(64),
  ADD COLUMN IF NOT EXISTS buyer_name          VARCHAR(255),
  ADD COLUMN IF NOT EXISTS buyer_nip           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS buyer_address       TEXT;

-- Backfill pre-existing rows so already-issued invoices stay consistent —
-- due_date mirrors the old hardcoded 14-day constant, buyer_name/seller_name
-- get what was actually shown on those PDFs (the tenant's name / "CRMtree").
-- NIP/address/bank account were never known for old rows — stay NULL,
-- rendered as "brak danych" placeholders, same as before this migration.
UPDATE invoices SET due_date = (generated_at + INTERVAL '14 days')::date WHERE due_date IS NULL;
UPDATE invoices SET seller_name = 'CRMtree' WHERE seller_name IS NULL;
UPDATE invoices i SET buyer_name = t.name FROM tenants t WHERE t.id = i.tenant_id AND i.buyer_name IS NULL;

ALTER TABLE invoices ALTER COLUMN due_date SET NOT NULL;

COMMENT ON COLUMN invoices.due_date IS 'Frozen at generation time from billing_seller_config.payment_term_days — a later change to that config must not retroactively move an issued invoice''s due date.';
