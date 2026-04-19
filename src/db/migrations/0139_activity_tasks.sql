-- 0139_activity_tasks.sql
-- Adds task management fields to CRM activities:
--   status (new/open/closed), close_comment, assigned_to
-- Makes activity_at nullable so non-meeting activities can be unscheduled.
-- Adds audit action types for activity lifecycle.

-- ── crm_lead_activities ───────────────────────────────────────────────────────
ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS status       VARCHAR(20) NOT NULL DEFAULT 'new'
                            CHECK (status IN ('new','open','closed')),
  ADD COLUMN IF NOT EXISTS close_comment TEXT,
  ADD COLUMN IF NOT EXISTS assigned_to  UUID REFERENCES users(id) ON DELETE SET NULL;

-- Remove NOT NULL constraint so activities can have no scheduled time
ALTER TABLE crm_lead_activities
  ALTER COLUMN activity_at DROP NOT NULL,
  ALTER COLUMN activity_at DROP DEFAULT;

-- Null out activity_at for non-meeting activities (was auto-set to NOW() at
-- creation, not user-supplied — would pollute calendar with noise)
UPDATE crm_lead_activities
   SET activity_at = NULL
 WHERE type NOT IN ('meeting');

-- ── crm_partner_activities ────────────────────────────────────────────────────
ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS status       VARCHAR(20) NOT NULL DEFAULT 'new'
                            CHECK (status IN ('new','open','closed')),
  ADD COLUMN IF NOT EXISTS close_comment TEXT,
  ADD COLUMN IF NOT EXISTS assigned_to  UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE crm_partner_activities
  ALTER COLUMN activity_at DROP NOT NULL,
  ALTER COLUMN activity_at DROP DEFAULT;

UPDATE crm_partner_activities
   SET activity_at = NULL
 WHERE type NOT IN ('meeting');

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lead_act_assigned_to  ON crm_lead_activities(assigned_to);
CREATE INDEX IF NOT EXISTS idx_lead_act_status       ON crm_lead_activities(status);
CREATE INDEX IF NOT EXISTS idx_lead_act_activity_at  ON crm_lead_activities(activity_at);
CREATE INDEX IF NOT EXISTS idx_part_act_assigned_to  ON crm_partner_activities(assigned_to);
CREATE INDEX IF NOT EXISTS idx_part_act_status       ON crm_partner_activities(status);
CREATE INDEX IF NOT EXISTS idx_part_act_activity_at  ON crm_partner_activities(activity_at);

-- ── Audit action types ────────────────────────────────────────────────────────
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_activity_create';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_activity_update';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_activity_close';
