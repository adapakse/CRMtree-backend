-- 0298_seo_pillar_slug_and_faq.sql
-- Content quality overhaul (see seoContentService.js header comment):
-- 1. Pillar hub pages need a public URL — slug on seo_content_pillars.
--    Nullable + backfilled lazily in JS (seoStrategyService.getPillars),
--    same self-healing pattern as other lazy-generation columns in this
--    feature. NULLs don't collide under a UNIQUE index, so no backfill
--    step is needed here.
-- 2. FAQPage JSON-LD needs structured Q&A, not the flattened markdown
--    text in `body` — store it alongside body, not instead of it (body
--    keeps rendering FAQ inline for reading UX; this column is schema-only).

ALTER TABLE seo_content_pillars
  ADD COLUMN IF NOT EXISTS slug VARCHAR(160);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_content_pillars_tenant_slug
  ON seo_content_pillars (tenant_id, slug);

ALTER TABLE seo_content_pieces
  ADD COLUMN IF NOT EXISTS faq JSONB;
