-- 0201_seo_content_support_tables.sql
-- Faza 1 (SEObot): keyword research, competitor research, internal linking,
-- gated cross-tenant backlinks, and GSC performance tracking.

CREATE TABLE IF NOT EXISTS seo_keywords (
  id          SERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phrase      VARCHAR(255) NOT NULL,
  source      VARCHAR(10) NOT NULL DEFAULT 'llm' CHECK (source IN ('llm', 'gsc')),
  content_id  INTEGER REFERENCES seo_content_pieces(id) ON DELETE SET NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_keywords_tenant ON seo_keywords (tenant_id);

CREATE TABLE IF NOT EXISTS seo_competitors (
  id          SERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_competitors_tenant ON seo_competitors (tenant_id);

-- Internal linking: suggested by the engine, always reviewed before going live (Faza 1 §6).
CREATE TABLE IF NOT EXISTS seo_internal_links (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_content_id INTEGER NOT NULL REFERENCES seo_content_pieces(id) ON DELETE CASCADE,
  to_content_id   INTEGER NOT NULL REFERENCES seo_content_pieces(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_content_id <> to_content_id)
);
CREATE INDEX IF NOT EXISTS idx_seo_internal_links_tenant ON seo_internal_links (tenant_id, status);

-- Cross-tenant backlinks: opt-in, vertical-gated, capped — see requirements doc §7 safeguards.
-- tenant_id/partner_tenant_id are directional (tenant_id's content links TO partner's content).
CREATE TABLE IF NOT EXISTS seo_backlinks (
  id                SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  partner_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_content_id   INTEGER NOT NULL REFERENCES seo_content_pieces(id) ON DELETE CASCADE,
  to_content_id     INTEGER NOT NULL REFERENCES seo_content_pieces(id) ON DELETE CASCADE,
  status            VARCHAR(20) NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tenant_id <> partner_tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_seo_backlinks_tenant  ON seo_backlinks (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_backlinks_partner ON seo_backlinks (partner_tenant_id);

CREATE TABLE IF NOT EXISTS seo_metrics (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content_id    INTEGER NOT NULL REFERENCES seo_content_pieces(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  impressions   INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  avg_position  NUMERIC(5,2),
  UNIQUE (content_id, date)
);
CREATE INDEX IF NOT EXISTS idx_seo_metrics_tenant ON seo_metrics (tenant_id, date);

-- Google Search Console OAuth tokens — one connection per tenant (mirrors the
-- existing per-user Gmail token pattern in user_gmail_tokens, but GSC property
-- ownership belongs to the business/domain, not an individual user).
CREATE TABLE IF NOT EXISTS tenant_gsc_tokens (
  tenant_id      UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  site_url       TEXT NOT NULL,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  token_expiry   TIMESTAMPTZ,
  connected_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenant_gsc_tokens_updated_at
  BEFORE UPDATE ON tenant_gsc_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
