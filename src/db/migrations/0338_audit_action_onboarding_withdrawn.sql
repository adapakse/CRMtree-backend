-- 0338_audit_action_onboarding_withdrawn.sql
-- audit_action value for withdrawing a Partner from onboarding back to a
-- sales-funnel stage. Separate file — a new enum value cannot be used in the
-- transaction that added it.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'crm_partner_onboarding_withdrawn';
