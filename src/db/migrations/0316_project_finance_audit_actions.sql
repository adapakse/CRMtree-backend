-- 0316_project_finance_audit_actions.sql
-- audit_action values for project finance. Separate from 0317 — a new enum
-- value cannot be used in the transaction that added it.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_cost_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_cost_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_cost_deleted';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_revenue_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_revenue_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'project_revenue_deleted';
