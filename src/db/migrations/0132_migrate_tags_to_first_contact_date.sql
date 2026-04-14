-- 0132_migrate_tags_to_first_contact_date.sql (v3)
-- Migruje wartości z pola tags do first_contact_date.
--
-- Obsługiwane formaty:
--   DD.MM.YYYY  np. "02.12.2025"
--   YYYY-MM-DD  np. "2025-12-04"
--   "styczeń" / "Styczeń"  → 2026-01-01
--   "luty"    / "Luty"     → 2026-02-01
--   "marzec"  / "Marzec"   → 2026-03-01

UPDATE crm_leads
SET
  first_contact_date = (
    SELECT
      CASE
        WHEN t ~ '^\d{2}\.\d{2}\.\d{4}$'        THEN to_date(t, 'DD.MM.YYYY')
        WHEN t ~ '^\d{4}-\d{2}-\d{2}$'           THEN t::date
        WHEN lower(t) IN ('styczeń','styczen')    THEN DATE '2026-01-01'
        WHEN lower(t) = 'luty'                    THEN DATE '2026-02-01'
        WHEN lower(t) = 'marzec'                  THEN DATE '2026-03-01'
        ELSE NULL
      END
    FROM unnest(tags) t
    WHERE t ~ '^\d{2}\.\d{2}\.\d{4}$'
       OR t ~ '^\d{4}-\d{2}-\d{2}$'
       OR lower(t) IN ('styczeń','styczen','luty','marzec')
    LIMIT 1
  ),
  tags = ARRAY(
    SELECT t FROM unnest(tags) t
    WHERE NOT (
      t ~ '^\d{2}\.\d{2}\.\d{4}$'
      OR t ~ '^\d{4}-\d{2}-\d{2}$'
      OR lower(t) IN ('styczeń','styczen','luty','marzec')
    )
  )
WHERE
  first_contact_date IS NULL
  AND EXISTS (
    SELECT 1 FROM unnest(tags) t
    WHERE t ~ '^\d{2}\.\d{2}\.\d{4}$'
       OR t ~ '^\d{4}-\d{2}-\d{2}$'
       OR lower(t) IN ('styczeń','styczen','luty','marzec')
  );

DO $$
DECLARE
  migrated  INTEGER;
  remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO migrated  FROM crm_leads WHERE first_contact_date IS NOT NULL;
  SELECT COUNT(*) INTO remaining FROM crm_leads WHERE first_contact_date IS NULL AND array_length(tags,1) > 0;
  RAISE NOTICE 'Zmigrowano: % rekordów. Leady z tagami bez daty: %', migrated, remaining;
END $$;
