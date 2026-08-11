-- 0244_seo_authors.sql
-- Author profiles for SEO articles (E-E-A-T requirement) — per tenant, since
-- each tenant has its own employees/external experts. An author is a
-- reusable entity (the same expert writes many articles), not a free-text
-- field on the article, so it gets its own table rather than columns on
-- seo_content_pieces.

CREATE TABLE IF NOT EXISTS seo_authors (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  full_name    VARCHAR(255) NOT NULL,
  job_title    VARCHAR(255),
  bio          TEXT,
  photo_url    TEXT,
  linkedin_url TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_authors_tenant ON seo_authors (tenant_id) WHERE is_active;

CREATE TRIGGER trg_seo_authors_updated_at
  BEFORE UPDATE ON seo_authors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One author per article (not co-authorship) — nullable because existing
-- rows and freshly generated drafts have none until an editor assigns one;
-- assignment becomes mandatory at the approve step (routes/crm-seo.js), not
-- at the database level, so drafts can still be edited without one.
ALTER TABLE seo_content_pieces
  ADD COLUMN IF NOT EXISTS author_id INTEGER REFERENCES seo_authors(id) ON DELETE SET NULL;
