-- ─────────────────────────────────────────────────────────────────────
-- 002_attachments.sql
-- Tabela załączników do dokumentów (każdy załącznik ma własne wersje)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  blob_path       TEXT,
  blob_name       TEXT,
  blob_size_bytes BIGINT,
  mime_type       VARCHAR(100),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachment_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id   UUID NOT NULL REFERENCES document_attachments(id) ON DELETE CASCADE,
  version_number  INT NOT NULL DEFAULT 1,
  label           VARCHAR(255),
  blob_path       TEXT NOT NULL,
  blob_name       TEXT,
  blob_size_bytes BIGINT,
  mime_type       VARCHAR(100),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_attachments_doc ON document_attachments(document_id);
CREATE INDEX IF NOT EXISTS idx_att_versions_att    ON attachment_versions(attachment_id);
