-- 0248_seo_calendar_config.sql
-- Per-tenant weekly auto-publishing calendar config for SEObot — a tenant's
-- SEO group defines how many articles auto-publish on each weekday and an
-- optional campaign end date; the SEO calendar scheduler job
-- (jobs/seo-calendar-scheduler.js) reads this to fill upcoming weeks.
-- Dedicated typed columns per weekday (not JSONB) to match the existing
-- convention for module-owned tenant settings (tenants.industry_vertical,
-- tenants.seo_daily_article_limit) and to get free CHECK validation.
--
-- last_filled_week_start / last_author_id are scheduler-owned cursors (which
-- week has already been auto-filled, and where the round-robin author
-- rotation left off) — not user-facing config, but they live here since
-- they're 1:1 with the tenant and the scheduler already reads/writes this
-- row on every run.

CREATE TABLE IF NOT EXISTS tenant_seo_calendar_config (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  is_enabled             BOOLEAN NOT NULL DEFAULT false,
  monday_count           SMALLINT NOT NULL DEFAULT 0 CHECK (monday_count >= 0),
  tuesday_count          SMALLINT NOT NULL DEFAULT 0 CHECK (tuesday_count >= 0),
  wednesday_count        SMALLINT NOT NULL DEFAULT 0 CHECK (wednesday_count >= 0),
  thursday_count         SMALLINT NOT NULL DEFAULT 0 CHECK (thursday_count >= 0),
  friday_count           SMALLINT NOT NULL DEFAULT 0 CHECK (friday_count >= 0),
  saturday_count         SMALLINT NOT NULL DEFAULT 0 CHECK (saturday_count >= 0),
  sunday_count           SMALLINT NOT NULL DEFAULT 0 CHECK (sunday_count >= 0),
  end_date               DATE,
  last_filled_week_start DATE,
  last_author_id         INTEGER REFERENCES seo_authors(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenant_seo_calendar_config_updated_at
  BEFORE UPDATE ON tenant_seo_calendar_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
