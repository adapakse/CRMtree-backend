-- 0242_invoice_vat.sql
-- Adds real VAT (23%, standard Polish rate — confirmed 2026-08-07, Travel
-- Manager Sp. z o.o.'s scale rules out the small-business VAT exemption
-- under art. 113) to invoices. Frozen at generation time, same immutability
-- reasoning as every other invoice field: a future change to the rate must
-- never retroactively alter an already-issued invoice.
--
-- Existing invoices are backfilled to 0% / 0.00 — they were genuinely
-- issued under the "0%, no VAT claim" treatment that was in effect at the
-- time (see invoicePdfService.js history), not a data gap to fix. Their
-- already-generated PDF files in blob storage are unaffected either way.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS vat_rate       NUMERIC(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_amount_eur NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN invoices.vat_rate IS 'VAT percentage frozen at generation time (e.g. 23.00). 0 for invoices issued before VAT was configured.';
COMMENT ON COLUMN invoices.vat_amount_eur IS 'VAT amount in EUR, frozen at generation time = total_amount_eur * vat_rate / 100.';
