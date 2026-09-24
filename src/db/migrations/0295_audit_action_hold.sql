-- 0295_audit_action_hold.sql
-- audit_action enum values for the lead Hold feature.
-- Kept separate from 0294 (columns): a newly added enum value cannot be used in
-- the same transaction it was added in, and the runner wraps each file in one tx.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_hold_set';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_lead_hold_cancel';
