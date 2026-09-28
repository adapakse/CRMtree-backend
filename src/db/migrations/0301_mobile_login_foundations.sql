-- 0301_mobile_login_foundations.sql
-- Faza 0 aplikacji mobilnej (crmtree-frontend docs/adr/001-mobile-app.md).

-- 1. Email unique within a tenant regardless of case/whitespace (ADR §3).
-- The same email may exist in several tenants (Adam, 2026-09-26), but the
-- existing idx_users_tenant_email is case-sensitive, so "Jan@x.pl" and
-- "jan@x.pl" could both exist in one tenant and a lower(trim(email)) login
-- would then hit two accounts. That old index stays: a seed relies on it
-- via ON CONFLICT (tenant_id, email). Skipped with a warning rather than
-- failing if such pairs already exist, so a deploy never breaks on data —
-- resolve them and create the index by hand.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users GROUP BY tenant_id, lower(trim(email)) HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'idx_users_tenant_email_ci NOT created: users with the same email (case/space-insensitive) in one tenant exist — see ADR 001 section 3';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email_ci
      ON users (tenant_id, lower(trim(email)));
  END IF;
END $$;

-- Mobile login looks accounts up by lower(trim(email)) across all tenants.
CREATE INDEX IF NOT EXISTS idx_users_email_normalized ON users (lower(trim(email)));

-- 2. Device-bound refresh tokens for the mobile app (ADR §4). Web rows keep
-- the old behavior (client = 'web', 7 days, no device).
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS client VARCHAR(10) NOT NULL DEFAULT 'web'
    CHECK (client IN ('web', 'mobile')),
  ADD COLUMN IF NOT EXISTS device_id TEXT,
  ADD COLUMN IF NOT EXISTS device_name TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- A mobile token "family" is one account on one device: reuse of a rotated
-- token revokes the whole family.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_mobile_family
  ON refresh_tokens (user_id, device_id)
  WHERE client = 'mobile';
