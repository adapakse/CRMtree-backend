-- 0330_user_feature_access.sql
-- Uprawnienie do modułu nadawane POJEDYNCZEJ OSOBIE, obok flagi modułu na tenancie.
--
-- Dotychczas o dostępie do Analizatora rozmów decydowała wyłącznie flaga
-- `tenant_features` ustawiana przez superadmina — po jej włączeniu moduł widział
-- KAŻDY użytkownik tenanta i admin tenanta nie miał jak tego zawęzić. Port
-- mechanizmu z worktrips-doc (tam `user_feature_access`, migracja 0227), który
-- przy forku nie został przeniesiony, mimo że nazwa `requireFeature` została ta
-- sama — stąd wrażenie, że uprawnienia działają.
--
-- Dwie bramki działają łącznie: najpierw moduł musi być włączony tenantowi,
-- potem osoba musi mieć grant. Admin tenanta ma dostęp zawsze, bez wiersza.

CREATE TABLE IF NOT EXISTS user_feature_access (
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  feature_name VARCHAR(64) NOT NULL,
  granted      BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_by   UUID        REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, feature_name)
);

CREATE INDEX IF NOT EXISTS idx_ufa_tenant_feature
  ON user_feature_access (tenant_id, feature_name);

-- Backfill: nikt nie może stracić dostępu w dniu wdrożenia.
-- Każdy aktywny użytkownik tenanta, który MA dziś włączony moduł, dostaje grant
-- — czyli zachowuje stan sprzed zmiany. Od tej chwili admin tenanta odbiera go
-- komu chce. Tenant z wyłączonym modułem nie dostaje nic: i tak nie wchodzi.
INSERT INTO user_feature_access (tenant_id, user_id, feature_name, granted, granted_at)
SELECT u.tenant_id, u.id, 'call_analysis', TRUE, NOW()
  FROM users u
  JOIN tenant_features f ON f.tenant_id = u.tenant_id
                        AND f.feature   = 'call_analysis'
                        AND f.is_enabled = TRUE
 WHERE u.is_active = TRUE
ON CONFLICT (user_id, feature_name) DO NOTHING;
