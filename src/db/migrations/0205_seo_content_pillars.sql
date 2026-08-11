-- 0205_seo_content_pillars.sql
-- Faza 1 (SEObot): content strategy map, built from the tenant's own business
-- description (mirrors AutoSEO's "Content Strategy Mindmap" — pillars with
-- supporting topics — but generated up front from onboarding input rather
-- than rendered after the fact from whatever articles happen to exist).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_description TEXT;

COMMENT ON COLUMN tenants.business_description IS
  'Free-text business description captured at onboarding (Faza 2b) or set manually (Faza 1 dogfooding) — the seed input for seo_content_pillars generation.';

CREATE TABLE IF NOT EXISTS seo_content_pillars (
  id                SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              VARCHAR(150) NOT NULL,
  description       TEXT NOT NULL,
  target_keyword_theme VARCHAR(255) NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_content_pillars_tenant ON seo_content_pillars (tenant_id, priority);

ALTER TABLE seo_keywords
  ADD COLUMN IF NOT EXISTS pillar_id INTEGER REFERENCES seo_content_pillars(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_seo_keywords_pillar ON seo_keywords (pillar_id);

-- Basic per-article cost visibility (nonfunctional requirement §"Kontrola kosztów").
ALTER TABLE seo_content_pieces
  ADD COLUMN IF NOT EXISTS generation_cost_usd NUMERIC(8,4);

-- Seed CRMtree's own business description — no onboarding wizard exists yet
-- (that's Faza 2b), so the dogfooding tenant is set by hand.
UPDATE tenants
   SET business_description =
     'CRMtree to generyczny system CRM dla przedsiębiorstw z różnych branż (nie tylko turystyki), '
     || 'skupiony na dynamicznej pracy handlowców oraz zarządzaniu lejkiem sprzedażowym, upsellem i cross-sellem. '
     || 'Odbiorcy: menedżerowie sprzedaży, właściciele firm, zespoły handlowe szukające narzędzia do zarządzania '
     || 'leadami, partnerami/klientami, zadaniami i raportowaniem sprzedaży.'
 WHERE id = '4a299a1b-9e33-43d7-b649-ead5a17d61fc'
   AND business_description IS NULL;
