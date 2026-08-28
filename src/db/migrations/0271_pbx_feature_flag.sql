-- 0271_pbx_feature_flag.sql
-- Tenant-level module toggle for softphone/PBX telephony — separate migration,
-- since Postgres forbids using a new enum value in the same transaction that
-- added it, and migrate.js runs each file as one transaction.

ALTER TYPE crm_feature_type ADD VALUE IF NOT EXISTS 'pbx';
