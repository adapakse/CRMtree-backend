-- 0320_invoice_documents.sql
-- Project finance, stage 4: invoices as a document type in the Documents module.
--
-- An invoice is a document with doc_type = 'invoice'. It reuses the existing
-- columns where they fit and adds only what a contract does not have:
--   signing_date     = issue date
--   expiration_date  = payment due date (so "expires soon" keeps working)
--   entities / nip   = buyer and seller names / seller tax ID
--   contract_subject = not used
-- A document is either entered by hand or registered from a KSeF invoice
-- (ksef_invoice_id set). A project cost item may point at an invoice document.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS invoice_number  VARCHAR(256),
  ADD COLUMN IF NOT EXISTS net_amount      NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS vat_amount      NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS gross_amount    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS currency        CHAR(3),
  ADD COLUMN IF NOT EXISTS bank_account    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS payment_status  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ksef_invoice_id UUID REFERENCES ksef_invoices(id) ON DELETE SET NULL;

COMMENT ON COLUMN documents.payment_status IS
  'Invoice documents only: a value of the tenant dictionary doc_payment_statuses, set by hand.
   "Overdue" is additionally derived on read (due date passed and status not paid).';
COMMENT ON COLUMN documents.ksef_invoice_id IS
  'The KSeF invoice this document was registered from; NULL for an invoice entered by hand.';

-- One live document per KSeF invoice; a deleted document frees the invoice
-- to be registered again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_tenant_ksef_invoice
  ON documents(tenant_id, ksef_invoice_id)
  WHERE ksef_invoice_id IS NOT NULL AND deleted_at IS NULL;

-- ── Link from a cost item to an invoice document ─────────────────────────
-- No uniqueness, as with ksef_invoice_id: one document may be linked many times.
ALTER TABLE project_cost_items
  ADD COLUMN IF NOT EXISTS document_id        UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS document_linked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS document_linked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_cost_items_document
  ON project_cost_items(document_id) WHERE document_id IS NOT NULL;

-- ── Dictionaries ─────────────────────────────────────────────────────────
-- Every tenant, including the template tenant new tenants copy their settings
-- from. Tenants without a doc_types row keep using the built-in list.
UPDATE app_settings
SET value = (value::jsonb || '["invoice"]'::jsonb)::text
WHERE key = 'doc_types' AND NOT (value::jsonb ? 'invoice');

INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
SELECT t.id,
       'doc_payment_statuses',
       '["unpaid","partially_paid","paid","overdue"]',
       'Statusy płatności faktur',
       'Dostępne statusy płatności dokumentów typu Faktura. unpaid=Nieopłacona, partially_paid=Opłacona częściowo, paid=Opłacona, overdue=Po terminie.',
       'json',
       'documents'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
