-- ============================================================
-- worktrips.doc — Database Migration 001: Initial Schema
-- PostgreSQL 15+
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for fast ILIKE searches

-- ============================================================
-- ENUMERATIONS
-- ============================================================

CREATE TYPE doc_status AS ENUM (
  'new',
  'being_edited',
  'being_signed',
  'signed',
  'hold',
  'completed',
  'rejected'
);

CREATE TYPE doc_type AS ENUM (
  'partner_agreement',
  'it_supplier_agreement',
  'employee_agreement',
  'nda',
  'operator_agreement'
);

CREATE TYPE gdpr_type AS ENUM (
  'data_processing_entrustment',
  'data_administration',
  'no_gdpr'
);

CREATE TYPE access_level AS ENUM ('read', 'full');

CREATE TYPE workflow_task_type AS ENUM ('read', 'edit', 'approve', 'sign');

CREATE TYPE workflow_task_status AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');

CREATE TYPE audit_action AS ENUM (
  'document_created',
  'document_updated',
  'document_deleted',
  'document_viewed',
  'document_downloaded',
  'metadata_updated',
  'tag_added',
  'tag_removed',
  'tag_updated',
  'status_changed',
  'workflow_task_created',
  'workflow_task_completed',
  'workflow_task_cancelled',
  'signing_initiated',
  'signing_completed',
  'signing_failed',
  'version_uploaded',
  'user_login',
  'user_logout',
  'user_created',
  'user_updated',
  'role_assigned',
  'role_removed',
  'group_created',
  'group_updated',
  'group_deleted',
  'doc_group_created',
  'doc_group_updated',
  'doc_group_deleted',
  'document_linked',
  'document_unlinked'
);

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  first_name    VARCHAR(100),
  last_name     VARCHAR(100),
  display_name  VARCHAR(200) GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  saml_subject  VARCHAR(500),              -- NameID from SAML assertion
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_saml_subject ON users(saml_subject) WHERE saml_subject IS NOT NULL;

-- ============================================================
-- GROUP PROFILES
-- ============================================================

CREATE TABLE group_profiles (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                VARCHAR(100) UNIQUE NOT NULL,  -- e.g. 'Marketing', 'Sprzedaż'
  display_name        VARCHAR(200),
  description         TEXT,
  has_owner_restriction BOOLEAN NOT NULL DEFAULT FALSE, -- Sprzedaż rule
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_group_profiles_name ON group_profiles(name);

-- ============================================================
-- USER GROUP ROLES  (many-to-many: user <-> group + level)
-- ============================================================

CREATE TABLE user_group_roles (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id     UUID NOT NULL REFERENCES group_profiles(id) ON DELETE CASCADE,
  access_level access_level NOT NULL,
  assigned_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, group_id)
);

CREATE INDEX idx_ugr_user_id ON user_group_roles(user_id);
CREATE INDEX idx_ugr_group_id ON user_group_roles(group_id);

-- ============================================================
-- DOCUMENT GROUPS  (bundles: agreement + attachments)
-- ============================================================

