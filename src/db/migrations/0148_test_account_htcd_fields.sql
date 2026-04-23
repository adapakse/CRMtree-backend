-- 0148_test_account_htcd_fields.sql
-- Dodaje pola zwracane przez HTCD API po założeniu konta testowego.

ALTER TABLE crm_lead_test_accounts
  ADD COLUMN IF NOT EXISTS htcd_partner_id   INTEGER,
  ADD COLUMN IF NOT EXISTS price_list_url    VARCHAR(500);

COMMENT ON COLUMN crm_lead_test_accounts.htcd_partner_id IS
  'ID Partnera nadane przez HTCD po założeniu konta testowego (data.id z odpowiedzi API).';
COMMENT ON COLUMN crm_lead_test_accounts.price_list_url IS
  'URL cennika Partnera w HTCD (data.priceListUrl z odpowiedzi API).';
