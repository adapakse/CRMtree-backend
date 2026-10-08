-- ============================================================
-- 0315 — push notification tokens of the mobile app (ADR 001)
--
-- One row per phone a user is signed in on: the token Firebase gave that
-- installation. The app registers it after sign-in and whenever Firebase
-- rotates it; signing out — in the app or from "My devices" on the web —
-- removes it, so a phone that left the company stops getting notifications.
-- ============================================================

CREATE TABLE IF NOT EXISTS mobile_push_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The same id the phone sends at mobile login (refresh_tokens.device_id).
  device_id   TEXT        NOT NULL,
  token       TEXT        NOT NULL,
  platform    VARCHAR(10) NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

-- A token names one installation: when another account signs in on the same
-- phone, the token moves to it instead of notifying both.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_push_tokens_token ON mobile_push_tokens(token);
CREATE INDEX IF NOT EXISTS idx_mobile_push_tokens_user ON mobile_push_tokens(user_id);
