-- 0118_gmail_calendar_integration.sql
-- Gmail OAuth tokens per user + gmail_thread_id/gmail_message_id na aktywnościach

-- ── 1. Tokeny Gmail per użytkownik (OAuth2) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS user_gmail_tokens (
  user_id       UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT,
  token_type    TEXT        NOT NULL DEFAULT 'Bearer',
  expires_at    TIMESTAMPTZ,
  email         TEXT,
  history_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. Kolumny Gmail na aktywnościach leadów ──────────────────────────────────
ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS gmail_thread_id   TEXT,
  ADD COLUMN IF NOT EXISTS gmail_message_id  TEXT;

-- ── 3. Kolumny Gmail na aktywnościach partnerów ───────────────────────────────
ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS gmail_thread_id   TEXT,
  ADD COLUMN IF NOT EXISTS gmail_message_id  TEXT;

-- ── 4. Indeksy (szybkie wyszukiwanie wątku) ───────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lead_act_gmail_thread
  ON crm_lead_activities (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_act_gmail_thread
  ON crm_partner_activities (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;
