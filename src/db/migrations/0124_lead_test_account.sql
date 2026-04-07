-- 0124_lead_test_account.sql
-- Tabela przechowująca dane do założenia konta testowego dla Leada.
-- Dane są zapamiętywane po pierwszym wywołaniu i mogą być edytowane
-- przy ponownym wywołaniu (np. po błędzie).
-- Numer konta testowego (test_account_number) jest przepisywany
-- do crm_partners.partner_number podczas migracji Lead → Partner.

CREATE TABLE IF NOT EXISTS crm_lead_test_accounts (
  id                    SERIAL PRIMARY KEY,
  lead_id               INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,

  -- ── Dane techniczne (Punkt A) ────────────────────────────────────
  subdomain             VARCHAR(100),          -- subdomena w systemie zewnętrznym
  language              VARCHAR(50),           -- język interfejsu konta
  partner_currency      VARCHAR(10),           -- waluta rozliczeń
  country               VARCHAR(100),          -- kraj rejestracji

  -- ── Adres rozliczeniowy (Punkt B) ────────────────────────────────
  billing_address       VARCHAR(255),
  billing_zip           VARCHAR(20),
  billing_city          VARCHAR(100),
  billing_country       VARCHAR(100),
  billing_email_address VARCHAR(255),

  -- ── Dane administratora (Punkt C) ────────────────────────────────
  admin_first_name      VARCHAR(100),
  admin_last_name       VARCHAR(100),
  admin_email           VARCHAR(255),

  -- ── Wynik wywołania API ──────────────────────────────────────────
  -- status: 'draft' | 'pending' | 'created' | 'error'
  status                VARCHAR(20)  NOT NULL DEFAULT 'draft',
  test_account_number   VARCHAR(100),          -- numer konta zwrócony przez zewnętrzne API
  last_error            TEXT,                  -- ostatni komunikat błędu z zewnętrznego API
  last_called_at        TIMESTAMPTZ,           -- kiedy ostatnio wywołano zewnętrzne API
  called_by             UUID REFERENCES users(id),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Jeden rekord per lead (unikalne — dane są uaktualniane przy ponownym użyciu)
  CONSTRAINT crm_lead_test_accounts_lead_unique UNIQUE (lead_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_lead_test_accounts_lead_id
  ON crm_lead_test_accounts(lead_id);

COMMENT ON TABLE crm_lead_test_accounts IS
  'Dane do założenia konta testowego dla Leada. Jeden rekord per lead, aktualizowany przy ponownym wywołaniu.';
COMMENT ON COLUMN crm_lead_test_accounts.test_account_number IS
  'Numer konta testowego zwrócony przez zewnętrzny system. Przepisywany do crm_partners.partner_number przy migracji.';
COMMENT ON COLUMN crm_lead_test_accounts.status IS
  'draft=dane zapisane lokalnie, pending=wywołanie w toku, created=konto założone, error=błąd zewnętrznego API';
