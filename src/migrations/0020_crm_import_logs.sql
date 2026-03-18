-- ─────────────────────────────────────────────────────────────────
-- Migration: crm_import_logs
-- Tabela historii importów CSV dla leadów i partnerów
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_import_logs (
  id            SERIAL PRIMARY KEY,
  import_type   VARCHAR(20)  NOT NULL CHECK (import_type IN ('leads','partners')),
  filename      VARCHAR(255) NOT NULL,
  rows_total    INTEGER      NOT NULL DEFAULT 0,
  rows_imported INTEGER      NOT NULL DEFAULT 0,
  rows_skipped  INTEGER      NOT NULL DEFAULT 0,
  rows_error    INTEGER      NOT NULL DEFAULT 0,
  error_details JSONB,
  status        VARCHAR(20)  NOT NULL DEFAULT 'processing'
                             CHECK (status IN ('processing','done','error')),
  imported_by   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_import_logs_imported_by_idx ON crm_import_logs(imported_by);
CREATE INDEX IF NOT EXISTS crm_import_logs_started_at_idx  ON crm_import_logs(started_at DESC);
