-- 0299_seo_content_refresh.sql
-- Metrics-driven content refresh (seoRefreshService). Being queued for a
-- refresh is now separate from the publish status: a queued article stays
-- 'published' and live, and a proposed revision is staged in refresh_draft
-- until an editor applies it.
--
-- Before this, jobs/seo-content-refresh.js set 90-day-old articles to
-- status='needs_update', which silently took them off crmtree.pl, out of
-- the sitemap and to a 404 — the first two production articles were due to
-- be pulled on 2026-10-11.

ALTER TABLE seo_content_pieces
  ADD COLUMN IF NOT EXISTS refresh_reason VARCHAR(30)
    CHECK (refresh_reason IN ('striking_distance', 'position_drop', 'age', 'manual')),
  ADD COLUMN IF NOT EXISTS refresh_requested_at TIMESTAMPTZ,
  -- GSC numbers that triggered the flag, shown to the editor as the "why".
  ADD COLUMN IF NOT EXISTS refresh_signal JSONB,
  ADD COLUMN IF NOT EXISTS refresh_status VARCHAR(20)
    CHECK (refresh_status IN ('generating', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS refresh_draft JSONB,
  ADD COLUMN IF NOT EXISTS refresh_error TEXT,
  -- Only set when a refresh is actually applied, so it doubles as the public
  -- dateModified. updated_at can't serve that purpose: internal flag changes
  -- bump it too.
  ADD COLUMN IF NOT EXISTS last_refreshed_at TIMESTAMPTZ,
  -- "Reviewed, nothing to change": restarts the cooldown without claiming a
  -- content update publicly.
  ADD COLUMN IF NOT EXISTS refresh_dismissed_at TIMESTAMPTZ;

-- Put back online anything the old job already pulled, keeping it queued.
-- published_at IS NOT NULL singles those out: new drafts that failed
-- automatic validation are also 'needs_update' but were never published.
UPDATE seo_content_pieces
   SET status = 'published', refresh_reason = 'age', refresh_requested_at = now()
 WHERE status = 'needs_update' AND published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seo_content_refresh_queue
  ON seo_content_pieces (tenant_id, refresh_requested_at)
  WHERE refresh_reason IS NOT NULL;
