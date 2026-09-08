-- Hard DB guarantee: the same person cannot have two overlapping,
-- non-cancelled absence windows within a tenant.
--
-- The application pre-check + 409 response in routes/crm-substitutions.js stay for
-- normal UX, but this constraint is the final barrier against two concurrent
-- POSTs. Date range is inclusive: daterange(..., '[]') — starts_on and ends_on
-- both count.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_absences_no_overlap'
  ) THEN
    ALTER TABLE crm_absences
      ADD CONSTRAINT crm_absences_no_overlap
      EXCLUDE USING gist (
        tenant_id                              WITH =,
        absent_user_id                         WITH =,
        daterange(starts_on, ends_on, '[]')    WITH &&
      )
      WHERE (cancelled_at IS NULL);
  END IF;
END $$;
