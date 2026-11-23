-- Indexes for matching companies by NIP regardless of how it was typed
-- ("123-456-32-18", "PL 123 456 32 18", "1234563218").
--
-- The prospects list asks, for every row on the page, whether that NIP is already
-- a Lead or a Partner of the tenant, comparing REGEXP_REPLACE(nip, '[^0-9]', '', 'g')
-- on both sides. Without an index on that expression each of those lookups read
-- every lead and partner of the tenant: with 10 000 leads a 200-row page took
-- 3-4 seconds. The expression below must stay exactly as written in the queries
-- (admin-prospects.js: the list and the CSV import) — Postgres uses an expression
-- index only for the identical expression.

CREATE INDEX IF NOT EXISTS idx_crm_leads_tenant_nip_digits
  ON crm_leads (tenant_id, (REGEXP_REPLACE(nip, '[^0-9]', '', 'g')))
  WHERE nip IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_partners_tenant_nip_digits
  ON crm_partners (tenant_id, (REGEXP_REPLACE(nip, '[^0-9]', '', 'g')))
  WHERE nip IS NOT NULL;
