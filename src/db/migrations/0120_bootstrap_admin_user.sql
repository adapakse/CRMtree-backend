-- 0120_bootstrap_admin_user.sql
-- Tworzy konto administratora przed pierwszym wdrożeniem produkcyjnym.
-- Po zalogowaniu przez Google SSO (SAML) rekord zostanie zaktualizowany
-- o saml_subject i last_login_at automatycznie.
--
-- Uruchom JEDNORAZOWO przed wdrożeniem na produkcję:
--   node src/db/migrate.js

INSERT INTO users (email, first_name, last_name, is_admin, is_active)
VALUES ('adam.manka@worktrips.com', 'Adam', 'Manka', TRUE, TRUE)
ON CONFLICT (email) DO UPDATE
  SET is_admin  = TRUE,
      is_active = TRUE,
      updated_at = NOW();
