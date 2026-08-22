-- 0248_prospects_feature_flag.sql
-- Faza 1 (Prospekty): new tenant feature flag.
-- Must be its own migration — Postgres forbids using a new enum value in the
-- same transaction that added it, and migrate.js runs each file as one transaction.

ALTER TYPE crm_feature_type ADD VALUE IF NOT EXISTS 'prospects';
