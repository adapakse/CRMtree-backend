-- 0240_invoice_void.sql
-- Void/cancel support for invoices — an issued invoice must never be
-- physically edited or deleted (see admin-billing.js: no PATCH/DELETE route
-- exists for invoices' financial fields, and none is added here either).
-- A superadmin can instead mark it void with a required reason; it stays
-- visible in the list forever as part of the audit trail. Correction
-- invoices (KSeF "faktura korygująca") are explicitly out of scope for now.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by   UUID,
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;

-- Voiding an invoice must allow a corrected one to be generated for the same
-- (tenant, period) — the plain UNIQUE constraint below would otherwise
-- permanently block that period. Replace it with a partial unique index that
-- only guards ISSUED rows: any number of void rows can pile up per period
-- (never deleted, full history preserved), but at most one ISSUED row.
ALTER TABLE invoices DROP CONSTRAINT invoices_tenant_id_period_start_period_end_key;

CREATE UNIQUE INDEX invoices_tenant_period_issued_uniq
  ON invoices (tenant_id, period_start, period_end)
  WHERE status = 'issued';

COMMENT ON INDEX invoices_tenant_period_issued_uniq IS 'Replaces the old plain UNIQUE(tenant_id, period_start, period_end) — only one ISSUED invoice per period at a time, but voiding one frees the period up for a corrected regeneration.';
