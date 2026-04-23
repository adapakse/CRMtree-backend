-- 0150_test_account_htcd_fields.sql
-- Dodaje kolumny htcd_partner_id i price_list_url do tabeli crm_lead_test_accounts.

ALTER TABLE crm_lead_test_accounts
  ADD COLUMN IF NOT EXISTS htcd_partner_id INTEGER,
  ADD COLUMN IF NOT EXISTS price_list_url  VARCHAR(500);
