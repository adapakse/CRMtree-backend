-- 0297_audit_action_archive.sql
-- audit_action enum value for the lead Archive action.
-- Kept separate from 0296 (columns) for the same reason as 0295.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_archived';
