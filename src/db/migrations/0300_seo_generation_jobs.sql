-- 0300_seo_generation_jobs.sql
-- "Generuj nowy artykuł" runs in the background. The pipeline takes several
-- minutes (~7.5 min measured 2026-09-25), longer than Azure Container Apps
-- ingress keeps an HTTP request open (~4 min), so a synchronous request
-- showed an error in the panel even when the article was created.
-- One row per manual generation. The panel polls the tenant's latest job.

CREATE TABLE IF NOT EXISTS seo_generation_jobs (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status       VARCHAR(20) NOT NULL DEFAULT 'generating'
                 CHECK (status IN ('generating', 'done', 'failed')),
  content_id   INTEGER REFERENCES seo_content_pieces(id) ON DELETE SET NULL,
  error        TEXT,
  started_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_seo_generation_jobs_tenant ON seo_generation_jobs (tenant_id, created_at DESC);
