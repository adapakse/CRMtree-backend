-- 0307_projects_feature_flag.sql
-- Tenant-level module toggle for the Projects module. Separate migration:
-- Postgres forbids using a new enum value in the transaction that added it,
-- and migrate.js runs each file as one transaction.

ALTER TYPE crm_feature_type ADD VALUE IF NOT EXISTS 'projects';
