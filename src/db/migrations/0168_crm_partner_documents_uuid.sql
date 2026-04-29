-- 0168_crm_partner_documents_uuid.sql
-- Zmiana typu crm_partner_documents.document_id z INTEGER na UUID,
-- aby pasował do documents.id (UUID PRIMARY KEY).
-- Analogiczna zmiana do 0152 (crm_lead_documents).

-- 1. Usuń istniejące constrainty oparte na document_id
ALTER TABLE crm_partner_documents DROP CONSTRAINT IF EXISTS crm_partner_documents_partner_id_document_id_key;
ALTER TABLE crm_partner_documents DROP CONSTRAINT IF EXISTS crm_partner_docs_unique;

-- 2. Wyczyść istniejące wiersze (document_id INTEGER → nie da się skonwertować do UUID)
DELETE FROM crm_partner_documents;

-- 3. Zmień typ kolumny
ALTER TABLE crm_partner_documents
  DROP COLUMN document_id;

ALTER TABLE crm_partner_documents
  ADD COLUMN document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE;

-- 4. Odtwórz UNIQUE constraint
ALTER TABLE crm_partner_documents
  ADD CONSTRAINT crm_partner_documents_partner_id_document_id_key UNIQUE (partner_id, document_id);
