-- 0308_projects_audit_actions.sql
-- audit_action values for the Projects module. Separate from 0309 — a new
-- enum value cannot be used in the transaction that added it.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_closed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_reopened';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_member_added';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_member_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_member_removed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_task_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_task_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_config_updated';
