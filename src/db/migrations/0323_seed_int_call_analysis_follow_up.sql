-- ============================================================
-- 0323 — INT only: firmy z follow-upem na kazdy dzien (Analiza rozmow)
--
-- Lista "Analiza rozmow" (/admin/call-analysis, GET /api/admin/call-analysis)
-- ma preset "Follow-up date": Dzis / Dzis+Jutro / Nastepne 2 dni / Ten tydzien
-- (parametry follow_up_date_from/_to). W tenancie, w ktorym Panel Testow
-- uruchamia scenariusze (tenant konta wykonania `kstecdesigner@gmail.com`),
-- byla jedna firma z follow-upem (na konkretny dzien), wiec presety "Dzis" i
-- "Dzis+Jutro" byly puste niemal kazdego dnia. Pole follow_up_date zapisuje
-- wylacznie analiza AI (callAnalysisService.js) — zaden endpoint REST go nie
-- ustawia, a aplikacja nie ma mechanizmu odswiezania danych testowych.
--
-- Dlatego seed zaklada po JEDNEJ firmie na KAZDY dzien od poniedzialku
-- biezacego tygodnia przez kolejne ~4 miesiace (c_days_ahead): kazdego dnia z
-- tego horyzontu jest firma z follow-upem na dzis i na jutro, bez codziennej
-- pracy czlowieka. Firmy maja gotowa analize (analysis_status = 'done'), zeby
-- nic nie uruchamialo dla nich analizy AI, i stara date importu, zeby nie
-- zaslanialy prawdziwych firm na gorze domyslnej listy (sort imported_at desc).
--
-- DANE SIE STARZEJA: po ostatnim dniu horyzontu (komunikat NOTICE podaje
-- date) presety znow beda puste — trzeba dodac kolejna migracje z nowym
-- horyzontem albo wdrozyc mechanizm odswiezania (decyzja poza tym seedem).
--
-- Poza INT nic nie robi: pierwszy warunek to nazwa bazy.
--
-- IDEMPOTENTNOSC: firmy demo maja NIP z zarezerwowanej puli 9710000000 –
-- 9710009999 i znacznik "(SEED-INT)" w nazwie. Przy ponownym uruchomieniu
-- kasowane sa wylacznie wiersze spelniajace OBA warunki w tym tenancie; NIP
-- zajety przez cudzy wiersz jest pomijany (ON CONFLICT DO NOTHING).
--
-- Usuniecie (na INT): DELETE FROM call_analysis_companies
--   WHERE nip LIKE '971000%' AND company_name LIKE '%(SEED-INT)%';
-- ============================================================

DO $$
DECLARE
  c_user_id     CONSTANT uuid    := '2a34cb99-2fd5-455c-a232-34094b76da9c';
  c_email       CONSTANT text    := 'kstecdesigner@gmail.com';
  c_nip_prefix  CONSTANT text    := '971000';
  c_marker      CONSTANT text    := '(SEED-INT)';
  c_days_ahead  CONSTANT integer := 120;

  v_tenant_id   uuid;
  v_slug        text;
  v_first_day   date := date_trunc('week', CURRENT_DATE)::date;  -- poniedzialek
  v_last_day    date := CURRENT_DATE + c_days_ahead;
  v_day         date;
  v_n           integer := 0;
  v_inserted    integer := 0;
  v_cnt         integer;

  c_cities CONSTANT text[] := ARRAY['Warszawa','Kraków','Wrocław','Poznań','Gdańsk','Łódź','Katowice','Lublin'];
BEGIN
  IF current_database() <> 'crmtreedb_int' THEN
    RAISE NOTICE '0323: to nie baza INT (%), nic nie zasiewam', current_database();
    RETURN;
  END IF;

  SELECT t.id, t.slug INTO v_tenant_id, v_slug
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id AND t.deleted_at IS NULL
   WHERE u.id = c_user_id AND lower(u.email) = c_email;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE '0323: brak konta wykonania % albo jego tenanta, nic nie zasiewam', c_email;
    RETURN;
  END IF;

  -- ── Czyszczenie poprzedniego przebiegu (tylko wiersze seeda) ─────────────
  DELETE FROM call_analysis_companies
   WHERE tenant_id = v_tenant_id
     AND nip LIKE c_nip_prefix || '%'
     AND company_name LIKE '%' || c_marker;

  -- ── Jedna firma na kazdy dzien horyzontu ─────────────────────────────────
  v_day := v_first_day;
  WHILE v_day <= v_last_day LOOP
    v_n := v_n + 1;
    INSERT INTO call_analysis_companies (
      tenant_id, nip, company_name, city, calls_count,
      first_call_date, last_call_date, last_call_end_date, notes_text,
      score, ai_summary, ai_signals, ai_objections,
      analysis_status, analyzed_at, imported_at, updated_at,
      follow_up_required, follow_up_done, follow_up_date
    ) VALUES (
      v_tenant_id,
      c_nip_prefix || lpad(v_n::text, 4, '0'),
      'Follow-up ' || to_char(v_day, 'YYYY-MM-DD') || ' ' || c_marker,
      c_cities[1 + (v_n % array_length(c_cities, 1))],
      1 + (v_n % 3),
      CURRENT_DATE - 40 - (v_n % 20),
      CURRENT_DATE - 10 - (v_n % 20),
      CURRENT_DATE - 10 - (v_n % 20),
      '[CALL_DATE:' || to_char(CURRENT_DATE - 10 - (v_n % 20), 'YYYY-MM-DD') || '] '
        || 'Rozmowa demonstracyjna — klient prosi o kontakt w dniu '
        || to_char(v_day, 'DD.MM.YYYY') || '.',
      45 + (v_n * 7) % 50,
      'Firma demonstracyjna do testów presetu daty follow-upu. Klient zainteresowany, prosi o ponowny kontakt w uzgodnionym terminie.',
      '["Zainteresowanie ofertą","Uzgodniony termin kolejnego kontaktu"]'::jsonb,
      '["Decyzja po stronie zarządu"]'::jsonb,
      'done',
      NOW() - INTERVAL '30 days',
      NOW() - INTERVAL '200 days',
      NOW(),
      true, false, v_day
    )
    ON CONFLICT (tenant_id, nip) DO NOTHING;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_inserted := v_inserted + v_cnt;
    v_day := v_day + 1;
  END LOOP;

  RAISE NOTICE '0323: tenant % — % firm z follow-upem od % do % (po tej dacie presety Dzis/Dzis+Jutro znow beda puste)',
    v_slug, v_inserted, v_first_day, v_last_day;
END $$;