CREATE TABLE document_groups (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOCUMENTS (core table)
-- ============================================================

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  doc_number      VARCHAR(50)  UNIQUE NOT NULL,   -- DOC-YYYY-NNNN, auto-generated
  name            VARCHAR(500) NOT NULL,
  doc_type        doc_type     NOT NULL,
  entities        TEXT[]       NOT NULL DEFAULT '{}', -- signing parties
  owner_id        UUID         REFERENCES users(id) ON DELETE SET NULL,
  group_id        UUID         REFERENCES group_profiles(id) ON DELETE RESTRICT,
  document_group_id UUID       REFERENCES document_groups(id) ON DELETE SET NULL,
  gdpr_type       gdpr_type    NOT NULL DEFAULT 'no_gdpr',
  status          doc_status   NOT NULL DEFAULT 'new',
  creation_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
  signing_date    DATE,
  expiration_date DATE,
  blob_path       VARCHAR(1000),    -- Azure Blob Storage path for current version
  blob_name       VARCHAR(500),     -- original filename
  blob_size_bytes BIGINT,
  mime_type       VARCHAR(100),
  signus_envelope_id VARCHAR(200),  -- Signus envelope tracking
  created_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,      -- soft delete
  deleted_by      UUID         REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_documents_status        ON documents(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_group_id      ON documents(group_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_owner_id      ON documents(owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_doc_group     ON documents(document_group_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_expiry        ON documents(expiration_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_doc_number    ON documents(doc_number);
CREATE INDEX idx_documents_created_at    ON documents(created_at DESC);
CREATE INDEX idx_documents_deleted_at    ON documents(deleted_at) WHERE deleted_at IS NOT NULL;

-- Full-text search index
CREATE INDEX idx_documents_fts ON documents
  USING gin(
    to_tsvector('simple',
      coalesce(doc_number,'') || ' ' ||
      coalesce(name,'') || ' ' ||
      coalesce(array_to_string(entities,' '),'')
    )
  )
  WHERE deleted_at IS NULL;

-- Counter for doc_number generation (per year)
CREATE TABLE doc_number_seq (
  year    SMALLINT PRIMARY KEY,
  last_n  INTEGER  NOT NULL DEFAULT 0
);

-- ============================================================
-- DOCUMENT TAGS
-- ============================================================

CREATE TABLE document_tags (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key         VARCHAR(100) NOT NULL,
  value       VARCHAR(500) NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, key)
);

CREATE INDEX idx_doc_tags_document_id ON document_tags(document_id);
CREATE INDEX idx_doc_tags_key_value   ON document_tags(key, value);
-- Trigram index for tag value search
CREATE INDEX idx_doc_tags_value_trgm  ON document_tags USING gin(value gin_trgm_ops);

-- ============================================================
-- DOCUMENT VERSIONS (archive — every uploaded / signed version)
-- ============================================================

CREATE TABLE document_versions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  label           VARCHAR(300),           -- e.g. 'Signed by Anna Kowalska'
  blob_path       VARCHAR(1000) NOT NULL,
  blob_name       VARCHAR(500),
  blob_size_bytes BIGINT,
  mime_type       VARCHAR(100),
  is_signed       BOOLEAN NOT NULL DEFAULT FALSE,
  signatory_name  VARCHAR(300),
  signatory_email VARCHAR(300),
  signus_signature_id VARCHAR(200),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version_number)
);

CREATE INDEX idx_doc_versions_document_id ON document_versions(document_id);
CREATE INDEX idx_doc_versions_created_at  ON document_versions(created_at DESC);

-- ============================================================
-- WORKFLOW TASKS
-- ============================================================

CREATE TABLE workflow_tasks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  assigned_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_type    workflow_task_type   NOT NULL,
  task_status  workflow_task_status NOT NULL DEFAULT 'pending',
  message      TEXT,
  due_date     DATE,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wf_tasks_document_id  ON workflow_tasks(document_id);
CREATE INDEX idx_wf_tasks_assigned_to  ON workflow_tasks(assigned_to);
CREATE INDEX idx_wf_tasks_task_status  ON workflow_tasks(task_status);
CREATE INDEX idx_wf_tasks_created_at   ON workflow_tasks(created_at DESC);

-- ============================================================
-- AUDIT LOGS (append-only — no UPDATE/DELETE in app layer)
-- ============================================================

CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Denormalised for log integrity (survives user/doc deletion)
  user_id         UUID,
  user_email      VARCHAR(255),
  user_name       VARCHAR(200),
  document_id     UUID,
  document_number VARCHAR(50),
  document_name   VARCHAR(500),
  action          audit_action NOT NULL,
  before_state    JSONB,         -- previous values for updates
  after_state     JSONB,         -- new values for updates
  metadata        JSONB,         -- extra context (IP, task_id, version etc.)
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log is append-only: grant INSERT only (no UPDATE/DELETE) for app DB user
CREATE INDEX idx_audit_created_at     ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_user_id        ON audit_logs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_audit_document_id    ON audit_logs(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX idx_audit_action         ON audit_logs(action);
CREATE INDEX idx_audit_user_email     ON audit_logs(user_email) WHERE user_email IS NOT NULL;
-- Trigram search on doc name and user name for admin search
CREATE INDEX idx_audit_doc_name_trgm  ON audit_logs USING gin(document_name gin_trgm_ops) WHERE document_name IS NOT NULL;
CREATE INDEX idx_audit_user_name_trgm ON audit_logs USING gin(user_name gin_trgm_ops) WHERE user_name IS NOT NULL;

-- ============================================================
-- REFRESH TOKENS  (for JWT rotation)
-- ============================================================

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(200) UNIQUE NOT NULL,  -- SHA-256 hash of token
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id    ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at              BEFORE UPDATE ON users              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_group_profiles_updated_at     BEFORE UPDATE ON group_profiles     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_documents_updated_at          BEFORE UPDATE ON documents          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_document_tags_updated_at      BEFORE UPDATE ON document_tags      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_workflow_tasks_updated_at     BEFORE UPDATE ON workflow_tasks     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_document_groups_updated_at    BEFORE UPDATE ON document_groups    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-generate doc_number: DOC-YYYY-NNNN
CREATE OR REPLACE FUNCTION generate_doc_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_year  SMALLINT := EXTRACT(YEAR FROM NOW());
  v_seq   INTEGER;
BEGIN
  INSERT INTO doc_number_seq (year, last_n) VALUES (v_year, 1)
    ON CONFLICT (year) DO UPDATE SET last_n = doc_number_seq.last_n + 1
    RETURNING last_n INTO v_seq;
  NEW.doc_number := 'DOC-' || v_year || '-' || LPAD(v_seq::TEXT, 4, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_documents_doc_number
  BEFORE INSERT ON documents
  FOR EACH ROW
  WHEN (NEW.doc_number IS NULL OR NEW.doc_number = '')
  EXECUTE FUNCTION generate_doc_number();

-- ============================================================
-- DATABASE USERS & PERMISSIONS
-- ============================================================

-- Create application user with minimal privileges
-- (run as superuser during provisioning)
-- CREATE USER wtdoc_app WITH PASSWORD 'strong_app_password';
-- GRANT CONNECT ON DATABASE worktrips_doc TO wtdoc_app;
-- GRANT USAGE ON SCHEMA public TO wtdoc_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wtdoc_app EXCEPT audit_logs;
-- GRANT SELECT, INSERT ON audit_logs TO wtdoc_app;   -- append-only
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wtdoc_app;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO wtdoc_app;

-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON TABLE documents IS 'Core documents table. Soft-deleted via deleted_at.';
COMMENT ON TABLE document_versions IS 'Immutable archive of every document version (pre-signing, each signatory).';
COMMENT ON TABLE audit_logs IS 'Append-only audit trail. App user has INSERT only, no UPDATE/DELETE.';
COMMENT ON TABLE user_group_roles IS 'Maps users to group profiles with access level (read/full).';
COMMENT ON COLUMN documents.signus_envelope_id IS 'Tracking ID from Signus e-signing API.';
COMMENT ON COLUMN group_profiles.has_owner_restriction IS 'When true (Sprzedaz), user can only access documents where they are owner.';
