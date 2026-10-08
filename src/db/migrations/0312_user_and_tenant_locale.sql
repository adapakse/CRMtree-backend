-- 0312_user_and_tenant_locale.sql
-- Interface language. A user picks their own (users.locale); NULL means "use
-- the tenant's default", which the tenant admin sets (tenants.default_locale).
-- Emails and reminders are sent in the recipient's language.
--
-- The list of codes must stay in sync with src/config/locales.js and the
-- frontend's core/i18n/locales.ts.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_locale VARCHAR(5) NOT NULL DEFAULT 'pl'
    CHECK (default_locale IN ('pl', 'en', 'de', 'it', 'es', 'fr', 'ro', 'ru', 'sl', 'hr'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locale VARCHAR(5)
    CHECK (locale IN ('pl', 'en', 'de', 'it', 'es', 'fr', 'ro', 'ru', 'sl', 'hr'));
