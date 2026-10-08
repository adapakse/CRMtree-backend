-- ============================================================
-- 0321 — INT only: super admin dla konta wykonania testow Panelu
--
-- Panel Testow uruchamia scenariusze CRMTree na INT jako administrator
-- tenanta `kstecdesigner@gmail.com` (Kacper Stec, konto wykonania roli
-- 'admin' w Panelu). Ekrany /admin/tenants i /admin/billing wymagaja
-- `users.is_super_admin = true` (requireSuperAdmin, middleware/auth.js;
-- superAdminGuard we frontendzie), wiec ich testy konczyly sie przekierowaniem
-- na /dashboard albo 403.
--
-- Nadanie dotyczy WYLACZNIE tego jednego konta: dopasowanie po id ORAZ po
-- adresie e-mail jednoczesnie, zeby literowka w jednym z nich nie trafila w
-- kogos innego. Zadne inne konto nie jest ruszane, role/uprawnienia tenanta
-- (is_admin, crm_role) zostaja bez zmian.
--
-- Skutki uboczne w interfejsie tego konta (swiadome): w menu pojawia sie sekcja
-- Super Admin (Tenanty, Billing), zakladka ICP w Ustawieniach dostaje wybor
-- tenanta i kieruje zadania na /admin/tenants/:id/icp-*, w ustawieniach SEO
-- pojawia sie przelacznik trybu publikacji WordPress.
--
-- Poza INT nic nie robi: pierwszy warunek to nazwa bazy. Idempotentne —
-- ponowne uruchomienie nie zmienia stanu.
--
-- Cofniecie (na INT): UPDATE users SET is_super_admin = false
--   WHERE id = '2a34cb99-2fd5-455c-a232-34094b76da9c';
-- ============================================================

DO $$
DECLARE
  c_user_id  CONSTANT uuid := '2a34cb99-2fd5-455c-a232-34094b76da9c';
  c_email    CONSTANT text := 'kstecdesigner@gmail.com';
  v_updated  integer;
BEGIN
  IF current_database() <> 'crmtreedb_int' THEN
    RAISE NOTICE '0321: to nie baza INT (%), nic nie zmieniam', current_database();
    RETURN;
  END IF;

  UPDATE users
     SET is_super_admin = true,
         updated_at     = NOW()
   WHERE id = c_user_id
     AND lower(email) = c_email
     AND is_super_admin = false;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = c_user_id AND lower(email) = c_email) THEN
      RAISE NOTICE '0321: konto % juz jest super adminem', c_email;
    ELSE
      RAISE NOTICE '0321: nie znaleziono konta % o id % — nic nie zmieniam', c_email, c_user_id;
    END IF;
  ELSE
    RAISE NOTICE '0321: nadano is_super_admin kontu %', c_email;
  END IF;
END $$;
