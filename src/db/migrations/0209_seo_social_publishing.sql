-- 0209_seo_social_publishing.sql
-- SEObot Social: multi-platform publishing (LinkedIn, Facebook, Instagram —
-- X on hold per Adam, 2026-07-17). Replaces the single social_post_linkedin
-- column (0208) with a proper per-article-per-platform table so one failed
-- platform doesn't hide the success of the other two, and adds per-tenant
-- connected-account storage (mirrors tenant_gsc_tokens).

CREATE TABLE IF NOT EXISTS tenant_social_accounts (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform              VARCHAR(20) NOT NULL CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x')),
  external_account_id   TEXT NOT NULL, -- LinkedIn org URN / FB page ID / IG business account ID
  account_name          TEXT,          -- display name shown in the panel
  access_token          TEXT NOT NULL,
  refresh_token         TEXT,
  token_expires_at      TIMESTAMPTZ,
  connected_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform)
);

CREATE TRIGGER trg_tenant_social_accounts_updated_at
  BEFORE UPDATE ON tenant_social_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS seo_social_posts (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content_id      INTEGER NOT NULL REFERENCES seo_content_pieces(id) ON DELETE CASCADE,
  platform        VARCHAR(20) NOT NULL CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x')),
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'published', 'failed')),
  body            TEXT,
  remote_post_id  TEXT,
  remote_url      TEXT,
  error_message   TEXT,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_seo_social_posts_content ON seo_social_posts (content_id);
CREATE INDEX IF NOT EXISTS idx_seo_social_posts_tenant  ON seo_social_posts (tenant_id, status);

CREATE TRIGGER trg_seo_social_posts_updated_at
  BEFORE UPDATE ON seo_social_posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Carry over whatever LinkedIn copy already exists as a draft, then retire the column.
INSERT INTO seo_social_posts (tenant_id, content_id, platform, status, body)
SELECT tenant_id, id, 'linkedin', 'draft', social_post_linkedin
  FROM seo_content_pieces
 WHERE social_post_linkedin IS NOT NULL
ON CONFLICT (content_id, platform) DO NOTHING;

ALTER TABLE seo_content_pieces DROP COLUMN IF EXISTS social_post_linkedin;
