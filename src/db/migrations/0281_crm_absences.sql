-- Substitutions during absence.
--
-- A salesperson (or a manager/admin on their behalf) registers an absence window
-- (vacation / sick leave / other) and names a substitute. Days are inclusive:
-- both starts_on and ends_on count (DATE, full days).
--
-- While an absence is active the substitute gets the same access to the absent
-- person's leads and partners as their assigned salesperson — implemented by
-- extending req.crmScopeUserIds in middleware/crm-rbac.js (no parallel permission
-- system). One person can substitute for several people at once.
--
-- Multi-tenant: every row and every query is scoped by tenant_id.

CREATE TABLE IF NOT EXISTS crm_absences (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  absent_user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  substitute_user_id UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on          DATE         NOT NULL,
  ends_on            DATE         NOT NULL,
  reason             VARCHAR(20)  NOT NULL DEFAULT 'other'
                       CHECK (reason IN ('vacation', 'sick_leave', 'other')),
  note               TEXT,
  created_by         UUID         NOT NULL REFERENCES users(id),
  cancelled_at       TIMESTAMPTZ,
  cancelled_by       UUID         REFERENCES users(id),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_absences_date_order CHECK (ends_on >= starts_on),
  CONSTRAINT crm_absences_not_self   CHECK (absent_user_id <> substitute_user_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_absences_tenant
  ON crm_absences (tenant_id);

CREATE INDEX IF NOT EXISTS idx_crm_absences_absent
  ON crm_absences (tenant_id, absent_user_id, starts_on, ends_on)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_crm_absences_substitute
  ON crm_absences (tenant_id, substitute_user_id, starts_on, ends_on)
  WHERE cancelled_at IS NULL;

COMMENT ON TABLE crm_absences IS 'Absence windows with a named substitute. Active (non-cancelled, CURRENT_DATE within window) rows extend the substitute''s CRM scope to the absent person''s records.';
