-- 0210_seo_wordpress_connector.sql
-- SEObot: WordPress connector for client tenants (CRMtree keeps its own
-- native blog — see routes/public-blog.js — this is only for clients, who
-- publish to their own existing WordPress site instead).
--
-- Auth is WordPress Application Passwords (native since WP 5.6, Basic Auth
-- over HTTPS) — no OAuth app registration needed, unlike LinkedIn/Meta.
--
-- wordpress_publish_mode is a SuperAdmin-only trust decision made after
-- talking to the client (Adam, 2026-07-19) — defaults to 'draft' (safest:
-- nothing goes live on a client's real site without an explicit opt-in).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS wordpress_publish_mode VARCHAR(10) NOT NULL DEFAULT 'draft'
    CHECK (wordpress_publish_mode IN ('draft', 'publish'));

COMMENT ON COLUMN tenants.wordpress_publish_mode IS
  'SuperAdmin-only: whether articles push to WordPress as a live "publish" or a "draft" awaiting manual publish there. Defaults to draft.';

CREATE TABLE IF NOT EXISTS tenant_wordpress_connections (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  site_url      TEXT NOT NULL,
  username      TEXT NOT NULL,
  app_password  TEXT NOT NULL,
  connected_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenant_wordpress_connections_updated_at
  BEFORE UPDATE ON tenant_wordpress_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- WordPress connections live in their own table above (different shape than
-- OAuth: site_url/username/app_password, not access/refresh tokens) — but
-- publish *status* per article reuses seo_social_posts (status/remote_url/
-- error tracking, retry button in the panel — all for free).
ALTER TABLE seo_social_posts DROP CONSTRAINT IF EXISTS seo_social_posts_platform_check;
ALTER TABLE seo_social_posts ADD CONSTRAINT seo_social_posts_platform_check
  CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x', 'wordpress'));
