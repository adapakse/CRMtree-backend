-- 0152_crm_lead_documents_uuid.sql
-- Zmiana typu crm_lead_documents.document_id z INTEGER na UUID,
-- aby pasował do documents.id (UUID PRIMARY KEY).
-- Istniejące wiersze (o ile są) mają nieważne integer-owe wartości
-- i nie da się ich zmapować — tabela jest czyszczona przed zmianą.

-- 1. Usuń istniejące constrainty oparte na document_id
ALTER TABLE crm_lead_documents DROP CONSTRAINT IF EXISTS crm_lead_documents_document_id_lead_id_key;
ALTER TABLE crm_lead_documents DROP CONSTRAINT IF EXISTS crm_lead_docs_unique;

-- 2. Wyczyść ewentualne wiersze (document_id INTEGER → nie da się skonwertować do UUID)
DELETE FROM crm_lead_documents;

-- 3. Zmień typ kolumny
ALTER TABLE crm_lead_documents
  DROP COLUMN document_id;

ALTER TABLE crm_lead_documents
  ADD COLUMN document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE;

-- 4. Odtwórz UNIQUE constraint
ALTER TABLE crm_lead_documents
  ADD CONSTRAINT crm_lead_docs_unique UNIQUE (lead_id, document_id);
