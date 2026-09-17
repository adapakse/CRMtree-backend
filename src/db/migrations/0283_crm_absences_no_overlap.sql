-- Hard DB guarantee: ta sama osoba nie może mieć dwóch nakładających się,
-- nieodwołanych okien nieobecności w obrębie tenanta.
--
-- Wariant trigger — NIE EXCLUDE USING gist, bo btree_gist nie jest domyślnie
-- dozwolony na Azure Database for PostgreSQL (brak w azure.extensions), przez co
-- migracja wywalała deploy na INT. Efekt ten sam: równoległe POST-y wpadają na
-- wyjątek z SQLSTATE 23P01, który routes/crm-substitutions.js mapuje na 409.
-- Pre-check w routzie zostaje dla zwykłego UX.
--
-- Uwaga: BEFORE trigger + EXISTS ma teoretyczny wyścig przy dwóch równoległych
-- INSERT-ach tej samej osoby. Dla tej domeny (rejestracja własnej nieobecności,
-- znikoma współbieżność, dodatkowo pre-check w aplikacji) to akceptowalne.

CREATE OR REPLACE FUNCTION crm_absences_no_overlap_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.cancelled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crm_absences a
    WHERE a.tenant_id      = NEW.tenant_id
      AND a.absent_user_id = NEW.absent_user_id
      AND a.id            <> NEW.id
      AND a.cancelled_at IS NULL
      AND a.starts_on <= NEW.ends_on
      AND a.ends_on   >= NEW.starts_on
  ) THEN
    RAISE EXCEPTION
      'Nakładające się okno nieobecności dla użytkownika % w tenancie %',
      NEW.absent_user_id, NEW.tenant_id
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_absences_no_overlap ON crm_absences;
CREATE TRIGGER trg_crm_absences_no_overlap
  BEFORE INSERT OR UPDATE ON crm_absences
  FOR EACH ROW
  EXECUTE FUNCTION crm_absences_no_overlap_check();

-- Sprzątanie: jeśli gdzieś (np. lokalny dev na czystym Postgresie) powstał już
-- wariant EXCLUDE USING gist — trigger go zastępuje.
ALTER TABLE crm_absences DROP CONSTRAINT IF EXISTS crm_absences_no_overlap;
