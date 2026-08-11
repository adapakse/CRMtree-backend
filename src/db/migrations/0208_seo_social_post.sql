-- 0208_seo_social_post.sql
-- SEObot — Social: auto-generated LinkedIn post copy for each article,
-- produced at publish time. Manual copy-paste only (no direct platform API
-- integration — that needs a registered OAuth app + review per platform,
-- out of scope for now). One column is enough for a single-platform MVP;
-- revisit as a separate table if/when more platforms are added.

ALTER TABLE seo_content_pieces
  ADD COLUMN IF NOT EXISTS social_post_linkedin TEXT;

COMMENT ON COLUMN seo_content_pieces.social_post_linkedin IS
  'Auto-generated LinkedIn post promoting this article, produced when it publishes — see seoSocialService.generateAndSaveSocialPost.';
