-- 0241_billing_details_structured_address.sql
-- Splits the buyer's free-text `address` into structured fields (street,
-- postal code, city, country) and adds an invoice-delivery email — for
-- tenant_billing_details and the matching frozen snapshot on invoices.
-- Does NOT touch billing_seller_config (CRMtree's own address stays a
-- single free-text field — out of scope for this change).
--
-- Data-loss check done before writing this migration: tenant_billing_details
-- had exactly 2 rows, both on test tenants (zz-test-standard/-professional)
-- that were deleted as part of this same cleanup — the table is empty at
-- migration time. Only one invoice ever had a non-null buyer_address, and it
-- belonged to one of those same test tenants (also deleted). The single
-- remaining real invoice (CRMtree Gold's) has buyer_address = NULL. Dropping
-- buyer_address outright is therefore safe — nothing real to backfill.

ALTER TABLE tenant_billing_details
  DROP COLUMN address,
  ADD COLUMN street        VARCHAR(255),
  ADD COLUMN postal_code   VARCHAR(20),
  ADD COLUMN city          VARCHAR(255),
  ADD COLUMN country       VARCHAR(100),
  ADD COLUMN invoice_email VARCHAR(255);

COMMENT ON TABLE tenant_billing_details IS 'Legal buyer data (company name/NIP/structured address/invoice email) for invoice PDFs — separate from tenants.name, which is just the CRM display name.';

ALTER TABLE invoices
  DROP COLUMN buyer_address,
  ADD COLUMN buyer_street        VARCHAR(255),
  ADD COLUMN buyer_postal_code   VARCHAR(20),
  ADD COLUMN buyer_city          VARCHAR(255),
  ADD COLUMN buyer_country       VARCHAR(100),
  ADD COLUMN buyer_invoice_email VARCHAR(255);
