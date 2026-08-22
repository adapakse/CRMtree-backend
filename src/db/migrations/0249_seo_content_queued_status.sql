-- 0249_seo_content_queued_status.sql
-- Adds 'queued' to seo_content_pieces.status — the resting state for an
-- article that has been auto-generated and passed validation but isn't
-- assigned to a calendar day yet (the "unassigned queue" in the SEObot
-- weekly publishing calendar). Distinct from 'in_review', which means
-- "waiting on a human editor" in the existing manual approve flow — a
-- 'queued' article never goes through /content/:id/approve at all, it goes
-- straight to 'scheduled' once the calendar scheduler or a manual drag
-- assigns it a target date (see jobs/seo-calendar-scheduler.js,
-- routes/crm-seo.js PATCH /calendar/content/:id/assign).
--
-- Plain CHECK constraint (not a Postgres ENUM type), so this is a normal
-- drop+recreate within one transaction — no ALTER TYPE ... ADD VALUE
-- restriction to work around (compare 0229_whatsapp_feature_flag.sql, which
-- extends an actual enum type and needs a separate transaction for that
-- reason).

ALTER TABLE seo_content_pieces DROP CONSTRAINT seo_content_pieces_status_check;

ALTER TABLE seo_content_pieces ADD CONSTRAINT seo_content_pieces_status_check
  CHECK (status IN ('draft', 'in_review', 'approved', 'scheduled', 'published', 'needs_update', 'archived', 'queued'));
