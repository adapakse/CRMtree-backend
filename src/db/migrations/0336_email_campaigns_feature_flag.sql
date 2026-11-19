-- 0336_email_campaigns_feature_flag.sql
-- Tenant-level module toggle for e-mail campaigns (SendGrid). Separate migration:
-- Postgres forbids using a new enum value in the transaction that added it,
-- and migrate.js runs each file as one transaction.

ALTER TYPE crm_feature_type ADD VALUE IF NOT EXISTS 'email_campaigns';
