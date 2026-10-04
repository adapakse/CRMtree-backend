-- 0311_projects_crm_link_and_reminders.sql
-- Projects inside the CRM:
--   * a project can be linked to a lead (it could already be linked to a
--     partner) — exactly one of the two, or neither;
--   * project tasks get the same reminder columns as CRM activities, so the
--     reminder job (crmReminderService) can serve them as a third source.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_single_crm_link') THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_single_crm_link CHECK (lead_id IS NULL OR partner_id IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_lead    ON projects(lead_id)    WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_partner ON projects(partner_id) WHERE partner_id IS NOT NULL;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(20)
    CHECK (reminder_type IN ('at_due', '1d_before', '2d_before', '3d_before', 'custom')),
  ADD COLUMN IF NOT EXISTS reminder_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN project_tasks.reminder_at IS
  'When the reminder email goes out. For the relative types it is derived from end_date at
   09:00 Europe/Warsaw (a project task has a due date but no due time); for "custom" it is the
   moment the user picked.';

CREATE INDEX IF NOT EXISTS idx_project_tasks_reminder
  ON project_tasks(reminder_at)
  WHERE reminder_sent = FALSE AND reminder_at IS NOT NULL;
