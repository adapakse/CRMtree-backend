-- 0282_audit_action_substitution.sql
-- audit_action enum values for the substitutions module.
-- Kept separate from 0281 (table): a newly added enum value cannot be used in the
-- same transaction it was added in, and the runner wraps each file in one tx.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_substitution_create';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_substitution_cancel';
